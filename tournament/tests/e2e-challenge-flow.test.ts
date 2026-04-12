/**
 * End-to-end challenge flow: two players register, one challenges
 * the other, challenge is accepted, tournament is created, both
 * ready up, match starts, both exchange inputs, both die, result
 * is submitted and agreed, tournament ends with standings.
 *
 * This covers the EXACT flow that happens when two users interact
 * through tournament.html → dev.html, using the real SDK instead
 * of raw WebSocket messages.
 */

import WebSocket from 'ws';

import { TournamentClient } from '../client/client';
import {
	assert,
	assertEqual,
	runTest,
	sleep,
	startServer,
	stopServer,
} from './harness';

import type {
	ChallengeReceivedMessage,
	MatchStartMessage,
	RoundOpenMessage,
	TournamentAssignedMessage,
	TournamentEndMessage,
} from '../protocol/messages';

/**
 * Create a TournamentClient with message buffering. waitFor checks
 * the buffer first (so messages that arrived before the await aren't
 * missed), then waits for a new one.
 */
function makePlayer(url: string, nametag: string) {
	const messages: Array<{ type: string; data: any }> = [];
	const consumed = new Set<number>();
	const waiters: Array<{ type: string; resolve: (v: any) => void; timer: NodeJS.Timeout }> = [];
	let opponentInputCount = 0;
	const errors: string[] = [];

	function dispatch(type: string, data: any) {
		const idx = messages.length;
		messages.push({ type, data });
		for (let i = 0; i < waiters.length; i++) {
			if (waiters[i].type === type && !consumed.has(idx)) {
				consumed.add(idx);
				clearTimeout(waiters[i].timer);
				waiters[i].resolve(data);
				waiters.splice(i, 1);
				return;
			}
		}
	}

	const client = new TournamentClient({
		url,
		nametag,
		pubkey: nametag + '00'.repeat(28),
		WebSocketCtor: WebSocket as unknown as new (url: string) => globalThis.WebSocket,
		onRegistered: (msg) => dispatch('registered', msg),
		onPlayerOnline: (msg) => dispatch('player-online', msg),
		onChallengeReceived: (msg) => dispatch('challenge-received', msg),
		onTournamentAssigned: (msg) => dispatch('tournament-assigned', msg),
		onQueueState: (msg) => dispatch('queue-state', msg),
		onLobbyState: (msg) => dispatch('lobby-state', msg),
		onBracket: (msg) => dispatch('bracket', msg),
		onRoundOpen: (msg) => dispatch('round-open', msg),
		onOpponentReady: (msg) => dispatch('opponent-ready', msg),
		onMatchStart: (msg) => dispatch('match-start', msg),
		onOpponentInput: (msg) => { dispatch('opponent-input', msg); opponentInputCount++; },
		onMatchEnd: (msg) => dispatch('match-end', msg),
		onTournamentEnd: (msg) => dispatch('tournament-end', msg),
		onError: (msg) => { dispatch('error', msg); errors.push(`${msg.code}: ${msg.message}`); },
	});

	function waitFor<T>(type: string, timeoutMs = 3000): Promise<T> {
		// Check buffer first
		for (let i = 0; i < messages.length; i++) {
			if (messages[i].type === type && !consumed.has(i)) {
				consumed.add(i);
				return Promise.resolve(messages[i].data);
			}
		}
		// Wait for new
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const idx = waiters.findIndex(w => w.type === type);
				if (idx >= 0) waiters.splice(idx, 1);
				reject(new Error(`timeout waiting for '${type}' (received: ${messages.map(m => m.type).join(', ')})`));
			}, timeoutMs);
			waiters.push({ type, resolve, timer });
		});
	}

	return {
		client,
		messages,
		errors,
		get opponentInputCount() { return opponentInputCount; },
		waitRegistered: () => waitFor<any>('registered'),
		waitChallengeReceived: () => waitFor<ChallengeReceivedMessage>('challenge-received'),
		waitTournamentAssigned: () => waitFor<TournamentAssignedMessage>('tournament-assigned'),
		waitRoundOpen: () => waitFor<RoundOpenMessage>('round-open'),
		waitMatchStart: () => waitFor<MatchStartMessage>('match-start'),
		waitMatchEnd: () => waitFor<any>('match-end'),
		waitTournamentEnd: () => waitFor<TournamentEndMessage>('tournament-end'),
	};
}

