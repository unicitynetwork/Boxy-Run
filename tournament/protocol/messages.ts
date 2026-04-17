/**
 * Wire protocol for Boxy Run tournaments + challenges.
 *
 * This file is the SINGLE source of truth for every message exchanged
 * between server and client. It is imported by:
 *
 *   - The server (match-manager, tournament-ws, challenge, server)
 *   - The browser client (src/game/main.ts)
 *   - The bot script (scripts/bot-players.ts)
 *   - The test harness (tournament/tests/harness.ts)
 *
 * If you add a field to a message here, the TypeScript compiler will
 * flag every sender + handler that needs updating. Every wire change
 * MUST flow through this file. Do not add inline `type: 'foo'` sends
 * elsewhere — use the helpers in `server/protocol-send.ts` instead.
 *
 * Every message carries `v: PROTOCOL_VERSION`. Bump this number when
 * making incompatible changes so clients can refuse to run against an
 * unknown server (see `protocol-version` field in `registered`).
 */

export const PROTOCOL_VERSION = 0;

/** Base shape every message carries. `v` pins the protocol version. */
export interface MessageBase<T extends string> {
	type: T;
	v: typeof PROTOCOL_VERSION;
}

/**
 * Distributive Omit — required when omitting fields from a discriminated
 * union (the built-in Omit collapses to the common keys, losing per-
 * variant payloads). Used by `wsSend` helpers that auto-inject `v`.
 */
export type DistributiveOmit<T, K extends keyof any> = T extends unknown
	? Omit<T, K>
	: never;

/** Which side of a 1v1 match a player is on. */
export type MatchSide = 'A' | 'B';

/** One slot in a bracket round. Either filled with a nametag or null (TBD/bye). */
export interface BracketSlot {
	matchId: string;
	playerA: string | null;
	playerB: string | null;
}

// ═══════════════════════════════════════════════════════════════════
// Client → Server
// ═══════════════════════════════════════════════════════════════════

/** Associate the caller's WS with a nametag. First message on every connection. */
export interface RegisterMessage extends MessageBase<'register'> {
	identity: { nametag: string };
}

/** Send a 1v1 challenge to an online player. */
export interface ChallengeMessage extends MessageBase<'challenge'> {
	opponent: string;
	wager: number;
	bestOf: number;
}

/** Accept a received challenge. */
export interface ChallengeAcceptMessage extends MessageBase<'challenge-accept'> {
	challengeId: string;
}

/** Decline a received challenge. */
export interface ChallengeDeclineMessage extends MessageBase<'challenge-decline'> {
	challengeId: string;
}

/** Chat — to a specific player if `to` is set, otherwise lobby broadcast. */
export interface ChatClientMessage extends MessageBase<'chat'> {
	message: string;
	to?: string;
}

/**
 * Signal readiness for a game. Sent once per game: on match entry for
 * game 1, and after every `series-next` for games 2..N of a Bo3/Bo5.
 * Server transitions the match to 'playing' when both sides are ready.
 */
export interface MatchReadyMessage extends MessageBase<'match-ready'> {
	matchId: string;
}

/**
 * Stream one player action. Relayed to the opponent; stored for replay.
 * The `payload` is base64-encoded — an opaque one-byte action tag.
 */
export interface InputMessage extends MessageBase<'input'> {
	matchId: string;
	tick: number;
	payload: string;
}

/** Report that this side's sim has ended. Server replays on both done. */
export interface MatchDoneMessage extends MessageBase<'match-done'> {
	matchId: string;
}

export type ClientMessage =
	| RegisterMessage
	| ChallengeMessage
	| ChallengeAcceptMessage
	| ChallengeDeclineMessage
	| ChatClientMessage
	| MatchReadyMessage
	| InputMessage
	| MatchDoneMessage;

// ═══════════════════════════════════════════════════════════════════
// Server → Client
// ═══════════════════════════════════════════════════════════════════

/** Ack of `register`. Includes the current online roster. */
export interface RegisteredMessage extends MessageBase<'registered'> {
	nametag: string;
	onlinePlayers: string[];
	/** Server's protocol version. Clients should refuse to run if mismatched. */
	protocolVersion: typeof PROTOCOL_VERSION;
}

/** Broadcast when a player's online status flips. */
export interface PlayerOnlineMessage extends MessageBase<'player-online'> {
	nametag: string;
	online: boolean;
}

/** Direct or lobby chat from another player. */
export interface ChatServerMessage extends MessageBase<'chat'> {
	from: string;
	message: string;
}

