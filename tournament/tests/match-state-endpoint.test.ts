/**
 * GET /api/tournaments/:tid/matches/:round/:slot/state
 *
 * Covers every match phase so clients can poll this endpoint to
 * self-heal from missed WS pushes.
 */

import WebSocket from 'ws';
import {
	api,
	assert,
	assertEqual,
	runTest,
	sleep,
	startServer,
	stopServer,
	mintSession,
} from './harness';

function wsConnect(port: number, nametag: string): Promise<{
	ws: WebSocket;
	messages: any[];
	waitFor: (type: string, timeout?: number) => Promise<any>;
	send: (msg: any) => void;
	close: () => void;
}> {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		const messages: any[] = [];
		const waiters: { type: string; resolve: (v: any) => void; timer: NodeJS.Timeout }[] = [];
		ws.on('message', (raw) => {
			const msg = JSON.parse(raw.toString());
			messages.push(msg);
			for (let i = 0; i < waiters.length; i++) {
				if (waiters[i].type === msg.type) {
					clearTimeout(waiters[i].timer);
					waiters[i].resolve(msg);
					waiters.splice(i, 1);
					break;
				}
			}
		});
		ws.on('open', async () => {
			const sessionId = await mintSession({ port }, nametag);
			ws.send(JSON.stringify({ type: 'register', identity: { nametag }, sessionId }));
			resolve({
				ws, messages,
				waitFor(type, timeout = 5000) {
					for (const m of messages) if (m.type === type) return Promise.resolve(m);
					return new Promise((res, rej) => {
						const timer = setTimeout(() => rej(new Error(`timeout: ${type}`)), timeout);
						waiters.push({ type, resolve: res, timer });
					});
				},
				send(msg) { ws.send(JSON.stringify(msg)); },
				close() { ws.close(); },
			});
		});
	});
}

