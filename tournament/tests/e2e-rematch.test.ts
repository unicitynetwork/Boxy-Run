/**
 * End-to-end rematch: play a full challenge match, then one player
 * sends a rematch (new challenge) from the same connection. The
 * server should clean up the old tournament and create a new one.
 * Covers the exact flow when a player clicks REMATCH in the game.
 */

import {
	assertEqual,
	runTest,
	sleep,
	startServer,
	stopServer,
} from './harness';
import { makePlayer } from './e2e-helpers';

async function playOneMatch(alice: ReturnType<typeof makePlayer>, bob: ReturnType<typeof makePlayer>, matchNum: number) {
	// Alice challenges Bob
	alice.client.challenge('bob_rematch');
	const ch = await bob.waitChallengeReceived();
	bob.client.acceptChallenge(ch.challengeId);

	// Both get assigned
	const [aAssign, bAssign] = await Promise.all([
		alice.waitTournamentAssigned(),
		bob.waitTournamentAssigned(),
	]);
	assertEqual(aAssign.tournamentId, bAssign.tournamentId, `match ${matchNum}: same tournament`);

	// Both get round-open
	const [aRO, bRO] = await Promise.all([
		alice.waitRoundOpen(),
		bob.waitRoundOpen(),
	]);
	assertEqual(aRO.matchId, bRO.matchId, `match ${matchNum}: same matchId`);

	// Both ready
	alice.client.ready(aRO.matchId);
	bob.client.ready(bRO.matchId);

	// Match starts
	const [aStart, bStart] = await Promise.all([
		alice.waitMatchStart(),
		bob.waitMatchStart(),
	]);
	assertEqual(aStart.seed, bStart.seed, `match ${matchNum}: same seed`);

	// Submit matching results
	const result = {
		finalTick: 300 + matchNum * 100,
		score: { A: 5000 + matchNum * 1000, B: 3000 } as Record<string, number>,
		winner: 'A' as const,
		inputsHash: `h${matchNum}`,
		resultHash: `r${matchNum}`,
	};
	alice.client.submitResult(aRO.matchId, result.finalTick, result.score, result.winner, result.inputsHash, result.resultHash);
	bob.client.submitResult(bRO.matchId, result.finalTick, result.score, result.winner, result.inputsHash, result.resultHash);

	// Tournament ends
	const [aEnd, bEnd] = await Promise.all([
		alice.waitTournamentEnd(),
		bob.waitTournamentEnd(),
	]);
	assertEqual(aEnd.standings.length, 2, `match ${matchNum}: standings`);

	return { tournamentId: aAssign.tournamentId };
}

runTest('e2e: rematch — play 3 consecutive matches without reconnecting', async () => {
	const server = await startServer({ readyRateLimitMs: 0 });
	try {
		const alice = makePlayer(server.url, 'alice_rematch');
		const bob = makePlayer(server.url, 'bob_rematch');

		await alice.client.connect();
		await bob.client.connect();
		alice.client.register();
		bob.client.register();
		await alice.waitRegistered();
		await bob.waitRegistered();

		// Play 3 matches in a row on the same connections
		const ids: string[] = [];
		for (let i = 1; i <= 3; i++) {
			const { tournamentId } = await playOneMatch(alice, bob, i);
			ids.push(tournamentId);
			// Small delay between matches
			await sleep(100);
		}

		// All tournament IDs should be different
		assertEqual(new Set(ids).size, 3, 'three different tournament IDs');

		// No errors throughout
		assertEqual(alice.errors.length, 0, `alice errors: ${alice.errors.join('; ')}`);
		assertEqual(bob.errors.length, 0, `bob errors: ${bob.errors.join('; ')}`);

		alice.client.disconnect();
		bob.client.disconnect();
	} finally {
		await stopServer(server.proc);
	}
});
