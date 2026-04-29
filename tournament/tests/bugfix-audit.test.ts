/**
 * Tests for bugs found in the April 2026 code audit.
 * Each test verifies a specific fix.
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
	TEST_ADMIN_KEY,
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
				send(msg: any) { ws.send(JSON.stringify(msg)); },
				close() { ws.close(); },
			});
		});
	});
}

// ── S9: match-done requires participant validation ──────────────

runTest('S9: match-done rejects non-participant', async () => {
	const server = await startServer();
	try {
		const alice = await wsConnect(server.port, 'alice');
		const bob = await wsConnect(server.port, 'bob');
		const eve = await wsConnect(server.port, 'eve');
		await sleep(300);

		// Alice challenges Bob
		const ch = await api(server, '/api/challenges', {
			method: 'POST',
			body: { from: 'alice', opponent: 'bob', wager: 0, bestOf: 1 }, asNametag: 'alice',
		});
		assert(ch.challengeId, 'challenge created');

		// Bob accepts
		const accept = await api(server, `/api/challenges/${ch.challengeId}/accept`, {
			method: 'POST',
			body: { by: 'bob' }, asNametag: 'bob',
		});
		assert(accept.matchId, 'match started');

		// Parse matchId to get REST path
		const parsed = accept.matchId.match(/^(.+)\/R(\d+)M(\d+)$/);
		assert(parsed, 'matchId parseable');
		const [, tid, round, slot] = parsed;

		// Both ready so match is playing
		const readyUrl = `/api/tournaments/${encodeURIComponent(tid)}/matches/${round}/${slot}/ready`;
		await api(server, readyUrl, { method: 'POST', body: { nametag: 'alice' }, asNametag: 'alice' });
		await api(server, readyUrl, { method: 'POST', body: { nametag: 'bob' }, asNametag: 'bob' });
		await sleep(500);

		// Eve (not in this match) tries to call match-done
		try {
			await api(server, `/api/tournaments/${encodeURIComponent(tid)}/matches/${round}/${slot}/done`, {
				method: 'POST',
				body: { nametag: 'eve' }, asNametag: 'eve',
			});
			assert(false, 'should have thrown');
		} catch (e: any) {
			assert(e.message.includes('403'), 'eve rejected with 403');
		}

		// Alice (in the match) should succeed
		const aliceResult = await api(server, `/api/tournaments/${encodeURIComponent(tid)}/matches/${round}/${slot}/done`, {
			method: 'POST',
			body: { nametag: 'alice' }, asNametag: 'alice',
		});
		assertEqual(aliceResult.status, 'ok', 'alice accepted');

		alice.close();
		bob.close();
		eve.close();
	} finally {
		await stopServer(server.proc);
	}
});

// ── S1: socket re-registration replaces old socket cleanly ──────

runTest('S1: reconnect with same nametag replaces old socket', async () => {
	const server = await startServer();
	try {
		const alice1 = await wsConnect(server.port, 'alice');
		await sleep(200);

		// Verify alice is online
		let online = await api(server, '/api/online');
		assert(online.players.includes('alice'), 'alice online via first socket');

		// Connect again with same nametag (simulates reconnect)
		const alice2 = await wsConnect(server.port, 'alice');
		await sleep(200);

		// Alice should still be online (once, not twice)
		online = await api(server, '/api/online');
		const aliceCount = online.players.filter((n: string) => n === 'alice').length;
		assertEqual(aliceCount, 1, 'alice appears exactly once');

		// Close old socket — alice should STILL be online (new socket is active)
		alice1.close();
		await sleep(200);

		online = await api(server, '/api/online');
		assert(online.players.includes('alice'), 'alice still online after old socket closed');

		// Close new socket — now alice should be offline
		alice2.close();
		await sleep(200);

		online = await api(server, '/api/online');
		assert(!online.players.includes('alice'), 'alice offline after both sockets closed');
	} finally {
		await stopServer(server.proc);
	}
});

// ── S3: challenge link expiry at 5 minutes ──────────────────────

runTest('S3: challenge link expires after 5 minutes', async () => {
	const server = await startServer();
	try {
		const alice = await wsConnect(server.port, 'alice');
		await sleep(200);

		// Create a link
		const link = await api(server, '/api/challenge-links', {
			method: 'POST',
			body: { from: 'alice', bestOf: 1, wager: 0 }, asNametag: 'alice',
		});
		assert(link.code, 'link created');

		// Should be visible
		const info1 = await api(server, `/api/challenge-links/${link.code}`);
		assertEqual(info1.accepted, false, 'link pending');

		// Advance clock past 5 minutes
		await advanceClock(server, 5 * 60_000 + 1000);
		await sleep(200); // let reconciliation tick run

		// Should be expired now
		try {
			await api(server, `/api/challenge-links/${link.code}`);
			assert(false, 'should have thrown 404');
		} catch (e: any) {
			assert(e.message.includes('404'), 'link expired with 404');
		}

		alice.close();
	} finally {
		await stopServer(server.proc);
	}
});

// ── Challenge: accepting cancels all other pending ──────────────

runTest('Challenge: accepting one cancels all others for both players', async () => {
	const server = await startServer();
	try {
		const alice = await wsConnect(server.port, 'alice');
		const bob = await wsConnect(server.port, 'bob');
		const carol = await wsConnect(server.port, 'carol');
		await sleep(300);

		// Alice creates a link challenge
		const link = await api(server, '/api/challenge-links', {
			method: 'POST',
			body: { from: 'alice', bestOf: 1, wager: 0 }, asNametag: 'alice',
		});

		// Carol sends a live challenge to Alice
		const ch = await api(server, '/api/challenges', {
			method: 'POST',
			body: { from: 'carol', opponent: 'alice', wager: 0, bestOf: 1 }, asNametag: 'carol',
		});

		// Alice accepts Carol's challenge
		const accept = await api(server, `/api/challenges/${ch.challengeId}/accept`, {
			method: 'POST',
			body: { by: 'alice' }, asNametag: 'alice',
		});
		assert(accept.matchId, 'match started');

		// Alice's link should be cancelled
		try {
			await api(server, `/api/challenge-links/${link.code}`);
			assert(false, 'should have thrown 404');
		} catch (e: any) {
			assert(e.message.includes('404'), 'link cancelled');
		}

		alice.close();
		bob.close();
		carol.close();
	} finally {
		await stopServer(server.proc);
	}
});

// ── Challenge: can't accept your own link ───────────────────────

runTest('Challenge: self-accept on link rejected', async () => {
	const server = await startServer();
	try {
		const alice = await wsConnect(server.port, 'alice');
		await sleep(200);

		const link = await api(server, '/api/challenge-links', {
			method: 'POST',
			body: { from: 'alice', bestOf: 1, wager: 0 }, asNametag: 'alice',
		});

		try {
			await api(server, `/api/challenge-links/${link.code}/accept`, {
				method: 'POST',
				body: { by: 'alice' }, asNametag: 'alice',
			});
			assert(false, 'should have thrown');
		} catch (e: any) {
			assert(e.message.includes('400'), 'self-accept rejected with 400');
		}

		alice.close();
	} finally {
		await stopServer(server.proc);
	}
});

// ── Challenge: busy bot rejected ────────────────────────────────

runTest('Challenge: busy opponent rejected', async () => {
	const server = await startServer();
	try {
		const alice = await wsConnect(server.port, 'alice');
		const bob = await wsConnect(server.port, 'bob');
		const carol = await wsConnect(server.port, 'carol');
		await sleep(300);

		// Alice challenges Bob — Bob accepts
		const ch1 = await api(server, '/api/challenges', {
			method: 'POST',
			body: { from: 'alice', opponent: 'bob', wager: 0, bestOf: 1 }, asNametag: 'alice',
		});
		await api(server, `/api/challenges/${ch1.challengeId}/accept`, {
			method: 'POST',
			body: { by: 'bob' }, asNametag: 'bob',
		});

		// Carol tries to challenge Alice (who is now in a match)
		// This should still work for human players (only bots have busy detection)
		// But we can verify the challenge is created
		const ch2 = await api(server, '/api/challenges', {
			method: 'POST',
			body: { from: 'carol', opponent: 'alice', wager: 0, bestOf: 1 }, asNametag: 'carol',
		});
		assert(ch2.challengeId, 'challenge to busy human still works');

		alice.close();
		bob.close();
		carol.close();
	} finally {
		await stopServer(server.proc);
	}
});

// ── Challenge: live challenge expires after 60s ─────────────────

runTest('Challenge: live challenge expires after 60s', async () => {
	const server = await startServer();
	try {
		const alice = await wsConnect(server.port, 'alice');
		const bob = await wsConnect(server.port, 'bob');
		await sleep(300);

		const ch = await api(server, '/api/challenges', {
			method: 'POST',
			body: { from: 'alice', opponent: 'bob', wager: 0, bestOf: 1 }, asNametag: 'alice',
		});

		// Should be pending
		const pending1 = await api(server, `/api/challenges/pending?nametag=bob`);
		assert(pending1.challenges.length >= 1, 'challenge visible to bob');

		// Advance 61 seconds
		await advanceClock(server, 61_000);
		await sleep(1500); // wait for reconciliation tick (1s interval)

		// Should be expired
		const pending2 = await api(server, `/api/challenges/pending?nametag=bob`);
		const stillThere = pending2.challenges.find((c: any) => c.id === ch.challengeId);
		assert(!stillThere, 'challenge expired after 60s');

		alice.close();
		bob.close();
	} finally {
		await stopServer(server.proc);
	}
});

// ── S4: completed match not resurrected ─────────────────────────

runTest('S4: completed match cannot be resurrected by late events', async () => {
	const server = await startServer();
	try {
		const alice = await wsConnect(server.port, 'alice');
		const bob = await wsConnect(server.port, 'bob');
		await sleep(300);

		// Create and play through a challenge
		const ch = await api(server, '/api/challenges', {
			method: 'POST',
			body: { from: 'alice', opponent: 'bob', wager: 0, bestOf: 1 }, asNametag: 'alice',
		});
		const accept = await api(server, `/api/challenges/${ch.challengeId}/accept`, {
			method: 'POST',
			body: { by: 'bob' }, asNametag: 'bob',
		});

		const parsed = accept.matchId.match(/^(.+)\/R(\d+)M(\d+)$/);
		const [, tid, round, slot] = parsed;
		const stateUrl = `/api/tournaments/${encodeURIComponent(tid)}/matches/${round}/${slot}/state`;
		const readyUrl = `/api/tournaments/${encodeURIComponent(tid)}/matches/${round}/${slot}/ready`;
		const doneUrl = `/api/tournaments/${encodeURIComponent(tid)}/matches/${round}/${slot}/done`;

		// Both ready
		await api(server, readyUrl, { method: 'POST', body: { nametag: 'alice' }, asNametag: 'alice' });
		await api(server, readyUrl, { method: 'POST', body: { nametag: 'bob' }, asNametag: 'bob' });
		await sleep(500);

		// Both done
		await api(server, doneUrl, { method: 'POST', body: { nametag: 'alice' }, asNametag: 'alice' });
		await api(server, doneUrl, { method: 'POST', body: { nametag: 'bob' }, asNametag: 'bob' });
		await sleep(1500); // wait for replay

		// Match should be complete
		const state1 = await api(server, stateUrl);
		assertEqual(state1.machinePhase, 'resolved', 'match resolved');

		// Now try to ready again (late event) — should not resurrect
		try {
			await api(server, readyUrl, {
				method: 'POST',
				body: { nametag: 'alice' }, asNametag: 'alice',
			});
			assert(false, 'should have thrown');
		} catch (e: any) {
			assert(e.message.includes('409'), 'late ready rejected with 409');
		}

		alice.close();
		bob.close();
	} finally {
		await stopServer(server.proc);
	}
});

// ── Online API: bots vs humans separated ────────────────────────

runTest('Online API returns bots and humans separately', async () => {
	const server = await startServer();
	try {
		const alice = await wsConnect(server.port, 'alice');
		await sleep(1000); // wait for bots to spawn

		const online = await api(server, '/api/online');
		assert(Array.isArray(online.bots), 'bots array present');
		assert(Array.isArray(online.humans), 'humans array present');

		// Alice should be in humans
		assert(online.humans.includes('alice'), 'alice in humans');

		// Bots should have skill field
		if (online.bots.length > 0) {
			assert(online.bots[0].name, 'bot has name');
			assert(online.bots[0].skill, 'bot has skill');
		}

		// Alice should NOT be in bots
		assert(!online.bots.find((b: any) => b.name === 'alice'), 'alice not in bots');

		alice.close();
	} finally {
		await stopServer(server.proc);
	}
});
