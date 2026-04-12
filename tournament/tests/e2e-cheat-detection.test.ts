/**
 * Cheat detection: the server replays both sims from the input trace.
 * If a player's inputs violate the rules (impossible rate, invalid
 * ticks), they get DQ'd and the opponent wins.
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

runTest('e2e: cheat detection — DQ for impossible input rate', async () => {
	const server = await startServer({ readyRateLimitMs: 0 });
	try {
		const alice = makePlayer(server.url, 'alice_cheat');
		const bob = makePlayer(server.url, 'bob_cheat');

		await alice.client.connect();
		await bob.client.connect();
		alice.client.register();
		bob.client.register();
		await alice.waitRegistered();
		await bob.waitRegistered();

		alice.client.challenge('bob_cheat');
		const ch = await bob.waitChallengeReceived();
		bob.client.acceptChallenge(ch.challengeId);

		const aRO = await alice.waitRoundOpen();
		await bob.waitRoundOpen();

		alice.client.ready(aRO.matchId);
		bob.client.ready(aRO.matchId);
		await alice.waitMatchStart();
		await bob.waitMatchStart();

		// ── Alice plays normally ──
		alice.client.sendInput(aRO.matchId, 60, btoa('up'));
		alice.client.sendInput(aRO.matchId, 120, btoa('left'));
		alice.client.sendInput(aRO.matchId, 180, btoa('right'));

		// ── Bob cheats: flood inputs at the same tick (>3 per tick) ──
		for (let i = 0; i < 10; i++) {
			bob.client.sendInput(aRO.matchId, 50, btoa('up'));
		}

		await sleep(300);

		// Both submit results
		alice.client.submitResult(aRO.matchId, 500, { A: 5000 }, 'A', 'h', 'r');
		bob.client.submitResult(aRO.matchId, 500, { B: 9000 }, 'B', 'h', 'r');

		// Server should DQ Bob despite Bob reporting higher score
		const aEnd = await alice.waitMatchEnd();
		const bEnd = await bob.waitMatchEnd();

		assertEqual(aEnd.reason, 'dq', 'match resolved as DQ');
		assertEqual(aEnd.winner, 'alice_cheat', 'alice wins because bob was DQ\'d');
		assertEqual(bEnd.reason, 'dq', 'bob also sees DQ');

		alice.client.disconnect();
		bob.client.disconnect();
	} finally {
		await stopServer(server.proc);
	}
});
