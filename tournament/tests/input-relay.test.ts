/**
 * Input relay: during an active match, each player's input message
 * is relayed to the opponent as opponent-input with the same tick
 * and payload.
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

import type { JoinMessage, MatchStartMessage, OpponentInputMessage } from '../protocol/messages';

function joinMessage(nametag: string): JoinMessage {
	return {
		type: 'join', v: 0,
		tournamentId: 'boxyrun-alpha-1',
		identity: { nametag, pubkey: nametag.replace('@', '') + '00'.repeat(31) },
		entry: { txHash: 'stub', amount: '10', coinId: 'stub' },
		signature: 'stub',
	};
}

async function setupActiveMatch(serverUrl: string): Promise<{
	alice: TestClient;
	bob: TestClient;
	matchId: string;
	aliceStart: MatchStartMessage;
	bobStart: MatchStartMessage;
}> {
	const alice = await connectClient(serverUrl);
	const bob = await connectClient(serverUrl);
	alice.send(joinMessage('@alice'));
	bob.send(joinMessage('@bob'));

	const aliceRO = await alice.nextMessage('round-open', 3000);
	await bob.nextMessage('round-open', 3000);
	const matchId = aliceRO.matchId;

	alice.send({ type: 'match-ready', v: 0, matchId });
	bob.send({ type: 'match-ready', v: 0, matchId });

	const aliceStart = await alice.nextMessage('match-start', 3000);
	const bobStart = await bob.nextMessage('match-start', 3000);

	return { alice, bob, matchId, aliceStart, bobStart };
}

runTest('input relay during active match', async () => {
	const server = await startServer({ capacity: 2, minPlayers: 2 });
	try {
		const { alice, bob, matchId } = await setupActiveMatch(server.url);

		// Alice sends an input — bob should receive opponent-input
		alice.send({
			type: 'input', v: 0,
			matchId,
			tick: 42,
			payload: 'dXA=', // base64 of "up"
		});
		const bobInput = await bob.nextMessage('opponent-input', 2000) as OpponentInputMessage;
		assertEqual(bobInput.matchId, matchId);
		assertEqual(bobInput.tick, 42);
		assertEqual(bobInput.payload, 'dXA=');

		// Bob sends an input — alice should receive opponent-input
		bob.send({
			type: 'input', v: 0,
			matchId,
			tick: 50,
			payload: 'bGVmdA==', // base64 of "left"
		});
		const aliceInput = await alice.nextMessage('opponent-input', 2000) as OpponentInputMessage;
		assertEqual(aliceInput.matchId, matchId);
		assertEqual(aliceInput.tick, 50);
		assertEqual(aliceInput.payload, 'bGVmdA==');

		alice.close();
		bob.close();
	} finally {
		await stopServer(server.proc);
	}
});