/** Invitee received a challenge. */
export interface ChallengeReceivedMessage extends MessageBase<'challenge-received'> {
	challengeId: string;
	from: string;
	wager: number;
	bestOf: number;
}

/** Challenger is notified their challenge was posted. */
export interface ChallengeSentMessage extends MessageBase<'challenge-sent'> {
	challengeId: string;
	opponent: string;
	wager: number;
	bestOf: number;
}

/**
 * Challenge resolved without play. `by` is the declining player's nametag,
 * or the empty string when the server expired the challenge after 30s.
 */
export interface ChallengeDeclinedMessage extends MessageBase<'challenge-declined'> {
	challengeId: string;
	by: string;
}

/** Challenge accepted → immediate redirect to the match. */
export interface ChallengeStartMessage extends MessageBase<'challenge-start'> {
	challengeId: string;
	tournamentId: string;
	matchId: string;
	seed: string;
	startsAt: number;
	wager: number;
	bestOf: number;
	opponent: string;
	youAre: MatchSide;
}

/** Per-game ready status. Emitted whenever either ready flag flips. */
export interface MatchStatusMessage extends MessageBase<'match-status'> {
	matchId: string;
	readyA: boolean;
	readyB: boolean;
}

/**
 * Both players readied → start this game of the series. `gameNumber`
 * distinguishes game 1 from games 2..N so clients can dedup correctly.
 */
export interface MatchStartMessage extends MessageBase<'match-start'> {
	matchId: string;
	seed: string;
	opponent: string;
	youAre: MatchSide;
	gameNumber: number;
	startsAt: number;
	timeCapTicks: number;
	bestOf: number;
	tournamentId: string;
}

/** Opponent's relayed input for the local ghost sim. */
export interface OpponentInputMessage extends MessageBase<'opponent-input'> {
	matchId: string;
	tick: number;
	payload: string;
}

/**
 * Interim game result for a Bo3/Bo5 series. Server also schedules the
 * next game's `series-next` push after a short display delay.
 */
export interface GameResultMessage extends MessageBase<'game-result'> {
	matchId: string;
	gameNumber: number;
	winner: string;
	scoreA: number;
	scoreB: number;
	winsA: number;
	winsB: number;
	bestOf: number;
}

/** Start of the next game in a series. Client must re-`match-ready`. */
export interface SeriesNextMessage extends MessageBase<'series-next'> {
	matchId: string;
	seriesId: string;
	seed: string;
	opponent: string;
	youAre: MatchSide;
	startsAt: number;
	winsA: number;
	winsB: number;
	gameNumber: number;
	bestOf: number;
	wager: number;
	tournamentId: string;
}

/**
 * Final match result. For Bo3+, `seriesEnd: true` marks the last game;
 * `scoreA`/`scoreB` become *series wins* rather than per-game scores.
 * For Bo1, `seriesEnd: false` and scoreA/scoreB are the game scores.
 *
 * `forfeit: true` indicates a force-resolve (both players offline 45s+).
 * In that case scoreA/scoreB are typically 0-0 and clients should NOT
 * present the result as a real played game.
 */
export interface MatchEndMessage extends MessageBase<'match-end'> {
	matchId: string;
	winner: string;
	scoreA: number;
	scoreB: number;
	seriesEnd: boolean;
	bestOf: number;
	wager: number;
	forfeit?: boolean;
	/** Populated only if the match resolution itself errored (replay crash). */
	error?: string;
}

/** Ready TTL expired (30s no-show) — both ready flags cleared. */
export interface ReadyExpiredMessage extends MessageBase<'ready-expired'> {
	matchId: string;
}

/** Bracket state changed (match resolved / advanced) — refetch to see. */
export interface BracketUpdateMessage extends MessageBase<'bracket-update'> {
	matchId: string;
}

/** Server-side error. `code` is a stable identifier for client branching. */
export interface ErrorMessage extends MessageBase<'error'> {
	code: string;
	message: string;
	matchId?: string;
}

/** Periodic keepalive. Clients ignore the body; absence for >25s = disconnect. */
export interface HeartbeatMessage extends MessageBase<'heartbeat'> {}

export type ServerMessage =
	| RegisteredMessage
	| PlayerOnlineMessage
	| ChatServerMessage
	| ChallengeReceivedMessage
	| ChallengeSentMessage
	| ChallengeDeclinedMessage
	| ChallengeStartMessage
	| MatchStatusMessage
	| MatchStartMessage
	| OpponentInputMessage
	| GameResultMessage
	| SeriesNextMessage
	| MatchEndMessage
	| ReadyExpiredMessage
	| BracketUpdateMessage
	| ErrorMessage
	| HeartbeatMessage;
