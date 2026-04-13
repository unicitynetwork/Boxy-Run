/**
 * V2 Match flow — full end-to-end: create tournament, register,
 * start, both players ready via WebSocket, exchange inputs,
 * both send done, server replays, match-end received, bracket
 * updates.
 */

import WebSocket from 'ws';
import {
	assert,
	assertEqual,
	runTest,
	sleep,
	startServer,
	stopServer,
} from './harness';

async function api(baseUrl: string, path: string, method = 'GET', body?: any) {
	const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
	if (body) opts.body = JSON.stringify(body);
	const r = await fetch(`${baseUrl}${path}`, opts);
	return r.json();
}

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

		ws.on('open', () => {
			ws.send(JSON.stringify({ type: 'register', identity: { nametag } }));
			resolve({
				ws, messages,
				waitFor(type, timeout = 5000) {
					// Check buffer
					for (const m of messages) {
						if (m.type === type) return Promise.resolve(m);
					}
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
	const base = `http://127.0.0.1:${server.port}/api`;
	try {
		// Create + register + start
		await api(base, '/tournaments', 'POST', { id: 'match-test', name: 'Match Test' });
		await api(base, '/tournaments/match-test/register', 'POST', { nametag: 'alice' });
		await api(base, '/tournaments/match-test/register', 'POST', { nametag: 'bob' });
		await api(base, '/tournaments/match-test/start', 'POST');

		// Get the match ID
		const bracket = await api(base, '/tournaments/match-test/bracket');
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
		await sleep(500);
		const afterBracket = await api(base, '/tournaments/match-test/bracket');
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

runTest('v2: 4-player tournament — 2 rounds, bracket advancement', async () => {
	const server = await startServer();
	const base = `http://127.0.0.1:${server.port}/api`;
	try {
		await api(base, '/tournaments', 'POST', { id: '4p-test', name: '4P Test' });
		for (const p of ['alice', 'bob', 'charlie', 'dave']) {
			await api(base, '/tournaments/4p-test/register', 'POST', { nametag: p });
		}
		await api(base, '/tournaments/4p-test/start', 'POST');

		let bracket = await api(base, '/tournaments/4p-test/bracket');
		assertEqual(bracket.tournament.current_round, 0);
		const r0matches = bracket.matches.filter((m: any) => m.round === 0 && m.status === 'ready_wait');
		assertEqual(r0matches.length, 2, 'two round-0 matches');

		// Play both round-0 matches
		for (const match of r0matches) {
			const pA = await wsConnect(server.port, match.playerA);
			const pB = await wsConnect(server.port, match.playerB);
			await sleep(100);

			pA.send({ type: 'match-ready', matchId: match.id });
			pB.send({ type: 'match-ready', matchId: match.id });
			await pA.waitFor('match-start');
			await pB.waitFor('match-start');

			// Send some inputs so scores differ
			pA.send({ type: 'input', matchId: match.id, tick: 10, payload: btoa('up') });
			await sleep(100);

			pA.send({ type: 'match-done', matchId: match.id });
			pB.send({ type: 'match-done', matchId: match.id });
			await pA.waitFor('match-end');
			await pB.waitFor('match-end');

			pA.close();
			pB.close();
		}

		// Wait for round advance
		await sleep(500);
		bracket = await api(base, '/tournaments/4p-test/bracket');

		// Round 1 (final) should now be ready_wait with two winners
		const final = bracket.matches.find((m: any) => m.round === 1);
		assert(final, 'should have final match');
		assert(final.playerA, 'final playerA populated');
		assert(final.playerB, 'final playerB populated');
		assertEqual(final.status, 'ready_wait', 'final is ready_wait');
		assertEqual(bracket.tournament.current_round, 1, 'advanced to round 1');

		// Play the final
		const fA = await wsConnect(server.port, final.playerA);
		const fB = await wsConnect(server.port, final.playerB);
		await sleep(100);

		fA.send({ type: 'match-ready', matchId: final.id });
		fB.send({ type: 'match-ready', matchId: final.id });
		await fA.waitFor('match-start');
		await fB.waitFor('match-start');

		fA.send({ type: 'match-done', matchId: final.id });
		fB.send({ type: 'match-done', matchId: final.id });
		await fA.waitFor('match-end');

		await sleep(500);
		bracket = await api(base, '/tournaments/4p-test/bracket');
		assertEqual(bracket.tournament.status, 'complete', 'tournament complete');

		// All matches should be complete
		for (const m of bracket.matches) {
			assert(m.status === 'complete' || m.status === 'pending', `match ${m.id} status: ${m.status}`);
		}

		fA.close();
		fB.close();
	} finally {
		await stopServer(server.proc);
	}
});