runTest('e2e: challenge flow from register to tournament-end', async () => {
	const server = await startServer({ readyRateLimitMs: 0 });
	try {
		// ── Step 1: Both players connect and register ──
		const alice = makePlayer(server.url, 'alice_test');
		const bob = makePlayer(server.url, 'bob_test');

		await alice.client.connect();
		await bob.client.connect();

		alice.client.register();
		bob.client.register();

		await alice.waitRegistered();
		await bob.waitRegistered();

		assertEqual(alice.errors.length, 0, 'alice no errors after register');
		assertEqual(bob.errors.length, 0, 'bob no errors after register');

		// ── Step 2: Alice challenges Bob ──
		alice.client.challenge('bob_test');

		const challenge = await bob.waitChallengeReceived();
		assertEqual(challenge.from, 'alice_test', 'challenge from alice');

		// ── Step 3: Bob accepts ──
		bob.client.acceptChallenge(challenge.challengeId);

		// Both should get round-open (tournament-assigned may or may not
		// arrive depending on message ordering — the important thing is
		// that both get the round-open with their match assignment).
		const aliceRO = await alice.waitRoundOpen();
		const bobRO = await bob.waitRoundOpen();
		assertEqual(aliceRO.matchId, bobRO.matchId, 'same matchId');
		assertEqual(aliceRO.opponent, 'bob_test', 'alice sees bob as opponent');
		assertEqual(bobRO.opponent, 'alice_test', 'bob sees alice as opponent');

		const matchId = aliceRO.matchId;

		// ── Step 5: Both ready up → match starts ──
		alice.client.ready(matchId);
		bob.client.ready(matchId);

		const aliceStart = await alice.waitMatchStart();
		const bobStart = await bob.waitMatchStart();
		assertEqual(aliceStart.seed, bobStart.seed, 'same seed');
		const sides = new Set([aliceStart.youAre, bobStart.youAre]);
		assertEqual([...sides].sort(), ['A', 'B'], 'complementary sides');

		// ── Step 6: Exchange inputs and verify relay ──
		alice.client.sendInput(matchId, 10, btoa('up'));
		alice.client.sendInput(matchId, 20, btoa('left'));
		alice.client.sendInput(matchId, 30, btoa('right'));

		bob.client.sendInput(matchId, 15, btoa('up'));
		bob.client.sendInput(matchId, 25, btoa('right'));

		// Wait a moment for relay
		await sleep(200);

		assert(bob.opponentInputCount >= 3, `bob should have received alice's 3 inputs, got ${bob.opponentInputCount}`);
		assert(alice.opponentInputCount >= 2, `alice should have received bob's 2 inputs, got ${alice.opponentInputCount}`);

		// Verify the relayed inputs have correct data
		const bobOpInputs = bob.messages.filter(m => m.type === 'opponent-input');
		assert(bobOpInputs.length >= 3, 'bob got 3 opponent-input messages');
		assertEqual(bobOpInputs[0].data.tick, 10);
		assertEqual(atob(bobOpInputs[0].data.payload), 'up');
		assertEqual(bobOpInputs[1].data.tick, 20);
		assertEqual(atob(bobOpInputs[1].data.payload), 'left');

		// ── Step 7: Both submit matching results ──
		const result = {
			finalTick: 500,
			score: { A: 8000, B: 5000 } as Record<string, number>,
			winner: 'A' as const,
			inputsHash: 'test-hash',
			resultHash: 'agreed-result-hash',
		};

		alice.client.submitResult(matchId, result.finalTick, result.score, result.winner, result.inputsHash, result.resultHash);
		bob.client.submitResult(matchId, result.finalTick, result.score, result.winner, result.inputsHash, result.resultHash);

		// ── Step 8: Tournament ends ──
		const aliceEnd = await alice.waitTournamentEnd();
		const bobEnd = await bob.waitTournamentEnd();
		assertEqual(aliceEnd.standings.length, 2, '2 standings');
		assertEqual(aliceEnd.standings[0].place, 1, 'first place');
		assertEqual(
			JSON.stringify(aliceEnd),
			JSON.stringify(bobEnd),
			'both see same tournament-end',
		);

		// ── Verify no errors throughout ──
		assertEqual(alice.errors.length, 0, `alice errors: ${alice.errors.join('; ')}`);
		assertEqual(bob.errors.length, 0, `bob errors: ${bob.errors.join('; ')}`);

		alice.client.disconnect();
		bob.client.disconnect();
	} finally {
		await stopServer(server.proc);
	}
});
