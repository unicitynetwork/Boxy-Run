/**
 * V2 Match flow — full end-to-end: create tournament, register,
 * start, both players ready via WebSocket, exchange inputs,
 * both send done, server replays, match-end received, bracket
 * updates.
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
						const timer = setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), timeout);
						waiters.push({ type, resolve: res, timer });
					});
				},
				send(msg) { ws.send(JSON.stringify(msg)); },
				close() { ws.close(); },
			});
		});
	});
}

runTest('v2: full 2-player match — ready, play, done, result', async () => {
	const server = await startServer();
	try {
		// Create + register + start
		await api(server, '/api/tournaments', {
			method: 'POST', asAdmin: true, body: { id: 'match-test', name: 'Match Test' },
		});
		await api(server, '/api/tournaments/match-test/register', {
			method: 'POST', body: { nametag: 'alice' }, asNametag: 'alice',
		});
		await api(server, '/api/tournaments/match-test/register', {
			method: 'POST', body: { nametag: 'bob' }, asNametag: 'bob',
		});
		await api(server, '/api/tournaments/match-test/start', {
			method: 'POST', asAdmin: true,
		});

		// Get the match ID
		const bracket = await api(server, '/api/tournaments/match-test/bracket');
		const match = bracket.matches.find((m: any) => m.round === 0 && m.status === 'ready_wait');
		assert(match, 'should have a ready_wait match');
		const matchId = match.id;

		// Connect both players via WebSocket
		const alice = await wsConnect(server.port, 'alice');
		const bob = await wsConnect(server.port, 'bob');
		await sleep(200);

		// Both click ready
		alice.send({ type: 'match-ready', matchId });
		const aliceStatus = await alice.waitFor('match-status');
		assert(aliceStatus, 'alice gets match-status');

		bob.send({ type: 'match-ready', matchId });

		// Both should get match-start
		const aliceStart = await alice.waitFor('match-start');
		const bobStart = await bob.waitFor('match-start');
		assertEqual(aliceStart.matchId, matchId);
		assertEqual(bobStart.matchId, matchId);
		assertEqual(aliceStart.seed, bobStart.seed, 'same seed');
		const sides = new Set([aliceStart.youAre, bobStart.youAre]);
		assertEqual([...sides].sort(), ['A', 'B'], 'complementary sides');

		// Exchange inputs
		alice.send({ type: 'input', matchId, tick: 10, payload: btoa('up') });
		alice.send({ type: 'input', matchId, tick: 20, payload: btoa('left') });
		bob.send({ type: 'input', matchId, tick: 15, payload: btoa('right') });
		await sleep(200);

		// Verify opponent-input received
		const aliceOppInputs = alice.messages.filter(m => m.type === 'opponent-input');
		const bobOppInputs = bob.messages.filter(m => m.type === 'opponent-input');
		assert(aliceOppInputs.length >= 1, `alice got opponent inputs: ${aliceOppInputs.length}`);
		assert(bobOppInputs.length >= 2, `bob got opponent inputs: ${bobOppInputs.length}`);

		// Both send done
		alice.send({ type: 'match-done', matchId });
		bob.send({ type: 'match-done', matchId });

		// Both should get match-end
		const aliceEnd = await alice.waitFor('match-end');
		const bobEnd = await bob.waitFor('match-end');
		assertEqual(aliceEnd.matchId, matchId);
		assert(aliceEnd.winner, 'should have a winner');
		assert(aliceEnd.scoreA >= 0, 'should have scoreA');
		assert(aliceEnd.scoreB >= 0, 'should have scoreB');
		assertEqual(aliceEnd.winner, bobEnd.winner, 'both see same winner');

		// Verify bracket updated
		await sleep(1200);
		const afterBracket = await api(server, '/api/tournaments/match-test/bracket');
		const doneMatch = afterBracket.matches.find((m: any) => m.id === matchId);
		assertEqual(doneMatch.status, 'complete');
		assert(doneMatch.winner, 'bracket shows winner');
		assert(doneMatch.scoreA !== null, 'bracket has scoreA');

		// Tournament should be complete (only 1 round for 2 players)
		assertEqual(afterBracket.tournament.status, 'complete');

		alice.close();
		bob.close();
	} finally {
		await stopServer(server.proc);
	}
});
