/**
 * Redirect race condition: simulates the EXACT browser behavior when
 * tournament.html does location.href = dev.html:
 *   1. Old WS closes (browser navigates away)
 *   2. Gap of ~500ms (new page loading)
 *   3. New WS connects and registers
 *
 * The server must preserve the tournament assignment during the gap
 * (grace period on close handler).
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

runTest('e2e: redirect race — disconnect before reconnect preserves tournament', async () => {
	const server = await startServer({ readyRateLimitMs: 0 });
	try {
		// Phase 1: register + challenge on "tournament.html"
		const alice1 = makePlayer(server.url, 'alice_rr');
		const bob1 = makePlayer(server.url, 'bob_rr');

		await alice1.client.connect();
		await bob1.client.connect();
		alice1.client.register();
		bob1.client.register();
		await alice1.waitRegistered();
		await bob1.waitRegistered();

		alice1.client.challenge('bob_rr');
		const ch = await bob1.waitChallengeReceived();
		bob1.client.acceptChallenge(ch.challengeId);
		await alice1.waitRoundOpen();
		await bob1.waitRoundOpen();

		// Phase 2: DISCONNECT FIRST (browser navigates away)
		alice1.client.disconnect();
		bob1.client.disconnect();

		// Phase 3: Wait 500ms (simulating page load time)
		await sleep(500);

		// Phase 4: New connections register (game page loaded)
		const alice2 = makePlayer(server.url, 'alice_rr');
		const bob2 = makePlayer(server.url, 'bob_rr');

		await alice2.client.connect();
		await bob2.client.connect();
		alice2.client.register();
		bob2.client.register();
		await alice2.waitRegistered();
		await bob2.waitRegistered();

		// Phase 5: Both should get round-open (tournament preserved)
		const aRO = await alice2.waitRoundOpen();
		const bRO = await bob2.waitRoundOpen();
		assertEqual(aRO.matchId, bRO.matchId, 'same matchId after redirect gap');

		// Phase 6: Play the match
		alice2.client.ready(aRO.matchId);
		bob2.client.ready(bRO.matchId);

		const aStart = await alice2.waitMatchStart();
		const bStart = await bob2.waitMatchStart();
		assertEqual(aStart.seed, bStart.seed, 'same seed');

		// Verify input relay works on the new connections
		alice2.client.sendInput(aRO.matchId, 10, btoa('up'));
		bob2.client.sendInput(bRO.matchId, 15, btoa('left'));
		await sleep(200);
		assert(bob2.opponentInputCount >= 1, 'bob gets alice input after redirect');
		assert(alice2.opponentInputCount >= 1, 'alice gets bob input after redirect');

		assertEqual(alice2.errors.length, 0, `alice errors: ${alice2.errors.join('; ')}`);
		assertEqual(bob2.errors.length, 0, `bob errors: ${bob2.errors.join('; ')}`);

		alice2.client.disconnect();
		bob2.client.disconnect();
	} finally {
		await stopServer(server.proc);
	}
});
