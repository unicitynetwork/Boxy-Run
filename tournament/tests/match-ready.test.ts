/**
 * Match ready flow: two players join a 2-player tournament, both
 * click ready, and both receive match-start with the same seed
 * and complementary youAre values (A vs B).
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
		identity: { nametag, pubkey: nametag.replace('@', '') + '00'.repeat(31) },
		entry: { txHash: 'stub', amount: '10', coinId: 'stub' },
		signature: 'stub',
	};
}

runTest('match-ready → match-start flow', async () => {
	const server = await startServer({ capacity: 2, minPlayers: 2 });
	try {
		const alice = await connectClient(server.url);
		const bob = await connectClient(server.url);
		alice.send(joinMessage('@alice'));
		bob.send(joinMessage('@bob'));

		// Wait for round-open so we know the match ID
		const aliceRO = await alice.nextMessage('round-open', 3000);
		const bobRO = await bob.nextMessage('round-open', 3000);
		assertEqual(aliceRO.matchId, bobRO.matchId, 'same match ID');
		const matchId = aliceRO.matchId;

		// Alice clicks ready — bob should receive opponent-ready
		alice.send({ type: 'match-ready', v: 0, matchId });
		const bobReady = await bob.nextMessage('opponent-ready', 2000);
		assertEqual(bobReady.matchId, matchId);
		assertEqual(bobReady.ready, true);

		// Bob clicks ready — both should receive match-start
		bob.send({ type: 'match-ready', v: 0, matchId });
		const aliceStart = await alice.nextMessage('match-start', 2000);
		const bobStart = await bob.nextMessage('match-start', 2000);

		// Same seed for both
		assertEqual(aliceStart.seed, bobStart.seed, 'same seed');
		assert(aliceStart.seed.length > 0, 'seed is non-empty');

		// Complementary sides (bracket shuffle may assign either player to A or B)
		const sides = new Set([aliceStart.youAre, bobStart.youAre]);
		assertEqual([...sides].sort(), ['A', 'B'], 'complementary sides');

		// Each sees the other as opponent
		assertEqual(aliceStart.opponent, '@bob');
		assertEqual(bobStart.opponent, '@alice');

		// startsAt is in the future (3-second countdown)
		assert(aliceStart.startsAt > Date.now() - 1000, 'startsAt is recent');
		assertEqual(aliceStart.startsAt, bobStart.startsAt, 'same startsAt');

		alice.close();
		bob.close();
	} finally {
		await stopServer(server.proc);
	}
});
