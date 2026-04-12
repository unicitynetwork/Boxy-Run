/**
 * When the lobby reaches MIN_PLAYERS, the tournament auto-starts:
 * - bracket is broadcast to everyone
 * - round-open is sent to each paired player (with the opponent's
 *   nametag, roundIndex=0, and matching deadline)
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

import type { JoinMessage } from '../protocol/messages';

function joinMessage(nametag: string): JoinMessage {
	return {
		type: 'join',
		v: 0,
		tournamentId: 'boxyrun-alpha-1',
		identity: { nametag, pubkey: '00'.repeat(32) },
		entry: { txHash: 'stub', amount: '10', coinId: 'stub' },
		signature: 'stub',
	};
}

async function joinAs(
	url: string,
	nametag: string,
): Promise<TestClient> {
	const c = await connectClient(url);
	c.send(joinMessage(nametag));
	return c;
}

runTest('tournament auto-starts when lobby hits min players', async () => {
	// 4-player tournament, start immediately on fill
	const server = await startServer({ capacity: 4, minPlayers: 4 });
	try {
		const clients: TestClient[] = [];
		for (const tag of ['@a', '@b', '@c', '@d']) {
			clients.push(await joinAs(server.url, tag));
		}

		// Every client should receive a bracket and a round-open
		const brackets = await Promise.all(
			clients.map((c) => c.nextMessage('bracket', 3000)),
		);
		for (const b of brackets) {
			assertEqual(b.tournamentId, 'boxyrun-alpha-1');
			assertEqual(b.rounds.length, 2, '4 players → 2 rounds');
			assertEqual(b.rounds[0].length, 2, 'round 0 has 2 matches');
			assertEqual(b.rounds[1].length, 1, 'round 1 has 1 match');
		}

		// Each player should receive exactly one round-open for their match
		const roundOpens = await Promise.all(
			clients.map((c) => c.nextMessage('round-open', 3000)),
		);
		for (const ro of roundOpens) {
			assertEqual(ro.roundIndex, 0);
			assert(typeof ro.opponent === 'string' && ro.opponent.startsWith('@'), 'has opponent');
			assert(ro.openedAt > 0, 'has openedAt');
			assert(ro.deadline > ro.openedAt, 'deadline after openedAt');
		}

		// Check that the pairings are reciprocal: @a's opponent must
		// name @a as their opponent too.
		const pairings = new Map<string, string>();
		const clientNames = ['@a', '@b', '@c', '@d'];
		for (let i = 0; i < clients.length; i++) {
			pairings.set(clientNames[i], roundOpens[i].opponent);
		}
		for (const [me, opponent] of pairings) {
			assertEqual(
				pairings.get(opponent),
				me,
				`${me}'s opponent ${opponent} should have ${me} as their opponent`,
			);
		}

		for (const c of clients) c.close();
	} finally {
		await stopServer(server.proc);
	}
});
