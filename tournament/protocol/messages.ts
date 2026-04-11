/**
 * Wire-level message types for the tournament protocol.
 * Authoritative spec: tournament/PROTOCOL.md
 *
 * Every message has a `type` field used as a discriminator and a `v`
 * field with the protocol version. Unknown types MUST be ignored by
 * receivers; unknown fields MUST NOT cause rejection (forward
 * compatibility).
 *
 * This file is pure types plus one const. It is imported by both the
 * server (Node) and the client (browser) and must therefore not
 * reference any platform-specific API.
 */

export const PROTOCOL_VERSION = 0;

/** Base shape every message carries. */
export interface MessageBase<T extends string> {
	type: T;
	v: typeof PROTOCOL_VERSION;
}

// ─── Shared value types ────────────────────────────────────────────────────

/** Public identity of a player, as learned from their Sphere wallet. */
export interface PublicIdentity {
	/** Unicity nametag, including the leading '@'. */
	nametag: string;
	/** Hex-encoded public key used to verify signatures. */
	pubkey: string;
}

/** On-chain entry fee payment supplied with `join`. */
export interface EntryPayment {
	/** Hash of the tx that paid the entry fee to the operator wallet. */
	txHash: string;
	/** Decimal amount as a string, for precision and sanity-check. */
	amount: string;
	/** Hex-encoded coin id. */
	coinId: string;
}

/** Which side of a 1v1 match a player is on. */
export type MatchSide = 'A' | 'B';

/** One slot in a bracket round. Either filled with a nametag or a TBD/bye (null). */
export interface BracketSlot {
	matchId: string;
	playerA: string | null;
	playerB: string | null;
}

/** Reasons a match can end. */
export type MatchEndReason =
	| 'death'
	| 'timecap'
	| 'forfeit'
	| 'dual-forfeit'
	| 'dq'
	| 'flagged';

// ─── Client → Server ───────────────────────────────────────────────────────

/**
 * Join a tournament. Sent once after the WebSocket connection is
 * established. Server verifies the entry tx against the Unicity chain
 * before admitting the player.
 */
export interface JoinMessage extends MessageBase<'join'> {
	tournamentId: string;
	identity: PublicIdentity;
	entry: EntryPayment;
	/** Signature over `${tournamentId}|${entry.txHash}` using the identity's pubkey. */
	signature: string;
}

/**
 * Resume an existing session after a dropped connection. Server
 * responds with whatever state the player needs to catch up (lobby,
 * bracket, or mid-match).
 */
export interface ResumeMessage extends MessageBase<'resume'> {
	tournamentId: string;
	identity: PublicIdentity;
	signature: string;
}

/**
 * Set the ready flag for a match. Rate-limited to one transition per
 * 3 seconds per (player, matchId). When both players of a match hold
 * the flag simultaneously, the server emits `match-start` to both.
 */
export interface MatchReadyMessage extends MessageBase<'match-ready'> {
	matchId: string;
}

/** Clear the ready flag. Only valid while the match is in WAITING_READY. */
export interface MatchUnreadyMessage extends MessageBase<'match-unready'> {
	matchId: string;
}

/**
 * Stream one player input. Payload is opaque to the server — it is
 * relayed to the opponent and stored in the match's input trace, but
 * never decoded. `tick` is the sender's local tick at the moment of
 * the input and is used by the receiver to apply the input at the
 * tagged tick (with light rollback / buffering as needed).
 */
export interface InputMessage extends MessageBase<'input'> {
	matchId: string;
	tick: number;
	payload: string;
}

/** Liveness signal during an active match. Absence triggers forfeit after grace period. */
export interface HeartbeatMessage extends MessageBase<'heartbeat'> {
	matchId: string;
	tick: number;
}

/**
 * Report match result after running the sim to completion. Each player
 * sends their own view; the server compares the two `resultHash`
 * values and resolves or flags the match.
 */
export interface ResultMessage extends MessageBase<'result'> {
	matchId: string;
	finalTick: number;
	score: Record<MatchSide, number>;
	winner: MatchSide;
	/** Hash of concatenated input payloads in tick order. */
	inputsHash: string;
	/** Hash of (seed || inputsHash || finalTick || scores || winner). */
	resultHash: string;
}

/** Graceful disconnect. */
export interface LeaveMessage extends MessageBase<'leave'> {
	reason?: string;
}

export type ClientMessage =
	| JoinMessage
	| ResumeMessage
	| MatchReadyMessage
	| MatchUnreadyMessage
	| InputMessage
	| HeartbeatMessage
	| ResultMessage
	| LeaveMessage;

// ─── Server → Client ───────────────────────────────────────────────────────

/** Sent after a successful join and whenever the lobby roster changes. */
export interface LobbyStateMessage extends MessageBase<'lobby-state'> {
	tournamentId: string;
	players: { nametag: string; joinedAt: number }[];
	capacity: number;
	/** Epoch ms when the tournament will begin, or null if still waiting for fill. */
	startsAt: number | null;
}

/** Sent once when the bracket is generated, and whenever it advances. */
export interface BracketMessage extends MessageBase<'bracket'> {
	tournamentId: string;
	rounds: BracketSlot[][];
}

/** Sent to both players when their next match's ready window opens. */
export interface RoundOpenMessage extends MessageBase<'round-open'> {
	matchId: string;
	roundIndex: number;
	opponent: string;
	openedAt: number;
	deadline: number;
}

/** UX hint: the opponent's ready flag changed. Does not affect match-start logic. */
export interface OpponentReadyMessage extends MessageBase<'opponent-ready'> {
	matchId: string;
	ready: boolean;
}

/**
 * Sent to both players the instant both ready flags are set. Contains
 * the shared start timestamp for synchronized countdown.
 */
export interface MatchStartMessage extends MessageBase<'match-start'> {
	matchId: string;
	/** 32-byte hex seed. */
	seed: string;
	opponent: string;
	youAre: MatchSide;
	startsAt: number;
	timeCapTicks: number;
	protocol: {
		heartbeatIntervalMs: number;
		inputAckMode: 'none' | 'per-tick';
	};
}

/** Relayed opponent input, so each client can run both sides of the sim locally. */
export interface OpponentInputMessage extends MessageBase<'opponent-input'> {
	matchId: string;
	tick: number;
	payload: string;
}

/** Match result after consensus or resolution. */
export interface MatchEndMessage extends MessageBase<'match-end'> {
	matchId: string;
	/** Winning nametag, or empty string on dual-forfeit. */
	winner: string;
	reason: MatchEndReason;
	scores: Record<string, number>;
}

/** Tournament completed, with standings and payout transaction hashes. */
export interface TournamentEndMessage extends MessageBase<'tournament-end'> {
	tournamentId: string;
	standings: { place: number; nametag: string; payout: string }[];
	payoutTxs: { nametag: string; txHash: string }[];
}

/** Generic error frame. */
export interface ErrorMessage extends MessageBase<'error'> {
	code: string;
	message: string;
	matchId?: string;
}

export type ServerMessage =
	| LobbyStateMessage
	| BracketMessage
	| RoundOpenMessage
	| OpponentReadyMessage
	| MatchStartMessage
	| OpponentInputMessage
	| MatchEndMessage
	| TournamentEndMessage
	| ErrorMessage;
