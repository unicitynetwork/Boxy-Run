/**
 * Tournament state machine. Pure logic — no WebSocket, no I/O.
 * The server layer drives this class by calling its methods; each
 * method returns an array of Delivery objects telling the server
 * what messages to send to whom. This keeps the state machine
 * testable in isolation (no server subprocess needed for unit tests)
 * and keeps the networking layer thin.
 *
 * Delivery `to` field conventions:
 *   - A nametag (string starting with '@') addresses that specific player
 *   - '*' is a broadcast to every connected player in the tournament
 */

import {
	PROTOCOL_VERSION,
	type BracketMessage,
	type BracketSlot,
	type LobbyStateMessage,
	type MatchStartMessage,
	type OpponentReadyMessage,
	type PublicIdentity,
	type RoundOpenMessage,
	type ServerMessage,
} from '../protocol/messages';
import { generateBracket, hashString } from './bracket';

export type TournamentPhase = 'LOBBY' | 'RUNNING' | 'PAYOUT' | 'DONE';

export type MatchPhase =
	/** Earlier round hasn't filled both players yet. */
	| 'PENDING'
	/** One of playerA/playerB is null; auto-resolved at bracket generation. */
	| 'BYE'
	/** Both players known, round window open, awaiting ready flags. */
	| 'READY_WAIT'
	/** Both players ready, live match in progress. */
	| 'ACTIVE'
	/** Match ended, waiting for both players to submit result hashes. */
	| 'AWAIT_HASHES'
	/** Winner determined, advanced to next round. */
	| 'RESOLVED';

export interface MatchState {
	matchId: string;
	roundIndex: number;
	/** Position of this match within its round. */
	slotIndex: number;
	playerA: string | null;
	playerB: string | null;
	phase: MatchPhase;
	winner: string | null;
	/** Ready flags, keyed by nametag. Only meaningful in READY_WAIT. */
	readyA: boolean;
	readyB: boolean;
	/** 8-hex-char seed computed at match-start, null until ACTIVE. */
	seed: string | null;
	/** Wall-clock epoch ms when the match started, null until ACTIVE. */
	startedAt: number | null;
	/** Last ready-toggle timestamp per side, for rate limiting. */
	lastReadyToggleA: number;
	lastReadyToggleB: number;
}

export interface Delivery {
	to: string;
	message: ServerMessage;
}

interface PlayerRecord {
	identity: PublicIdentity;
	joinedAt: number;
}

export interface TournamentOptions {
	id: string;
	capacity: number;
	/** Tournament auto-starts when player count reaches this number. */
	minPlayers: number;
	/** Milliseconds the round-open window stays open. */
	roundWindowMs?: number;
}

export class Tournament {
	readonly id: string;
	readonly capacity: number;
	readonly minPlayers: number;
	readonly roundWindowMs: number;

	private phase: TournamentPhase = 'LOBBY';
	private players = new Map<string, PlayerRecord>();
	private bracket: BracketSlot[][] | null = null;
	private matches = new Map<string, MatchState>();
	private currentRound = 0;

	constructor(opts: TournamentOptions) {
		this.id = opts.id;
		this.capacity = opts.capacity;
		this.minPlayers = opts.minPlayers;
		this.roundWindowMs = opts.roundWindowMs ?? 24 * 60 * 60 * 1000;
	}

	// ── introspection ─────────────────────────────────────────────────

	getPhase(): TournamentPhase {
		return this.phase;
	}

	getPlayerCount(): number {
		return this.players.size;
	}

	hasPlayer(nametag: string): boolean {
		return this.players.has(nametag);
	}

	getMatch(matchId: string): MatchState | undefined {
		return this.matches.get(matchId);
	}

	getAllMatches(): MatchState[] {
		return Array.from(this.matches.values());
	}

	getBracket(): BracketSlot[][] | null {
		return this.bracket;
	}

	// ── mutations ─────────────────────────────────────────────────────

