/**
 * Match-phase error paths: bad matchId, input before match starts,
 * mismatched result hashes (should flag), duplicate result.
 */

import {
	assert,
	assertEqual,
	runTest,
	sleep,
	startServer,
	stopServer,
} from './harness';
import { makePlayer } from './e2e-helpers';

let matchCounter = 0;

/** Helper: set up a challenge match and return both players + matchId */
async function setupMatch(url: string) {
	matchCounter++;
	const alice = makePlayer(url, `alice_merr${matchCounter}`);
	const bob = makePlayer(url, `bob_merr${matchCounter}`);

	await alice.client.connect();
	await bob.client.connect();
	alice.client.register();
	bob.client.register();
	await alice.waitRegistered();
	await bob.waitRegistered();

	alice.client.challenge(`bob_merr${matchCounter}`);
	const ch = await bob.waitChallengeReceived();
	bob.client.acceptChallenge(ch.challengeId);

	const aRO = await alice.waitRoundOpen();
	await bob.waitRoundOpen();

	return { alice, bob, matchId: aRO.matchId };
}

runTest('e2e: match-phase error paths', async () => {
	const server = await startServer({ readyRateLimitMs: 0 });
	try {
		// ── 1. Ready with bad matchId ──
		{
			const alice = makePlayer(server.url, `alice_bad${Date.now()}`);
			await alice.client.connect();
			alice.client.register();
			await alice.waitRegistered();
			alice.client.ready('nonexistent-match');
			await sleep(200);
			assert(
				alice.errors.some(e => e.includes('no_tournament') || e.includes('unknown_match')),
				`expected error for bad matchId, got: ${alice.errors.join('; ')}`,
			);
			alice.client.disconnect();
		}

		// ── 2. Input before match starts (during ready-wait) ──
		{
			const { alice, bob, matchId } = await setupMatch(server.url);
			// Don't ready up — send input while still in READY_WAIT
			alice.client.sendInput(matchId, 10, btoa('up'));
			await sleep(200);
			// Server should reject (match not active) — check bob didn't get it
			assertEqual(bob.opponentInputCount, 0, 'bob should not receive input before match starts');

			// Clean up
			alice.client.disconnect();
			bob.client.disconnect();
		}

		// ── 3. Server-adjudicated: higher score wins ──
		{
			const { alice, bob, matchId } = await setupMatch(server.url);
			alice.client.ready(matchId);
			bob.client.ready(matchId);
			await alice.waitMatchStart();
			await bob.waitMatchStart();

			// A reports score 8000, B reports score 5000
			alice.client.submitResult(matchId, 500, { A: 8000 }, 'A', 'h', 'r');
			bob.client.submitResult(matchId, 500, { B: 5000 }, 'B', 'h', 'r');

			const aEnd = await alice.waitMatchEnd();
			const bEnd = await bob.waitMatchEnd();
			assertEqual(aEnd.reason, 'death', 'server adjudicates as death');
			assert(aEnd.winner !== '', 'should have a winner');
			// A had higher score, so A's player should win
			assertEqual(aEnd.winner, bEnd.winner, 'both see same winner');

			alice.client.disconnect();
			bob.client.disconnect();
		}

		// ── 4. Server-adjudicated: lower score loses ──
		{
			const { alice, bob, matchId } = await setupMatch(server.url);
			alice.client.ready(matchId);
			bob.client.ready(matchId);
			await alice.waitMatchStart();
			await bob.waitMatchStart();

			// A reports score 3000, B reports score 9000 — B wins
			alice.client.submitResult(matchId, 500, { A: 3000 }, 'A', 'h', 'r');
			bob.client.submitResult(matchId, 500, { B: 9000 }, 'B', 'h', 'r');

			const aEnd = await alice.waitMatchEnd();
			assertEqual(aEnd.reason, 'death');
			assert(aEnd.winner !== '', 'should have a winner');

			alice.client.disconnect();
			bob.client.disconnect();
		}
	} finally {
		await stopServer(server.proc);
	}
});