runTest('match-state endpoint reports all phases correctly', async () => {
	const server = await startServer();
	try {
		// ── Create 2-player tournament + start ──
		await api(server, '/api/tournaments', {
			method: 'POST', asAdmin: true,
			body: { id: 'ms-1', name: 'Match-State Test', maxPlayers: 2 },
		});
		await api(server, '/api/tournaments/ms-1/register', {
			method: 'POST', body: { nametag: 'alice' }, asNametag: 'alice',
		});
		await api(server, '/api/tournaments/ms-1/register', {
			method: 'POST', body: { nametag: 'bob' }, asNametag: 'bob',
		});
		await api(server, '/api/tournaments/ms-1/start', {
			method: 'POST', asAdmin: true,
		});

		// ── Phase: ready_wait, no one ready yet ──
		const s1 = await api(server, '/api/tournaments/ms-1/matches/0/0/state');
		assertEqual(s1.matchId, 'ms-1/R0M0');
		assertEqual(s1.phase, 'ready_wait');
		// Bracket seeding may assign either player to side A; just verify both present
		const participants = new Set([s1.playerA, s1.playerB]);
		assert(participants.has('alice') && participants.has('bob'),
			`expected alice+bob, got ${s1.playerA} vs ${s1.playerB}`);
		const aliceSide: 'A' | 'B' = s1.playerA === 'alice' ? 'A' : 'B';
		const bobSide: 'A' | 'B' = aliceSide === 'A' ? 'B' : 'A';
		// ready field: should exist only once sides are registered — which happens
		// on first handleReady. Before then, expect null or {A:false,B:false}.
		assert(s1.ready === null || (s1.ready.A === false && s1.ready.B === false),
			`expected empty ready, got ${JSON.stringify(s1.ready)}`);
		assert(!s1.winner, 'no winner yet');
		assert(!s1.done || (s1.done.A === false && s1.done.B === false), 'no done yet');

		// ── 404 for bogus match ──
		const notFound = await api(server, '/api/tournaments/ms-1/matches/99/99/state',
			{ allowError: true });
		assert(notFound.error, 'should 404');

		// ── Phase: ready_wait, one player ready ──
		const alice = await wsConnect(server.port, 'alice');
		const bob = await wsConnect(server.port, 'bob');
		await sleep(100);
		alice.send({ type: 'match-ready', matchId: 'ms-1/R0M0' });
		await alice.waitFor('match-status');

		const s2 = await api(server, '/api/tournaments/ms-1/matches/0/0/state');
		assertEqual(s2.phase, 'ready_wait');
		assert(s2.ready, 'ready flags present once a ready arrived');
		assertEqual(s2.ready[aliceSide], true, 'alice is ready');
		assertEqual(s2.ready[bobSide], false, 'bob is NOT ready');
		assertEqual(s2.online[aliceSide], true, 'alice online');
		assertEqual(s2.online[bobSide], true, 'bob online');

		// ── Phase: active (both ready → match starts) ──
		bob.send({ type: 'match-ready', matchId: 'ms-1/R0M0' });
		await alice.waitFor('match-start');
		await bob.waitFor('match-start');

		const s3 = await api(server, '/api/tournaments/ms-1/matches/0/0/state');
		assertEqual(s3.phase, 'active');
		assert(s3.seed, 'seed present for active match');
		// done flags should exist (even if false) once the match is active
		assert(s3.done, 'done flags present');
		assertEqual(s3.done.A, false);
		assertEqual(s3.done.B, false);

		// ── Phase: active, one side done ──
		alice.send({ type: 'match-done', matchId: 'ms-1/R0M0' });
		await sleep(100);
		const s4 = await api(server, '/api/tournaments/ms-1/matches/0/0/state');
		assertEqual(s4.phase, 'active');
		assertEqual(s4.done[aliceSide], true, 'alice done');
		assertEqual(s4.done[bobSide], false, 'bob not done');

		// ── Phase: complete (both done → replay → resolve) ──
		bob.send({ type: 'match-done', matchId: 'ms-1/R0M0' });
		await alice.waitFor('match-end');

		const s5 = await api(server, '/api/tournaments/ms-1/matches/0/0/state');
		assertEqual(s5.phase, 'complete');
		assert(s5.winner, 'winner set');
		assert(s5.scoreA !== null, 'scoreA set');
		assert(s5.scoreB !== null, 'scoreB set');

		alice.close();
		bob.close();

		// ── Series tournament: check series state ──
		await api(server, '/api/tournaments', {
			method: 'POST', asAdmin: true,
			body: { id: 'ms-2', name: 'Series', maxPlayers: 2, bestOf: 3 },
		});
		await api(server, '/api/tournaments/ms-2/register', {
			method: 'POST', body: { nametag: 'carol' }, asNametag: 'carol',
		});
		await api(server, '/api/tournaments/ms-2/register', {
			method: 'POST', body: { nametag: 'dave' }, asNametag: 'dave',
		});
		await api(server, '/api/tournaments/ms-2/start', {
			method: 'POST', asAdmin: true,
		});

		const carol = await wsConnect(server.port, 'carol');
		const dave = await wsConnect(server.port, 'dave');
		await sleep(100);
		carol.send({ type: 'match-ready', matchId: 'ms-2/R0M0' });
		dave.send({ type: 'match-ready', matchId: 'ms-2/R0M0' });
		await carol.waitFor('match-start');
		await dave.waitFor('match-start');

		const sSeries = await api(server, '/api/tournaments/ms-2/matches/0/0/state');
		assertEqual(sSeries.phase, 'active');
		assertEqual(sSeries.bestOf, 3);
		assert(sSeries.series, 'series state populated for bestOf>1');
		assertEqual(sSeries.series.bestOf, 3);
		assertEqual(sSeries.series.winsA, 0);
		assertEqual(sSeries.series.winsB, 0);
		assertEqual(sSeries.series.currentGame, 1);

		carol.close();
		dave.close();
	} finally {
		await stopServer(server.proc);
	}
});