	/**
	 * Admit a player to the lobby. On success broadcasts a lobby-state
	 * and, if minPlayers is reached, starts the tournament (generating
	 * the bracket and opening round 0). Errors are returned as a
	 * single-element delivery addressed to the joining player.
	 */
	addPlayer(identity: PublicIdentity): Delivery[] {
		if (this.phase !== 'LOBBY') {
			return [errorTo(identity.nametag, 'not_in_lobby', 'tournament is not accepting joins')];
		}
		if (this.players.has(identity.nametag)) {
			return [errorTo(identity.nametag, 'duplicate_nametag', `${identity.nametag} is already in the lobby`)];
		}
		if (this.players.size >= this.capacity) {
			return [errorTo(identity.nametag, 'lobby_full', 'tournament is full')];
		}

		this.players.set(identity.nametag, {
			identity,
			joinedAt: Date.now(),
		});

		const deliveries: Delivery[] = [{ to: '*', message: this.buildLobbyState() }];
		if (this.players.size >= this.minPlayers) {
			deliveries.push(...this.start());
		}
		return deliveries;
	}

	/**
	 * Remove a player from the tournament. During LOBBY, just drops
	 * them and broadcasts the new roster. Mid-tournament removal is
	 * TODO (forfeit handling).
	 */
	removePlayer(nametag: string): Delivery[] {
		if (!this.players.has(nametag)) return [];
		this.players.delete(nametag);
		if (this.phase === 'LOBBY') {
			return [{ to: '*', message: this.buildLobbyState() }];
		}
		return [];
	}

	/** Minimum interval between ready/unready toggles per side (ms). */
	private static readonly READY_RATE_LIMIT_MS = 3000;

	/**
	 * Handle a match-ready message. Sets the player's ready flag,
	 * notifies the opponent, and if both are ready, starts the match.
	 */
	setReady(nametag: string, matchId: string): Delivery[] {
		const match = this.matches.get(matchId);
		if (!match) return [errorTo(nametag, 'unknown_match', `no such match: ${matchId}`)];
		if (match.phase !== 'READY_WAIT') {
			return [errorTo(nametag, 'not_ready_wait', `match ${matchId} is not in READY_WAIT`)];
		}
		const side = this.sideOf(nametag, match);
		if (!side) return [errorTo(nametag, 'not_in_match', 'you are not in this match')];

		const now = Date.now();
		const lastToggle = side === 'A' ? match.lastReadyToggleA : match.lastReadyToggleB;
		if (now - lastToggle < Tournament.READY_RATE_LIMIT_MS) {
			return [errorTo(nametag, 'rate_limited', 'ready toggle rate limited (3s)')];
		}

		if (side === 'A') { match.readyA = true; match.lastReadyToggleA = now; }
		else { match.readyB = true; match.lastReadyToggleB = now; }

		const opponent = side === 'A' ? match.playerB! : match.playerA!;
		const deliveries: Delivery[] = [];

		const readyMsg: OpponentReadyMessage = {
			type: 'opponent-ready', v: PROTOCOL_VERSION,
			matchId, ready: true,
		};
		deliveries.push({ to: opponent, message: readyMsg });

		if (match.readyA && match.readyB) {
			deliveries.push(...this.startMatch(match));
		}
		return deliveries;
	}

	/**
	 * Handle a match-unready message. Clears the player's ready flag
	 * and notifies the opponent. Only valid in READY_WAIT phase.
	 */
	setUnready(nametag: string, matchId: string): Delivery[] {
		const match = this.matches.get(matchId);
		if (!match) return [errorTo(nametag, 'unknown_match', `no such match: ${matchId}`)];
		if (match.phase !== 'READY_WAIT') {
			return [errorTo(nametag, 'not_ready_wait', `match ${matchId} is not in READY_WAIT`)];
		}
		const side = this.sideOf(nametag, match);
		if (!side) return [errorTo(nametag, 'not_in_match', 'you are not in this match')];

		const now = Date.now();
		const lastToggle = side === 'A' ? match.lastReadyToggleA : match.lastReadyToggleB;
		if (now - lastToggle < Tournament.READY_RATE_LIMIT_MS) {
			return [errorTo(nametag, 'rate_limited', 'ready toggle rate limited (3s)')];
		}

		if (side === 'A') { match.readyA = false; match.lastReadyToggleA = now; }
		else { match.readyB = false; match.lastReadyToggleB = now; }

		const opponent = side === 'A' ? match.playerB! : match.playerA!;
		const readyMsg: OpponentReadyMessage = {
			type: 'opponent-ready', v: PROTOCOL_VERSION,
			matchId, ready: false,
		};
		return [{ to: opponent, message: readyMsg }];
	}

