/**
 * V2 4-player tournament — 2 rounds, bracket advancement, champion.
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
	ws: WebSocket; messages: any[];
	waitFor: (type: string, timeout?: number) => Promise<any>;
	send: (msg: any) => void; close: () => void;
}> {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		const messages: any[] = [];
		const waiters: any[] = [];
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

async function playMatch(port: number, matchId: string, playerA: string, playerB: string) {
	const pA = await wsConnect(port, playerA);
	const pB = await wsConnect(port, playerB);
	await sleep(100);

	pA.send({ type: 'match-ready', matchId });
	pB.send({ type: 'match-ready', matchId });
	await pA.waitFor('match-start');
	await pB.waitFor('match-start');

	pA.send({ type: 'input', matchId, tick: 10, payload: btoa('up') });
	await sleep(100);

	pA.send({ type: 'match-done', matchId });
	pB.send({ type: 'match-done', matchId });
	const result = await pA.waitFor('match-end');

	pA.close();
	pB.close();
	return result;
}

runTest('v2: 4-player tournament — 2 rounds, bracket advancement', async () => {
	const server = await startServer();
	try {
		await api(server, '/api/tournaments', {
			method: 'POST', asAdmin: true, body: { id: '4p', name: '4P Test' },
		});
		for (const p of ['alice', 'bob', 'charlie', 'dave']) {
			await api(server, '/api/tournaments/4p/register', {
				method: 'POST', body: { nametag: p }, asNametag: p,
			});
		}
		await api(server, '/api/tournaments/4p/start', { method: 'POST', asAdmin: true });

		// Round 0: play both matches
		let bracket = await api(server, '/api/tournaments/4p/bracket');
		assertEqual(bracket.tournament.current_round, 0);
		const r0 = bracket.matches.filter((m: any) => m.round === 0 && m.status === 'ready_wait');
		assertEqual(r0.length, 2, 'two round-0 matches');

		for (const m of r0) {
			await playMatch(server.port, m.id, m.playerA, m.playerB);
		}

		// Wait for round advancement
		await sleep(1200);
		bracket = await api(server, '/api/tournaments/4p/bracket');
		assertEqual(bracket.tournament.current_round, 1, 'advanced to round 1');

		// Round 1: final
		const final = bracket.matches.find((m: any) => m.round === 1);
		assert(final, 'should have final');
		assertEqual(final.status, 'ready_wait', 'final is ready_wait');
		assert(final.playerA, 'final has playerA');
		assert(final.playerB, 'final has playerB');

		await playMatch(server.port, final.id, final.playerA, final.playerB);

		await sleep(1200);
		bracket = await api(server, '/api/tournaments/4p/bracket');
		assertEqual(bracket.tournament.status, 'complete', 'tournament complete');

		// Verify all round-0 matches have winners
		const completedR0 = bracket.matches.filter((m: any) => m.round === 0);
		for (const m of completedR0) {
			assertEqual(m.status, 'complete');
			assert(m.winner, `match ${m.id} has winner`);
			assert(m.scoreA !== null, `match ${m.id} has scoreA`);
		}

		// Final should be complete with winner
		const completedFinal = bracket.matches.find((m: any) => m.round === 1);
		assertEqual(completedFinal.status, 'complete');
		assert(completedFinal.winner, 'final has champion');

	} finally {
		await stopServer(server.proc);
	}
});
