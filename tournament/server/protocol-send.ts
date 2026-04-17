/**
 * Typed server→client send helpers. One function per `ServerMessage`
 * variant in protocol/messages.ts. Every `sendTo` / `broadcast` call
 * from the server should route through here so TypeScript can flag a
 * missing or renamed field at compile time.
 *
 * The `sink` argument is a function that delivers the message — usually
 * `sendTo(nametag, ...)` from tournament-ws.ts, or a broadcast function.
 * Keeping the sink pluggable lets the match-machine emit effects that
 * get routed by the manager without tying helpers to any one transport.
 */

import {
	PROTOCOL_VERSION,
	type MatchSide,
	type RegisteredMessage,
	type PlayerOnlineMessage,
	type ChatServerMessage,
	type ChallengeReceivedMessage,
	type ChallengeSentMessage,
	type ChallengeDeclinedMessage,
	type ChallengeStartMessage,
	type MatchStatusMessage,
	type MatchStartMessage,
	type OpponentInputMessage,
	type GameResultMessage,
	type SeriesNextMessage,
	type MatchEndMessage,
	type ReadyExpiredMessage,
	type BracketUpdateMessage,
	type ErrorMessage,
	type HeartbeatMessage,
	type ServerMessage,
} from '../protocol/messages';

/** Generic sink — accepts any valid ServerMessage. Callers bind their target. */
export type Sink = (msg: ServerMessage) => void;

// ─── Lobby ───────────────────────────────────────────────────────

export function sendRegistered(sink: Sink, data: Omit<RegisteredMessage, 'type' | 'v' | 'protocolVersion'>): void {
	sink({ type: 'registered', v: PROTOCOL_VERSION, protocolVersion: PROTOCOL_VERSION, ...data });
}

export function sendPlayerOnline(sink: Sink, data: Omit<PlayerOnlineMessage, 'type' | 'v'>): void {
	sink({ type: 'player-online', v: PROTOCOL_VERSION, ...data });
}

export function sendChat(sink: Sink, data: Omit<ChatServerMessage, 'type' | 'v'>): void {
	sink({ type: 'chat', v: PROTOCOL_VERSION, ...data });
}

// ─── Challenges ──────────────────────────────────────────────────

export function sendChallengeReceived(sink: Sink, data: Omit<ChallengeReceivedMessage, 'type' | 'v'>): void {
	sink({ type: 'challenge-received', v: PROTOCOL_VERSION, ...data });
}

export function sendChallengeSent(sink: Sink, data: Omit<ChallengeSentMessage, 'type' | 'v'>): void {
	sink({ type: 'challenge-sent', v: PROTOCOL_VERSION, ...data });
}

export function sendChallengeDeclined(sink: Sink, data: Omit<ChallengeDeclinedMessage, 'type' | 'v'>): void {
	sink({ type: 'challenge-declined', v: PROTOCOL_VERSION, ...data });
}

export function sendChallengeStart(sink: Sink, data: Omit<ChallengeStartMessage, 'type' | 'v'>): void {
	sink({ type: 'challenge-start', v: PROTOCOL_VERSION, ...data });
}

// ─── Match lifecycle ─────────────────────────────────────────────

export function sendMatchStatus(sink: Sink, data: Omit<MatchStatusMessage, 'type' | 'v'>): void {
	sink({ type: 'match-status', v: PROTOCOL_VERSION, ...data });
}

export function sendMatchStart(sink: Sink, data: Omit<MatchStartMessage, 'type' | 'v'>): void {
	sink({ type: 'match-start', v: PROTOCOL_VERSION, ...data });
}

export function sendOpponentInput(sink: Sink, data: Omit<OpponentInputMessage, 'type' | 'v'>): void {
	sink({ type: 'opponent-input', v: PROTOCOL_VERSION, ...data });
}

export function sendGameResult(sink: Sink, data: Omit<GameResultMessage, 'type' | 'v'>): void {
	sink({ type: 'game-result', v: PROTOCOL_VERSION, ...data });
}

export function sendSeriesNext(sink: Sink, data: Omit<SeriesNextMessage, 'type' | 'v'>): void {
	sink({ type: 'series-next', v: PROTOCOL_VERSION, ...data });
}

export function sendMatchEnd(sink: Sink, data: Omit<MatchEndMessage, 'type' | 'v'>): void {
	sink({ type: 'match-end', v: PROTOCOL_VERSION, ...data });
}

export function sendReadyExpired(sink: Sink, data: Omit<ReadyExpiredMessage, 'type' | 'v'>): void {
	sink({ type: 'ready-expired', v: PROTOCOL_VERSION, ...data });
}

export function sendBracketUpdate(sink: Sink, data: Omit<BracketUpdateMessage, 'type' | 'v'>): void {
	sink({ type: 'bracket-update', v: PROTOCOL_VERSION, ...data });
}

export function sendError(sink: Sink, data: Omit<ErrorMessage, 'type' | 'v'>): void {
	sink({ type: 'error', v: PROTOCOL_VERSION, ...data });
}

export function sendHeartbeat(sink: Sink): void {
	const msg: HeartbeatMessage = { type: 'heartbeat', v: PROTOCOL_VERSION };
	sink(msg);
}

// Re-export shared types so callers don't need two imports.
export type { MatchSide };
