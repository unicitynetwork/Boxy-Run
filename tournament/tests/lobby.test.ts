/**
 * Lobby flow: two players join, both observe a roster containing
 * both of them, a third joiner with a duplicate nametag is rejected.
 */

import {
	assert,
	assertEqual,
	connectClient,
	runTest,
	startServer,
	stopServer,
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

runTest('lobby join + duplicate-nametag rejection', async () => {
	const server = await startServer();
	try {
		const alice = await connectClient(server.url);
		alice.send(joinMessage('@alice'));
		const aliceLobby1 = await alice.nextMessage('lobby-state');
		assertEqual(aliceLobby1.players.length, 1, 'alice-only lobby size');
		assertEqual(aliceLobby1.players[0].nametag, '@alice', 'alice nametag');
		assertEqual(aliceLobby1.capacity, 32, 'capacity');
		assertEqual(aliceLobby1.startsAt, null, 'startsAt still null');

		const bob = await connectClient(server.url);
		bob.send(joinMessage('@bob'));

		// Both alice and bob should receive a lobby-state containing both
		const aliceLobby2 = await alice.nextMessage('lobby-state');
		const bobLobby1 = await bob.nextMessage('lobby-state');
		const aliceNames = aliceLobby2.players.map((p) => p.nametag).sort();
		const bobNames = bobLobby1.players.map((p) => p.nametag).sort();
		assertEqual(aliceNames, ['@alice', '@bob'], 'alice sees both');
		assertEqual(bobNames, ['@alice', '@bob'], 'bob sees both');

		// Third client with duplicate '@alice' nametag — should be rejected
		const clash = await connectClient(server.url);
		clash.send(joinMessage('@alice'));
		const err = await clash.nextMessage('error');
		assertEqual(err.code, 'duplicate_nametag', 'duplicate rejected');

		alice.close();
		bob.close();
		clash.close();
	} finally {
		await stopServer(server.proc);
	}
});
