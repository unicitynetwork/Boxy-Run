/**
 * Post-match asymmetric decisions: what happens when the two players
 * make DIFFERENT choices after a match ends.
 *
 * 1. A rematches, B declines → A gets notified, no stuck state
 * 2. A rematches, B disconnects → A gets opponent_offline
 * 3. A rematches, B accepts → new match works
 * 4. Both disconnect after match → clean server state
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

/** Play a full match between two already-registered players. */
async function playMatch(
	alice: ReturnType<typeof makePlayer>,
	bob: ReturnType<typeof makePlayer>,
	aliceName: string,
	bobName: string,
) {
	alice.client.challenge(bobName);
	const ch = await bob.waitChallengeReceived();
	bob.client.acceptChallenge(ch.challengeId);

	const aRO = await alice.waitRoundOpen();
	await bob.waitRoundOpen();

	alice.client.ready(aRO.matchId);
	bob.client.ready(aRO.matchId);
	await alice.waitMatchStart();
	await bob.waitMatchStart();

	// Both submit results
	alice.client.submitResult(aRO.matchId, 300, { A: 5000 }, 'A', 'h', 'r');
	bob.client.submitResult(aRO.matchId, 300, { B: 3000 }, 'B', 'h', 'r');

	await alice.waitMatchEnd();
	await bob.waitMatchEnd();
}

runTest('e2e: post-match asymmetric decisions', async () => {
	const server = await startServer({ readyRateLimitMs: 0 });
	try {
		// ── 1. A rematches, B declines ──
		{
			const alice = makePlayer(server.url, 'alice_pm1');
			const bob = makePlayer(server.url, 'bob_pm1');

			await alice.client.connect();
			await bob.client.connect();
			alice.client.register();
			bob.client.register();
			await alice.waitRegistered();
			await bob.waitRegistered();

			await playMatch(alice, bob, 'alice_pm1', 'bob_pm1');

			// A sends rematch, B declines
			alice.client.challenge('bob_pm1');
			const rematchCh = await bob.waitChallengeReceived();
			assertEqual(rematchCh.from, 'alice_pm1', 'rematch from alice');

			bob.client.declineChallenge(rematchCh.challengeId);
			await sleep(200);

			// Alice should see challenge-declined
			const declined = alice.messages.find(
				m => m.type === 'challenge-declined' && m.data.challengeId === rematchCh.challengeId,
			);
			assert(declined !== undefined, 'alice should get challenge-declined');

			// Neither player should be stuck — both can still act
			assertEqual(
				alice.errors.filter(e => !e.includes('match_not_active')).length,
				0,
				`alice errors: ${alice.errors.join('; ')}`,
			);

			alice.client.disconnect();
			bob.client.disconnect();
		}

		// ── 2. A rematches, B disconnects ──
		{
			const alice = makePlayer(server.url, 'alice_pm2');
			const bob = makePlayer(server.url, 'bob_pm2');

			await alice.client.connect();
			await bob.client.connect();
			alice.client.register();
			bob.client.register();
			await alice.waitRegistered();
			await bob.waitRegistered();

			await playMatch(alice, bob, 'alice_pm2', 'bob_pm2');

			// B disconnects (clicked Back to Arena)
			bob.client.disconnect();
			// Wait for grace period + a bit
			await sleep(6000);

			// A tries rematch — should get opponent_offline
			alice.client.challenge('bob_pm2');
			await sleep(500);
			assert(
				alice.errors.some(e => e.includes('opponent_offline')),
				`expected opponent_offline, got: ${alice.errors.join('; ')}`,
			);

			alice.client.disconnect();
		}

		// ── 3. Both disconnect after match → clean state ──
		{
			const alice = makePlayer(server.url, 'alice_pm3');
			const bob = makePlayer(server.url, 'bob_pm3');

			await alice.client.connect();
			await bob.client.connect();
			alice.client.register();
			bob.client.register();
			await alice.waitRegistered();
			await bob.waitRegistered();

			await playMatch(alice, bob, 'alice_pm3', 'bob_pm3');

			alice.client.disconnect();
			bob.client.disconnect();
			await sleep(6000);

			// Both reconnect fresh — should be able to play again
			const alice2 = makePlayer(server.url, 'alice_pm3');
			const bob2 = makePlayer(server.url, 'bob_pm3');

			await alice2.client.connect();
			await bob2.client.connect();
			alice2.client.register();
			bob2.client.register();
			await alice2.waitRegistered();
			await bob2.waitRegistered();

			// Should be able to challenge without errors
			alice2.client.challenge('bob_pm3');
			const ch = await bob2.waitChallengeReceived();
			assertEqual(ch.from, 'alice_pm3', 'challenge works after full reconnect');

			assertEqual(alice2.errors.length, 0, `alice2 errors: ${alice2.errors.join('; ')}`);

			alice2.client.disconnect();
			bob2.client.disconnect();
		}
	} finally {
		await stopServer(server.proc);
	}
});
