/**
 * Shared helper for e2e tests: creates a TournamentClient with
 * buffered message capture. waitFor checks the buffer first so
 * messages that arrived before the await aren't missed.
 */

import WebSocket from 'ws';

import { TournamentClient } from '../client/client';
import type {
	ChallengeReceivedMessage,
	MatchStartMessage,
	RoundOpenMessage,
	TournamentAssignedMessage,
	TournamentEndMessage,
} from '../protocol/messages';

export function makePlayer(url: string, nametag: string) {
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
		onChallengeSent: (msg) => dispatch('challenge-sent', msg),
		onChallengeDeclined: (msg) => dispatch('challenge-declined', msg),
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
		for (let i = 0; i < messages.length; i++) {
			if (messages[i].type === type && !consumed.has(i)) {
				consumed.add(i);
				return Promise.resolve(messages[i].data);
			}
		}
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
