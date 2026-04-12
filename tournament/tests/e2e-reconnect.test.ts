/**
 * End-to-end reconnection: simulates the game-page redirect flow.
 * Player registers on connection 1 (tournament.html), challenge is
 * accepted, then player disconnects and re-registers on connection 2
 * (game page). The server should re-send tournament state and the
 * match should work on the new connection.
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

runTest('e2e: reconnect — game page re-registration preserves tournament', async () => {
	const server = await startServer({ readyRateLimitMs: 0 });
	try {
		// ── Phase 1: Both register on "tournament.html" connections ──
		const alice1 = makePlayer(server.url, 'alice_rc');
		const bob1 = makePlayer(server.url, 'bob_rc');

		await alice1.client.connect();
		await bob1.client.connect();
		alice1.client.register();
		bob1.client.register();
		await alice1.waitRegistered();
		await bob1.waitRegistered();

		// Alice challenges Bob
		alice1.client.challenge('bob_rc');
		const ch = await bob1.waitChallengeReceived();
		bob1.client.acceptChallenge(ch.challengeId);

		// Both get assigned
		await alice1.waitTournamentAssigned();
		await bob1.waitTournamentAssigned();

		// ── Phase 2: Simulate page redirect ──
		// In reality, location.href = dev.html causes:
		// 1. New page loads → new WS connects → registers
		// 2. Old page's WS closes shortly after
		// So the new connection registers BEFORE the old one closes.
		const alice2 = makePlayer(server.url, 'alice_rc');
		const bob2 = makePlayer(server.url, 'bob_rc');

		await alice2.client.connect();
		await bob2.client.connect();

		// Re-register with the same nametags (while old connections still open)
		alice2.client.register();
		bob2.client.register();
		await alice2.waitRegistered();
		await bob2.waitRegistered();

		// NOW close the old connections (simulating browser cleanup)
		alice1.client.disconnect();
		bob1.client.disconnect();
		await sleep(100);

		// ── Phase 3: Should receive tournament state on re-registration ──
		// Server should re-send tournament-assigned + round-open
		const alice2RO = await alice2.waitRoundOpen();
		const bob2RO = await bob2.waitRoundOpen();
		assertEqual(alice2RO.matchId, bob2RO.matchId, 'same matchId after reconnect');

		// No errors from re-registration
		assertEqual(alice2.errors.length, 0, `alice2 errors: ${alice2.errors.join('; ')}`);
		assertEqual(bob2.errors.length, 0, `bob2 errors: ${bob2.errors.join('; ')}`);

		// ── Phase 4: Play the match on the new connections ──
		alice2.client.ready(alice2RO.matchId);
		bob2.client.ready(bob2RO.matchId);

		const [aStart, bStart] = await Promise.all([
			alice2.waitMatchStart(),
			bob2.waitMatchStart(),
		]);
		assertEqual(aStart.seed, bStart.seed, 'same seed');

		// Exchange inputs on the NEW connections — this is the critical test
		alice2.client.sendInput(alice2RO.matchId, 10, btoa('up'));
		alice2.client.sendInput(alice2RO.matchId, 20, btoa('left'));
		bob2.client.sendInput(bob2RO.matchId, 15, btoa('right'));

		await sleep(200);

		assert(bob2.opponentInputCount >= 2, `bob should have received alice's inputs, got ${bob2.opponentInputCount}`);
		assert(alice2.opponentInputCount >= 1, `alice should have received bob's input, got ${alice2.opponentInputCount}`);

		alice2.client.disconnect();
		bob2.client.disconnect();
	} finally {
		await stopServer(server.proc);
	}
});