	private sideOf(nametag: string, match: MatchState): 'A' | 'B' | null {
		if (match.playerA === nametag) return 'A';
		if (match.playerB === nametag) return 'B';
		return null;
	}

	/**
	 * Transition a match from READY_WAIT to ACTIVE. Computes the match
	 * seed from (tournamentId, round, slot, sortedPubkeys) and emits
	 * match-start to both players with a 3-second countdown.
	 */
	private startMatch(match: MatchState): Delivery[] {
		match.phase = 'ACTIVE';
		const now = Date.now();
		match.startedAt = now;
		const startsAt = now + 3000;

		const pA = this.players.get(match.playerA!)!;
		const pB = this.players.get(match.playerB!)!;
		const sortedPubkeys = [pA.identity.pubkey, pB.identity.pubkey].sort();
		const seedInput = `${this.id}|${match.roundIndex}|${match.slotIndex}|${sortedPubkeys[0]}|${sortedPubkeys[1]}`;
		const seedNum = hashString(seedInput);
		match.seed = seedNum.toString(16).padStart(8, '0');

		const timeCapTicks = 60 * 60 * 10; // 10 minutes at 60 Hz

		const msgA: MatchStartMessage = {
			type: 'match-start', v: PROTOCOL_VERSION,
			matchId: match.matchId, seed: match.seed,
			opponent: match.playerB!, youAre: 'A', startsAt, timeCapTicks,
			protocol: { heartbeatIntervalMs: 5000, inputAckMode: 'none' },
		};
		const msgB: MatchStartMessage = {
			type: 'match-start', v: PROTOCOL_VERSION,
			matchId: match.matchId, seed: match.seed,
			opponent: match.playerA!, youAre: 'B', startsAt, timeCapTicks,
			protocol: { heartbeatIntervalMs: 5000, inputAckMode: 'none' },
		};
		return [
			{ to: match.playerA!, message: msgA },
			{ to: match.playerB!, message: msgB },
		];
	}

	// ── internal state transitions ────────────────────────────────────

	private start(): Delivery[] {
		if (this.phase !== 'LOBBY') return [];
		this.phase = 'RUNNING';
		const nametags = Array.from(this.players.keys());
		this.bracket = generateBracket(nametags, this.id);

		// Build match state for every slot.
		for (let r = 0; r < this.bracket.length; r++) {
			for (let s = 0; s < this.bracket[r].length; s++) {
				const slot = this.bracket[r][s];
				let phase: MatchPhase;
				if (r !== 0) {
					phase = 'PENDING';
				} else if (slot.playerA === null || slot.playerB === null) {
					phase = 'BYE';
				} else {
					phase = 'READY_WAIT';
				}
				this.matches.set(slot.matchId, {
					matchId: slot.matchId,
					roundIndex: r,
					slotIndex: s,
					playerA: slot.playerA,
					playerB: slot.playerB,
					phase,
					winner: null,
					readyA: false,
					readyB: false,
					seed: null,
					startedAt: null,
					lastReadyToggleA: 0,
					lastReadyToggleB: 0,
				});
			}
		}

		this.resolveByes(0);

		const deliveries: Delivery[] = [];
		deliveries.push({ to: '*', message: this.buildBracket() });
		deliveries.push(...this.emitRoundOpen(0));
		return deliveries;
	}

