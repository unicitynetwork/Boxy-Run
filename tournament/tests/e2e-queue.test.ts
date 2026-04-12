/**
 * Rolling queue: players join queue, receive queue-state updates,
 * and when the countdown fires a tournament is created.
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

runTest('e2e: rolling queue — join, state updates, leave', async () => {
	// Start server with low min players and short countdown for testing
	const server = await startServer({
		readyRateLimitMs: 0,
	});
	try {
		const alice = makePlayer(server.url, 'alice_q');
		const bob = makePlayer(server.url, 'bob_q');
		const charlie = makePlayer(server.url, 'charlie_q');

		await alice.client.connect();
		await bob.client.connect();
		await charlie.client.connect();
		alice.client.register();
		bob.client.register();
		charlie.client.register();
		await alice.waitRegistered();
		await bob.waitRegistered();
		await charlie.waitRegistered();

		// ── Alice joins queue ──
		alice.client.joinQueue();
		await sleep(200);

		// Alice should get queue-state with total=1
		const aliceQS = alice.messages.filter(m => m.type === 'queue-state');
		assert(aliceQS.length > 0, 'alice should receive queue-state');
		assertEqual(aliceQS[aliceQS.length - 1].data.total, 1, 'total=1 after alice joins');
		assertEqual(aliceQS[aliceQS.length - 1].data.position, 1, 'alice is position 1');

		// ── Bob joins queue ──
		bob.client.joinQueue();
		await sleep(200);

		// Both should get updated queue-state with total=2
		const aliceQS2 = alice.messages.filter(m => m.type === 'queue-state');
		const bobQS = bob.messages.filter(m => m.type === 'queue-state');
		assert(aliceQS2.length > 1, 'alice should get updated queue-state');
		assertEqual(aliceQS2[aliceQS2.length - 1].data.total, 2, 'total=2 after bob joins');
		assert(bobQS.length > 0, 'bob should receive queue-state');
		assertEqual(bobQS[bobQS.length - 1].data.total, 2, 'bob sees total=2');

		// ── Bob leaves queue ──
		bob.client.leaveQueue();
		await sleep(200);

		// Alice should get queue-state with total=1 again
		const aliceQS3 = alice.messages.filter(m => m.type === 'queue-state');
		assertEqual(aliceQS3[aliceQS3.length - 1].data.total, 1, 'total=1 after bob leaves');

		// ── Verify errors ──
		assertEqual(alice.errors.length, 0, `alice errors: ${alice.errors.join('; ')}`);
		assertEqual(bob.errors.length, 0, `bob errors: ${bob.errors.join('; ')}`);

		// ── Double-join should error ──
		alice.client.joinQueue();
		await sleep(200);
		assert(
			alice.errors.some(e => e.includes('already_in_queue')),
			`expected already_in_queue, got: ${alice.errors.join('; ')}`,
		);

		// ── Charlie joins while in a tournament should error ──
		// First put charlie in a tournament
		alice.client.leaveQueue();
		await sleep(100);
		alice.client.challenge('charlie_q');
		const ch = await charlie.waitChallengeReceived();
		charlie.client.acceptChallenge(ch.challengeId);
		await charlie.waitRoundOpen();

		charlie.client.joinQueue();
		await sleep(200);
		assert(
			charlie.errors.some(e => e.includes('in_tournament')),
			`expected in_tournament, got: ${charlie.errors.join('; ')}`,
		);

		alice.client.disconnect();
		bob.client.disconnect();
		charlie.client.disconnect();
	} finally {
		await stopServer(server.proc);
	}
});
