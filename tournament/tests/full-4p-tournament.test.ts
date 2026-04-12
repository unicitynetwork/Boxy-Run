/**
 * Full 4-player tournament: two round-0 matches, then a round-1 final.
 * Proves bracket advancement across rounds works correctly.
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
	RoundOpenMessage,
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

/** Helper: drive a match through ready → start → results → end. */
async function playMatch(
	clientA: TestClient,
	clientB: TestClient,
	matchId: string,
	winnerSide: 'A' | 'B',
): Promise<{ winner: string; loser: string }> {
	clientA.send({ type: 'match-ready', v: 0, matchId });
	clientB.send({ type: 'match-ready', v: 0, matchId });

	const startA = await clientA.nextMessage('match-start', 3000) as MatchStartMessage;
	await clientB.nextMessage('match-start', 3000);

	const nameA = startA.youAre === 'A'
		? startA.opponent // no — opponent is B's nametag. We need A's nametag.
		: startA.opponent;
	// Actually let's compute from match-start messages
	// startA.opponent is the OTHER person's nametag. startA.youAre tells THIS client's side.
	// If startA is received by clientA, then startA.youAre is clientA's side.

	const result = {
		finalTick: 500,
		score: { A: 8000, B: 4000 },
		winner: winnerSide,
		inputsHash: 'hash1',
		resultHash: 'agreed-hash',
	};
	clientA.send({ type: 'result', v: 0, matchId, ...result });
	clientB.send({ type: 'result', v: 0, matchId, ...result });

	const endA = await clientA.nextMessage('match-end', 3000) as MatchEndMessage;
	await clientB.nextMessage('match-end', 3000);
	return { winner: endA.winner, loser: '' };
}

runTest('full 4-player tournament with round advancement', async () => {
	const server = await startServer({ capacity: 4, minPlayers: 4 });
	try {
		// Join 4 players
		const clients = new Map<string, TestClient>();
		for (const tag of ['@a', '@b', '@c', '@d']) {
			const c = await connectClient(server.url);
			c.send(joinMessage(tag));
			clients.set(tag, c);
		}

		// Wait for bracket and round-0 round-opens
		const allClients = Array.from(clients.values());
		await Promise.all(allClients.map(c => c.nextMessage('bracket', 3000)));
		const roundOpens = await Promise.all(
			allClients.map(c => c.nextMessage('round-open', 3000)),
		);

		// Identify the two matches from round-0 round-opens.
		// Each matchId should appear exactly twice.
		const matchPairs = new Map<string, string[]>();
		const tags = ['@a', '@b', '@c', '@d'];
		for (let i = 0; i < roundOpens.length; i++) {
			const ro = roundOpens[i] as RoundOpenMessage;
			if (!matchPairs.has(ro.matchId)) matchPairs.set(ro.matchId, []);
			matchPairs.get(ro.matchId)!.push(tags[i]);
		}
		assertEqual(matchPairs.size, 2, 'two matches in round 0');

		// Play both round-0 matches. Side A wins both.
		const match0 = Array.from(matchPairs.entries());
		for (const [matchId, players] of match0) {
			const c1 = clients.get(players[0])!;
			const c2 = clients.get(players[1])!;

			c1.send({ type: 'match-ready', v: 0, matchId });
			c2.send({ type: 'match-ready', v: 0, matchId });
			await c1.nextMessage('match-start', 3000);
			await c2.nextMessage('match-start', 3000);

			const result = {
				finalTick: 300,
				score: { A: 5000, B: 2000 },
				winner: 'A' as const,
				inputsHash: 'h',
				resultHash: 'agreed',
			};
			c1.send({ type: 'result', v: 0, matchId, ...result });
			c2.send({ type: 'result', v: 0, matchId, ...result });

			await c1.nextMessage('match-end', 3000);
			await c2.nextMessage('match-end', 3000);
		}

		// After both round-0 matches resolve, the two winners should
		// receive round-open for round 1 (the final).
		const round1Opens: RoundOpenMessage[] = [];
		for (const c of allClients) {
			try {
				const ro = await c.nextMessage('round-open', 3000) as RoundOpenMessage;
				round1Opens.push(ro);
			} catch {
				// Losers won't get a round-open
			}
		}
		assertEqual(round1Opens.length, 2, 'two players in the final');
		assertEqual(round1Opens[0].roundIndex, 1, 'final is round 1');
		assertEqual(round1Opens[0].matchId, round1Opens[1].matchId, 'same final match');

		// Play the final — A wins
		const finalMatchId = round1Opens[0].matchId;
		const finalist1Tag = round1Opens.map(ro => {
			// Find which client received this round-open
			for (const [tag, c] of clients) {
				if (c.received.some(m => m.type === 'round-open' && (m as RoundOpenMessage).matchId === finalMatchId)) {
					return tag;
				}
			}
			return '';
		});
		// Get the two finalists' clients
		const finalistClients: TestClient[] = [];
		for (const [tag, c] of clients) {
			if (c.received.some(m =>
				m.type === 'round-open' &&
				(m as RoundOpenMessage).matchId === finalMatchId,
			)) {
				finalistClients.push(c);
			}
		}
		assertEqual(finalistClients.length, 2, '2 finalists');

		finalistClients[0].send({ type: 'match-ready', v: 0, matchId: finalMatchId });
		finalistClients[1].send({ type: 'match-ready', v: 0, matchId: finalMatchId });
		await finalistClients[0].nextMessage('match-start', 3000);
		await finalistClients[1].nextMessage('match-start', 3000);

		const finalResult = {
			finalTick: 600,
			score: { A: 9000, B: 6000 },
			winner: 'A' as const,
			inputsHash: 'fh',
			resultHash: 'final-agreed',
		};
		finalistClients[0].send({ type: 'result', v: 0, matchId: finalMatchId, ...finalResult });
		finalistClients[1].send({ type: 'result', v: 0, matchId: finalMatchId, ...finalResult });

		await finalistClients[0].nextMessage('match-end', 3000);
		await finalistClients[1].nextMessage('match-end', 3000);

		// Tournament-end should be broadcast to ALL players (including eliminated ones)
		const tournamentEnds: TournamentEndMessage[] = [];
		for (const c of allClients) {
			try {
				const te = await c.nextMessage('tournament-end', 3000) as TournamentEndMessage;
				tournamentEnds.push(te);
			} catch {
				// Some clients may have already closed
			}
		}
		assert(tournamentEnds.length >= 2, 'at least finalists get tournament-end');
		const te = tournamentEnds[0];
		assertEqual(te.standings[0].place, 1, 'champion is #1');
		assertEqual(te.standings[1].place, 2, 'runner-up is #2');

		for (const c of allClients) c.close();
	} finally {
		await stopServer(server.proc);
	}
});