	/**
	 * For every BYE match in the given round, immediately declare
	 * the non-null player as the winner and propagate them to the
	 * corresponding slot in the next round. If all bye-advancement
	 * leaves a next-round match fully populated AND that match is
	 * in the current round, promote it to READY_WAIT.
	 */
	private resolveByes(round: number): void {
		if (!this.bracket) return;
		if (round + 1 >= this.bracket.length) return;

		for (let s = 0; s < this.bracket[round].length; s++) {
			const slot = this.bracket[round][s];
			const match = this.matches.get(slot.matchId);
			if (!match || match.phase !== 'BYE') continue;

			const winner = slot.playerA ?? slot.playerB;
			if (winner === null) continue;

			match.winner = winner;
			match.phase = 'RESOLVED';
			this.advanceWinner(round, s, winner);
		}
	}

	/**
	 * Write `winner` into the appropriate slot of the next round. The
	 * pairing rule is: slot i in round r feeds slot floor(i/2) in
	 * round r+1, as playerA if i is even or playerB if i is odd.
	 */
	private advanceWinner(fromRound: number, fromSlot: number, winner: string): void {
		if (!this.bracket) return;
		const nextRound = fromRound + 1;
		if (nextRound >= this.bracket.length) return;

		const nextSlotIndex = Math.floor(fromSlot / 2);
		const nextSlot = this.bracket[nextRound][nextSlotIndex];
		const isPlayerA = fromSlot % 2 === 0;

		if (isPlayerA) {
			nextSlot.playerA = winner;
		} else {
			nextSlot.playerB = winner;
		}

		const nextMatch = this.matches.get(nextSlot.matchId);
		if (!nextMatch) return;
		if (isPlayerA) nextMatch.playerA = winner;
		else nextMatch.playerB = winner;
	}

	/**
	 * Emit round-open messages for every READY_WAIT match in the
	 * given round (after promoting any newly-fillable PENDING matches
	 * to READY_WAIT). Called when the tournament starts (round 0) and
	 * when a round is about to begin after previous-round completion.
	 */
	private emitRoundOpen(round: number): Delivery[] {
		if (!this.bracket) return [];
		this.currentRound = round;

		// Promote PENDING matches whose players are now known.
		for (const slot of this.bracket[round]) {
			const match = this.matches.get(slot.matchId);
			if (!match) continue;
			if (
				match.phase === 'PENDING' &&
				match.playerA !== null &&
				match.playerB !== null
			) {
				match.phase = 'READY_WAIT';
			}
		}

		const openedAt = Date.now();
		const deadline = openedAt + this.roundWindowMs;
		const deliveries: Delivery[] = [];

		for (const slot of this.bracket[round]) {
			const match = this.matches.get(slot.matchId);
			if (!match || match.phase !== 'READY_WAIT') continue;
			if (match.playerA === null || match.playerB === null) continue;

			const toA: RoundOpenMessage = {
				type: 'round-open',
				v: PROTOCOL_VERSION,
				matchId: match.matchId,
				roundIndex: round,
				opponent: match.playerB,
				openedAt,
				deadline,
			};
			const toB: RoundOpenMessage = {
				type: 'round-open',
				v: PROTOCOL_VERSION,
				matchId: match.matchId,
				roundIndex: round,
				opponent: match.playerA,
				openedAt,
				deadline,
			};
			deliveries.push({ to: match.playerA, message: toA });
			deliveries.push({ to: match.playerB, message: toB });
		}
		return deliveries;
	}

	// ── builders ──────────────────────────────────────────────────────

	private buildLobbyState(): LobbyStateMessage {
		return {
			type: 'lobby-state',
			v: PROTOCOL_VERSION,
			tournamentId: this.id,
			players: Array.from(this.players.values()).map((p) => ({
				nametag: p.identity.nametag,
				joinedAt: p.joinedAt,
			})),
			capacity: this.capacity,
			startsAt: null,
		};
	}

	private buildBracket(): BracketMessage {
		return {
			type: 'bracket',
			v: PROTOCOL_VERSION,
			tournamentId: this.id,
			rounds: this.bracket ?? [],
		};
	}
}

function errorTo(nametag: string, code: string, message: string): Delivery {
	return {
		to: nametag,
		message: {
			type: 'error',
			v: PROTOCOL_VERSION,
			code,
			message,
		},
	};
}
