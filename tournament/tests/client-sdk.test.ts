/**
 * Client SDK test: drive a 2-player tournament entirely through the
 * TournamentClient class (not raw WebSocket). Proves the SDK's typed
 * API produces the right protocol messages and correctly dispatches
 * callbacks.
 */

import WebSocket from 'ws';

import { TournamentClient } from '../client/client';
import {
	assert,
	assertEqual,
	runTest,
	startServer,
	stopServer,
} from './harness';

import type {
	LobbyStateMessage,
	MatchStartMessage,
	RoundOpenMessage,
	TournamentEndMessage,
} from '../protocol/messages';

function makeClient(url: string, nametag: string) {
	let lobbyState: LobbyStateMessage | null = null;
	let roundOpen: RoundOpenMessage | null = null;
	let matchStart: MatchStartMessage | null = null;
	let tournamentEnd: TournamentEndMessage | null = null;
	const errors: string[] = [];
	const resolvers: Array<{ type: string; resolve: () => void }> = [];

	function waitFor(type: string): Promise<void> {
		return new Promise((res) => resolvers.push({ type, resolve: res }));
	}
	function notify(type: string) {
		for (let i = resolvers.length - 1; i >= 0; i--) {
			if (resolvers[i].type === type) {
				resolvers[i].resolve();
				resolvers.splice(i, 1);
			}
		}
	}

	const client = new TournamentClient({
		url,
		nametag,
		pubkey: nametag.replace('@', '') + '00'.repeat(31),
		WebSocketCtor: WebSocket as unknown as new (url: string) => globalThis.WebSocket,
		onLobbyState: (m) => { lobbyState = m; notify('lobby-state'); },
		onRoundOpen: (m) => { roundOpen = m; notify('round-open'); },
		onMatchStart: (m) => { matchStart = m; notify('match-start'); },
		onTournamentEnd: (m) => { tournamentEnd = m; notify('tournament-end'); },
		onError: (m) => { errors.push(m.code); notify('error'); },
	});

	return {
		client,
		get lobbyState() { return lobbyState; },
		get roundOpen() { return roundOpen; },
		get matchStart() { return matchStart; },
		get tournamentEnd() { return tournamentEnd; },
		get errors() { return errors; },
		waitFor,
	};
}

runTest('client SDK drives a full 2-player tournament', async () => {
	const server = await startServer({ capacity: 2, minPlayers: 2 });
	try {
		const alice = makeClient(server.url, '@alice');
		const bob = makeClient(server.url, '@bob');

		await alice.client.connect();
		await bob.client.connect();

		alice.client.join('boxyrun-alpha-1');
		bob.client.join('boxyrun-alpha-1');

		await alice.waitFor('round-open');
		await bob.waitFor('round-open');
		assert(alice.roundOpen !== null, 'alice got round-open');
		assertEqual(alice.roundOpen!.matchId, bob.roundOpen!.matchId);
		const matchId = alice.roundOpen!.matchId;

		alice.client.ready(matchId);
		bob.client.ready(matchId);

		await alice.waitFor('match-start');
		await bob.waitFor('match-start');
		assert(alice.matchStart !== null, 'alice got match-start');
		assertEqual(alice.matchStart!.seed, bob.matchStart!.seed, 'same seed');

		// Exchange a round of inputs
		alice.client.sendInput(matchId, 42, 'dXA=');
		bob.client.sendInput(matchId, 50, 'bGVmdA==');

		// Submit matching results — A wins
		const result = {
			finalTick: 570,
			score: { A: 9120, B: 4000 } as Record<string, number>,
			winner: 'A' as const,
			inputsHash: 'h',
			resultHash: 'agreed',
		};
		alice.client.submitResult(matchId, result.finalTick, result.score, result.winner, result.inputsHash, result.resultHash);
		bob.client.submitResult(matchId, result.finalTick, result.score, result.winner, result.inputsHash, result.resultHash);

		await alice.waitFor('tournament-end');
		await bob.waitFor('tournament-end');
		assert(alice.tournamentEnd !== null, 'alice got tournament-end');
		assertEqual(alice.tournamentEnd!.standings.length, 2);

		alice.client.disconnect();
		bob.client.disconnect();
	} finally {
		await stopServer(server.proc);
	}
});
