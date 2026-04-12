/**
 * End-to-end nametag format test: wallet-style nametags (no @ prefix,
 * numeric, underscores) should work identically to dev-mode @-prefixed
 * nametags. Covers the exact nametag formats seen from Sphere wallets.
 */

import {
	assertEqual,
	runTest,
	startServer,
	stopServer,
} from './harness';
import { makePlayer } from './e2e-helpers';

async function testChallenge(url: string, nameA: string, nameB: string, label: string) {
	const a = makePlayer(url, nameA);
	const b = makePlayer(url, nameB);

	await a.client.connect();
	await b.client.connect();
	a.client.register();
	b.client.register();
	await a.waitRegistered();
	await b.waitRegistered();

	// A challenges B using B's exact nametag
	a.client.challenge(nameB);
	const ch = await b.waitChallengeReceived();
	assertEqual(ch.from, nameA, `${label}: challenge from correct sender`);

	b.client.acceptChallenge(ch.challengeId);
	const [aAssign, bAssign] = await Promise.all([
		a.waitTournamentAssigned(),
		b.waitTournamentAssigned(),
	]);
	assertEqual(aAssign.tournamentId, bAssign.tournamentId, `${label}: same tournament`);

	const [aRO, bRO] = await Promise.all([
		a.waitRoundOpen(),
		b.waitRoundOpen(),
	]);
	assertEqual(aRO.opponent, nameB, `${label}: A sees B's nametag`);
	assertEqual(bRO.opponent, nameA, `${label}: B sees A's nametag`);

	assertEqual(a.errors.length, 0, `${label} A errors: ${a.errors.join('; ')}`);
	assertEqual(b.errors.length, 0, `${label} B errors: ${b.errors.join('; ')}`);

	a.client.disconnect();
	b.client.disconnect();
}

runTest('e2e: nametag formats — wallet-style and dev-style both work', async () => {
	const server = await startServer({ readyRateLimitMs: 0 });
	try {
		// Numeric nametag (like Sphere wallet chainPubkey)
		await testChallenge(server.url, '84883834834', '99912345678', 'numeric');

		// Underscore nametag (like Sphere wallet agent names)
		await testChallenge(server.url, 'mike_agent1', 'bob_agent2', 'underscore');

		// With @ prefix (dev mode)
		await testChallenge(server.url, '@alice', '@bob', 'at-prefix');

		// Mixed: one wallet-style, one dev-style
		await testChallenge(server.url, 'wallet_user', '@dev_user', 'mixed');
	} finally {
		await stopServer(server.proc);
	}
});
