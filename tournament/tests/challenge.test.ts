/**
 * Challenge flow — peer invitation, accept, decline, expire, errors.
 *
 * Exercises both WS and REST entry points and verifies they produce the
 * same server state. Uses the fake clock for the 30s expiry case.
 */

import WebSocket from 'ws';
import {
	advanceClock,
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

runTest('challenge: REST create → WS receives challenge-received', async () => {
	const server = await startServer();
	try {
		const alice = await wsConnect(server.port, 'alice');
		const bob = await wsConnect(server.port, 'bob');
		await sleep(100);

		const created = await api(server, '/api/challenges', {
			method: 'POST',
			body: { from: 'alice', opponent: 'bob', wager: 0, bestOf: 1 }, asNametag: 'alice',
		});
		assert(created.challengeId, 'challengeId returned');

		// Bob receives the invitation over WS
		const invite = await bob.waitFor('challenge-received');
		assertEqual(invite.from, 'alice');
		assertEqual(invite.challengeId, created.challengeId);
		assertEqual(invite.wager, 0);
		assertEqual(invite.bestOf, 1);

		// Alice also gets the echo push
		const sent = await alice.waitFor('challenge-sent');
		assertEqual(sent.opponent, 'bob');

		alice.close();
		bob.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('challenge: self-challenge → 400 self_challenge', async () => {
	const server = await startServer();
	try {
		const alice = await wsConnect(server.port, 'alice');
		await sleep(100);

		const result = await api(server, '/api/challenges', {
			method: 'POST',
			body: { from: 'alice', opponent: 'alice' }, asNametag: 'alice',
			allowError: true,
		});
		assertEqual(result.error, 'self_challenge');

		alice.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('challenge: offline opponent → 409 opponent_offline', async () => {
	const server = await startServer();
	try {
		const alice = await wsConnect(server.port, 'alice');
		await sleep(100);

		const result = await api(server, '/api/challenges', {
			method: 'POST',
			body: { from: 'alice', opponent: 'ghost_player' }, asNametag: 'alice',
			allowError: true,
		});
		assertEqual(result.error, 'opponent_offline');

		alice.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('challenge: missing from/opponent → 400', async () => {
	const server = await startServer();
	try {
		const r1 = await api(server, '/api/challenges', {
			method: 'POST', body: { opponent: 'bob' }, allowError: true,
		});
		assertEqual(r1.error, 'from_and_opponent_required');
		const r2 = await api(server, '/api/challenges', {
			method: 'POST', body: { from: 'alice' }, asNametag: 'alice', allowError: true,
		});
		assertEqual(r2.error, 'from_and_opponent_required');
	} finally {
		await stopServer(server.proc);
	}
});

runTest('challenge: accept → match starts with both participants', async () => {
	const server = await startServer();
	try {
		const alice = await wsConnect(server.port, 'alice');
		const bob = await wsConnect(server.port, 'bob');
		await sleep(100);

		const created = await api(server, '/api/challenges', {
			method: 'POST', body: { from: 'alice', opponent: 'bob' }, asNametag: 'alice',
		});
		await bob.waitFor('challenge-received');

		const accepted = await api(server, `/api/challenges/${created.challengeId}/accept`, {
			method: 'POST', body: { by: 'bob' }, asNametag: 'bob',
		});
		assertEqual(accepted.status, 'accepted');
		assert(accepted.matchId, 'matchId present');
		assert(accepted.seed, 'seed present');
		assert(accepted.tournamentId, 'tournamentId present');

		// Both get challenge-start
		const aStart = await alice.waitFor('challenge-start');
		const bStart = await bob.waitFor('challenge-start');
		assertEqual(aStart.matchId, accepted.matchId);
		assertEqual(bStart.matchId, accepted.matchId);
		assertEqual(aStart.seed, bStart.seed);
		const sides = new Set([aStart.youAre, bStart.youAre]);
		assertEqual([...sides].sort(), ['A', 'B']);

		alice.close();
		bob.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('challenge: accept invalid ID → 404 invalid_challenge', async () => {
	const server = await startServer();
	try {
		const bob = await wsConnect(server.port, 'bob');
		await sleep(100);
		const r = await api(server, '/api/challenges/ch-nonexistent/accept', {
			method: 'POST', body: { by: 'bob' }, asNametag: 'bob', allowError: true,
		});
		assertEqual(r.error, 'invalid_challenge');
		bob.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('challenge: accept by wrong player → 404 invalid_challenge', async () => {
	const server = await startServer();
	try {
		const alice = await wsConnect(server.port, 'alice');
		const bob = await wsConnect(server.port, 'bob');
		const eve = await wsConnect(server.port, 'eve');
		await sleep(100);

		const created = await api(server, '/api/challenges', {
			method: 'POST', body: { from: 'alice', opponent: 'bob' }, asNametag: 'alice',
		});

		// eve tries to accept a challenge addressed to bob
		const r = await api(server, `/api/challenges/${created.challengeId}/accept`, {
			method: 'POST', body: { by: 'eve' }, asNametag: 'eve', allowError: true,
		});
		assertEqual(r.error, 'invalid_challenge');

		alice.close();
		bob.close();
		eve.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('challenge: decline → challenger notified, idempotent on repeat', async () => {
	const server = await startServer();
	try {
		const alice = await wsConnect(server.port, 'alice');
		const bob = await wsConnect(server.port, 'bob');
		await sleep(100);

		const created = await api(server, '/api/challenges', {
			method: 'POST', body: { from: 'alice', opponent: 'bob' }, asNametag: 'alice',
		});
		await bob.waitFor('challenge-received');

		const r1 = await api(server, `/api/challenges/${created.challengeId}/decline`, {
			method: 'POST', body: { by: 'bob' }, asNametag: 'bob',
		});
		assertEqual(r1.declined, true);

		// Alice receives the notice
		const notice = await alice.waitFor('challenge-declined');
		assertEqual(notice.by, 'bob');

		// Second decline is idempotent (challenge already gone)
		const r2 = await api(server, `/api/challenges/${created.challengeId}/decline`, {
			method: 'POST', body: { by: 'bob' }, asNametag: 'bob',
		});
		assertEqual(r2.status, 'ok');
		assertEqual(r2.declined, false);

		alice.close();
		bob.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('challenge: expires after 60s via reconciler', async () => {
	const server = await startServer();
	try {
		const alice = await wsConnect(server.port, 'alice');
		const bob = await wsConnect(server.port, 'bob');
		await sleep(100);

		const created = await api(server, '/api/challenges', {
			method: 'POST', body: { from: 'alice', opponent: 'bob' }, asNametag: 'alice',
		});
		await bob.waitFor('challenge-received');

		// Advance past CHALLENGE_EXPIRY_MS (60s in challenge.ts).
		await advanceClock(server, 65_000);
		await sleep(1200); // let the 1s tick observe

		// Alice receives challenge_expired error
		const expired = alice.messages.find((m) => m.type === 'error' && m.code === 'challenge_expired');
		assert(expired, 'alice notified of expiry');

		// Accepting now fails
		const r = await api(server, `/api/challenges/${created.challengeId}/accept`, {
			method: 'POST', body: { by: 'bob' }, asNametag: 'bob', allowError: true,
		});
		assertEqual(r.error, 'invalid_challenge');

		alice.close();
		bob.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('challenge: REGRESSION — accepted challenge starts in awaiting_ready, not playing', async () => {
	// If seeded as 'playing', client match-ready events become no-ops in the
	// machine, no match-status broadcasts, and both clients hang on
	// "WAITING FOR OPPONENT" until the 30s ready TTL expires. Hit prod once.
	const server = await startServer();
	try {
		const alice = await wsConnect(server.port, 'alice');
		const bob = await wsConnect(server.port, 'bob');
		await sleep(100);

		const created = await api(server, '/api/challenges', {
			method: 'POST', body: { from: 'alice', opponent: 'bob' }, asNametag: 'alice',
		});
		await bob.waitFor('challenge-received');
		const accepted = await api(server, `/api/challenges/${created.challengeId}/accept`, {
			method: 'POST', body: { by: 'bob' }, asNametag: 'bob',
		});
		await alice.waitFor('challenge-start');
		await bob.waitFor('challenge-start');

		// Check the machine state — must be awaiting_ready, not playing.
		const state = await api(server, `/api/tournaments/${accepted.tournamentId}/matches/0/0/state`);
		assertEqual(state.ready.A, false, 'Alice is NOT pre-marked ready');
		assertEqual(state.ready.B, false, 'Bob is NOT pre-marked ready');

		// Now simulate the per-game handshake: both click READY.
		alice.send({ type: 'match-ready', matchId: accepted.matchId });
		bob.send({ type: 'match-ready', matchId: accepted.matchId });
		// Both should receive match-start once both are ready.
		const aStart = await alice.waitFor('match-start');
		const bStart = await bob.waitFor('match-start');
		assertEqual(aStart.matchId, accepted.matchId);
		assertEqual(bStart.matchId, accepted.matchId);

		alice.close();
		bob.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('challenge: WS and REST flow both work equivalently', async () => {
	const server = await startServer();
	try {
		const alice = await wsConnect(server.port, 'alice');
		const bob = await wsConnect(server.port, 'bob');
		await sleep(100);

		// Alice uses WS to challenge
		alice.send({ type: 'challenge', opponent: 'bob', wager: 0, bestOf: 1 });
		const invite = await bob.waitFor('challenge-received');
		assert(invite.challengeId);

		// Bob uses REST to accept
		const accepted = await api(server, `/api/challenges/${invite.challengeId}/accept`, {
			method: 'POST', body: { by: 'bob' }, asNametag: 'bob',
		});
		assertEqual(accepted.status, 'accepted');

		// Both sides still get the push
		await alice.waitFor('challenge-start');
		await bob.waitFor('challenge-start');

		alice.close();
		bob.close();
	} finally {
		await stopServer(server.proc);
	}
});
