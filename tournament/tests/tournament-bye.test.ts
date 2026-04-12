/**
 * 3-player tournament: bracket has 2 matches in round 0 (1 bye,
 * 1 real), and the round-0 bye should be auto-resolved so that
 * only the real match gets a round-open message. No round-open
 * should ever be sent for a match where one side is null.
 */

import {
	assert,
	assertEqual,
	connectClient,
	runTest,
	sleep,
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

runTest('3-player tournament handles bye in round 0', async () => {
	const server = await startServer({ capacity: 3, minPlayers: 3 });
	try {
		const clients: TestClient[] = [];
		for (const tag of ['@a', '@b', '@c']) {
			const c = await connectClient(server.url);
			c.send(joinMessage(tag));
			clients.push(c);
		}

		// All three players should receive a bracket with 2 rounds
		const brackets = await Promise.all(
			clients.map((c) => c.nextMessage('bracket', 3000)),
		);
		for (const b of brackets) {
			assertEqual(b.rounds.length, 2, 'N=3 → 2 rounds');
			assertEqual(b.rounds[0].length, 2, 'round 0 has 2 matches');
			assertEqual(b.rounds[1].length, 1, 'round 1 is the final');
		}

		// Round 0 should have exactly 1 bye match and 1 real match.
		// The bye auto-resolves so the bye player propagates to round 1
		// but does not receive a round-open (that comes when round 1 opens).
		const r0 = brackets[0].rounds[0];
		let byeCount = 0;
		let realCount = 0;
		for (const slot of r0) {
			if (slot.playerA === null || slot.playerB === null) byeCount++;
			else realCount++;
		}
		assertEqual(byeCount, 1, '1 bye in round 0');
		assertEqual(realCount, 1, '1 real match in round 0');

		// Only two players should receive a round-open (the two in the
		// real match). The bye player just sees the bracket propagation.
		// Use a brief sleep so any erroneous round-open has a chance to
		// arrive before we assert on absence.
		await sleep(200);

		const withRoundOpen = clients.filter((c) =>
			c.received.some((m) => m.type === 'round-open'),
		);
		assertEqual(
			withRoundOpen.length,
			2,
			'exactly two clients got round-open (the two in the real match)',
		);

		for (const c of clients) c.close();
	} finally {
		await stopServer(server.proc);
	}
});
