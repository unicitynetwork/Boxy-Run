/**
 * Full 2-player tournament end-to-end: lobby → bracket → ready →
 * match-start → input relay → result submission → match-end →
 * tournament-end with standings (champion + runner-up).
 */

import {
	assert,
	assertEqual,
	connectClient,
	runTest,
	startServer,
	stopServer,
	type TestClient,
} from './harness';

import type {
	JoinMessage,
	MatchEndMessage,
	MatchStartMessage,
	TournamentEndMessage,
} from '../protocol/messages';

function joinMessage(nametag: string): JoinMessage {
	return {
		type: 'join', v: 0,
		tournamentId: 'boxyrun-alpha-1',
		identity: { nametag, pubkey: nametag.replace('@', '') + '00'.repeat(31) },
		entry: { txHash: 'stub', amount: '10', coinId: 'stub' },
		signature: 'stub',
	};
}

runTest('full 2-player tournament from lobby to tournament-end', async () => {
	const server = await startServer({ capacity: 2, minPlayers: 2 });
	try {
		const alice = await connectClient(server.url);
		const bob = await connectClient(server.url);

		// Join
		alice.send(joinMessage('@alice'));
		bob.send(joinMessage('@bob'));

		// Tournament auto-starts: bracket + round-open
		await alice.nextMessage('bracket', 3000);
		const aliceRO = await alice.nextMessage('round-open', 3000);
		await bob.nextMessage('bracket', 3000);
		await bob.nextMessage('round-open', 3000);
		const matchId = aliceRO.matchId;

		// Both ready → match-start
		alice.send({ type: 'match-ready', v: 0, matchId });
		bob.send({ type: 'match-ready', v: 0, matchId });
		const aliceStart = await alice.nextMessage('match-start', 3000) as MatchStartMessage;
		const bobStart = await bob.nextMessage('match-start', 3000) as MatchStartMessage;
		assertEqual(aliceStart.seed, bobStart.seed, 'same seed');

		// Determine who is side A and who is side B
		const sideA = aliceStart.youAre === 'A' ? alice : bob;
		const sideB = aliceStart.youAre === 'A' ? bob : alice;
		const nameA = aliceStart.youAre === 'A' ? '@alice' : '@bob';
		const nameB = aliceStart.youAre === 'A' ? '@bob' : '@alice';

		// Exchange some inputs
		sideA.send({ type: 'input', v: 0, matchId, tick: 10, payload: 'anVtcA==' });
		sideB.send({ type: 'input', v: 0, matchId, tick: 15, payload: 'bGVmdA==' });
		await sideB.nextMessage('opponent-input', 2000);
		await sideA.nextMessage('opponent-input', 2000);

		// Both submit a matching result (A wins with score 9120)
		const sharedResult = {
			finalTick: 570,
			score: { A: 9120, B: 4000 },
			winner: 'A' as const,
			inputsHash: 'deadbeef',
			resultHash: 'matchinghash123',
		};

		sideA.send({ type: 'result', v: 0, matchId, ...sharedResult });
		sideB.send({ type: 'result', v: 0, matchId, ...sharedResult });

		// Both should receive match-end with the correct winner
		const aliceEnd = await alice.nextMessage('match-end', 3000) as MatchEndMessage;
		const bobEnd = await bob.nextMessage('match-end', 3000) as MatchEndMessage;
		assertEqual(aliceEnd.winner, nameA, 'A wins');
		assertEqual(bobEnd.winner, nameA, 'A wins (bob sees same)');
		assertEqual(aliceEnd.reason, 'death');

		// Tournament-end should follow (2-player = final was round 0)
		const aliceTEnd = await alice.nextMessage('tournament-end', 3000) as TournamentEndMessage;
		const bobTEnd = await bob.nextMessage('tournament-end', 3000) as TournamentEndMessage;
		assertEqual(aliceTEnd.standings.length, 2, 'champion + runner-up');
		assertEqual(aliceTEnd.standings[0].place, 1);
		assertEqual(aliceTEnd.standings[0].nametag, nameA, 'champion');
		assertEqual(aliceTEnd.standings[1].place, 2);
		assertEqual(aliceTEnd.standings[1].nametag, nameB, 'runner-up');
		assertEqual(
			JSON.stringify(aliceTEnd),
			JSON.stringify(bobTEnd),
			'both see same tournament-end',
		);

		alice.close();
		bob.close();
	} finally {
		await stopServer(server.proc);
	}
});
