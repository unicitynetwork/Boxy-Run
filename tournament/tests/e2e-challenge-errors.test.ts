/**
 * Challenge error paths: offline opponent, self-challenge, challenge
 * while in tournament, decline, invalid challenge ID, double challenge.
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

runTest('e2e: challenge error paths', async () => {
	const server = await startServer({ readyRateLimitMs: 0 });
	try {
		const alice = makePlayer(server.url, 'alice_err');
		const bob = makePlayer(server.url, 'bob_err');
		const charlie = makePlayer(server.url, 'charlie_err');

		await alice.client.connect();
		await bob.client.connect();
		await charlie.client.connect();
		alice.client.register();
		bob.client.register();
		charlie.client.register();
		await alice.waitRegistered();
		await bob.waitRegistered();
		await charlie.waitRegistered();

		// ── 1. Challenge offline player ──
		alice.client.challenge('nobody_here');
		await sleep(200);
		assert(
			alice.errors.some(e => e.includes('opponent_offline')),
			`expected opponent_offline error, got: ${alice.errors.join('; ')}`,
		);
		alice.errors.length = 0;

		// ── 2. Challenge yourself ──
		alice.client.challenge('alice_err');
		await sleep(200);
		assert(
			alice.errors.some(e => e.includes('self_challenge')),
			`expected self_challenge error, got: ${alice.errors.join('; ')}`,
		);
		alice.errors.length = 0;

		// ── 3. Decline a challenge ──
		alice.client.challenge('bob_err');
		const ch1 = await bob.waitChallengeReceived();
		bob.client.declineChallenge(ch1.challengeId);
		await sleep(200);
		// Alice should see a declined message (via the challenge-declined dispatch)
		const declined = alice.messages.find(m => m.type === 'challenge-declined');
		assert(declined !== undefined, 'alice should get challenge-declined');
		assertEqual(declined!.data.by, 'bob_err', 'declined by bob');

		// ── 4. Accept invalid challenge ID ──
		bob.client.acceptChallenge('nonexistent-id');
		await sleep(200);
		assert(
			bob.errors.some(e => e.includes('invalid_challenge')),
			`expected invalid_challenge error, got: ${bob.errors.join('; ')}`,
		);
		bob.errors.length = 0;

		// ── 5. Challenge while in a tournament ──
		// First, create a tournament between alice and bob
		alice.client.challenge('bob_err');
		const ch2 = await bob.waitChallengeReceived();
		bob.client.acceptChallenge(ch2.challengeId);
		await alice.waitRoundOpen();
		await bob.waitRoundOpen();

		// Now alice tries to challenge charlie while in the tournament
		alice.client.challenge('charlie_err');
		await sleep(200);
		assert(
			alice.errors.some(e => e.includes('in_tournament')),
			`expected in_tournament error, got: ${alice.errors.join('; ')}`,
		);

		// Charlie tries to challenge alice (who is busy)
		charlie.client.challenge('alice_err');
		await sleep(200);
		assert(
			charlie.errors.some(e => e.includes('opponent_busy')),
			`expected opponent_busy error, got: ${charlie.errors.join('; ')}`,
		);

		alice.client.disconnect();
		bob.client.disconnect();
		charlie.client.disconnect();
	} finally {
		await stopServer(server.proc);
	}
});
