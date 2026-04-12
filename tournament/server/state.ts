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
	type MatchEndMessage,
	type MatchEndReason,
	type MatchStartMessage,
	type OpponentInputMessage,
	type OpponentReadyMessage,
	type PublicIdentity,
	type RoundOpenMessage,
	type ServerMessage,
	type TournamentEndMessage,
} from '../protocol/messages';
import { generateBracket, hashString } from './bracket';
import { makeInitialState } from '../../src/sim/init';
import { tick as simTick } from '../../src/sim/tick';
import { DEFAULT_CONFIG, type CharacterAction } from '../../src/sim/state';

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
	/** Input trace stored per side for post-match verification. */
	inputsA: Array<{ tick: number; payload: string }>;
	inputsB: Array<{ tick: number; payload: string }>;
	/** When the match entered READY_WAIT (for forfeit timeout). */
	readyWaitStartedAt: number;
	/** Result hashes submitted by each side, null until received. */
	resultA: { finalTick: number; score: Record<string, number>; winner: string; inputsHash: string; resultHash: string } | null;
	resultB: { finalTick: number; score: Record<string, number>; winner: string; inputsHash: string; resultHash: string } | null;
	/** When the first result was submitted (for timeout). */
	firstResultAt: number | null;
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
	/** Milliseconds between ready/unready toggles. Default 3000. Set to 0 for tests. */
	readyRateLimitMs?: number;
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
		this.readyRateLimitMs = opts.readyRateLimitMs ?? 3000;
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
	readonly readyRateLimitMs: number;

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
		if (now - lastToggle < this.readyRateLimitMs) {
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
		if (now - lastToggle < this.readyRateLimitMs) {
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

	/**
	 * Relay a player's input to the opponent. Stores the input in the
	 * match's trace for post-match verification and emits opponent-input
	 * to the other side.
	 */
	relayInput(nametag: string, matchId: string, tick: number, payload: string): Delivery[] {
		const match = this.matches.get(matchId);
		if (!match) return [errorTo(nametag, 'unknown_match', `no such match: ${matchId}`)];
		if (match.phase !== 'ACTIVE') {
			return [errorTo(nametag, 'match_not_active', `match ${matchId} is not active`)];
		}
		const side = this.sideOf(nametag, match);
		if (!side) return [errorTo(nametag, 'not_in_match', 'you are not in this match')];

		// Store in trace
		const trace = { tick, payload };
		if (side === 'A') match.inputsA.push(trace);
		else match.inputsB.push(trace);

		// Relay to opponent
		const opponent = side === 'A' ? match.playerB! : match.playerA!;
		const msg: OpponentInputMessage = {
			type: 'opponent-input', v: PROTOCOL_VERSION,
			matchId, tick, payload,
		};
		return [{ to: opponent, message: msg }];
	}

	/**
	 * Submit a result hash from a player. When both players have
	 * submitted, compare their resultHash values:
	 *   - Agree → resolve the match, advance the winner.
	 *   - Disagree → flag the match for operator review.
	 * After resolving, checks whether the current round is fully
	 * resolved and, if so, opens the next round (or ends the
	 * tournament if this was the final).
	 */
	submitResult(
		nametag: string,
		matchId: string,
		finalTick: number,
		score: Record<string, number>,
		winner: string,
		inputsHash: string,
		resultHash: string,
	): Delivery[] {
		const match = this.matches.get(matchId);
		if (!match) return [errorTo(nametag, 'unknown_match', `no such match: ${matchId}`)];
		if (match.phase !== 'ACTIVE' && match.phase !== 'AWAIT_HASHES') {
			return [errorTo(nametag, 'wrong_phase', `match ${matchId} is in phase ${match.phase}`)];
		}
		const side = this.sideOf(nametag, match);
		if (!side) return [errorTo(nametag, 'not_in_match', 'you are not in this match')];

		const result = { finalTick, score, winner, inputsHash, resultHash };
		if (side === 'A') match.resultA = result;
		else match.resultB = result;

		// Move to AWAIT_HASHES on first result
		if (match.phase === 'ACTIVE') {
			match.phase = 'AWAIT_HASHES';
			match.firstResultAt = Date.now();
		}

		// If both results are in, try to resolve
		if (match.resultA && match.resultB) {
			return this.resolveMatch(match);
		}
		return [];
	}

	/**
	 * Resolve the match by replaying both players' input traces
	 * through the headless sim. The server runs the game with each
	 * player's recorded inputs and the shared match seed, producing
	 * authoritative scores. No self-reporting, no hash agreement,
	 * no cheating.
	 */
	private resolveMatch(match: MatchState): Delivery[] {
		const deliveries: Delivery[] = [];

		// Replay each player's sim from the match seed
		const seed = parseInt(match.seed ?? '0', 16) >>> 0;
		const config = DEFAULT_CONFIG;

		let replayA: ReturnType<Tournament['replaySim']>;
		let replayB: ReturnType<Tournament['replaySim']>;
		try {
			replayA = this.replaySim(seed, match.inputsA, config);
			replayB = this.replaySim(seed, match.inputsB, config);
		} catch (err) {
			console.error(`[match] ${match.matchId}: replay CRASHED:`, err);
			// Fallback: use self-reported scores
			const scoreA = (match.resultA?.score as Record<string, number>)?.['A'] || 0;
			const scoreB = (match.resultB?.score as Record<string, number>)?.['B'] || 0;
			replayA = { score: scoreA, deathTick: 0, violation: null };
			replayB = { score: scoreB, deathTick: 0, violation: null };
		}

		console.log(
			`[match] ${match.matchId}: A=${replayA.score} B=${replayB.score}` +
			(replayA.violation ? ` [A VIOLATION: ${replayA.violation}]` : '') +
			(replayB.violation ? ` [B VIOLATION: ${replayB.violation}]` : ''),
		);

		// Check for DQ: if a player cheated, the other wins
		let winnerSide: 'A' | 'B';
		let reason: MatchEndReason = 'death';

		if (replayA.violation && replayB.violation) {
			// Both cheated — higher legit score wins (or A by default)
			winnerSide = 'A';
			reason = 'dq';
		} else if (replayA.violation) {
			// A cheated — B wins by DQ
			winnerSide = 'B';
			reason = 'dq';
			console.log(`[match] ${match.matchId}: Player A (${match.playerA}) DQ'd: ${replayA.violation}`);
		} else if (replayB.violation) {
			// B cheated — A wins by DQ
			winnerSide = 'A';
			reason = 'dq';
			console.log(`[match] ${match.matchId}: Player B (${match.playerB}) DQ'd: ${replayB.violation}`);
		} else {
			// Clean match — higher score wins. Ties go to side A.
			winnerSide = replayA.score >= replayB.score ? 'A' : 'B';
		}

		match.winner = winnerSide === 'A' ? match.playerA! : match.playerB!;
		match.phase = 'RESOLVED';

		const combinedScores: Record<string, number> = {};
		if (match.playerA) combinedScores[match.playerA] = replayA.score;
		if (match.playerB) combinedScores[match.playerB] = replayB.score;

		const endMsg: MatchEndMessage = {
			type: 'match-end', v: PROTOCOL_VERSION,
			matchId: match.matchId,
			winner: match.winner,
			reason,
			scores: combinedScores,
		};
		deliveries.push({ to: match.playerA!, message: endMsg });
		deliveries.push({ to: match.playerB!, message: endMsg });

		this.advanceWinner(match.roundIndex, match.slotIndex, match.winner);

		// Check if the round is fully resolved
		deliveries.push(...this.checkRoundComplete(match.roundIndex));
		return deliveries;
	}

	/** Result of a server-side sim replay. */
	private replaySim(
		seed: number,
		inputs: Array<{ tick: number; payload: string }>,
		config: typeof DEFAULT_CONFIG,
	): { score: number; deathTick: number; violation: string | null } {
		const TIME_CAP = 36000; // 10 minutes at 60Hz
		const MAX_INPUTS_PER_TICK = 3; // up + left/right at most

		// ── Validate inputs before replay ──
		let violation: string | null = null;

		// Check for inputs at invalid ticks
		for (const inp of inputs) {
			if (inp.tick < 0) {
				violation = `input at negative tick ${inp.tick}`;
				break;
			}
			if (inp.tick > TIME_CAP) {
				violation = `input at tick ${inp.tick} exceeds time cap`;
				break;
			}
		}

		// Check input rate per tick
		if (!violation) {
			const tickCounts = new Map<number, number>();
			for (const inp of inputs) {
				tickCounts.set(inp.tick, (tickCounts.get(inp.tick) ?? 0) + 1);
				if (tickCounts.get(inp.tick)! > MAX_INPUTS_PER_TICK) {
					violation = `${tickCounts.get(inp.tick)} inputs at tick ${inp.tick} (max ${MAX_INPUTS_PER_TICK})`;
					break;
				}
			}
		}

		// Check for inhuman input density (sustained >10 inputs/sec for 5+ seconds)
		if (!violation && inputs.length > 0) {
			const WINDOW = 300; // 5 seconds in ticks
			const MAX_IN_WINDOW = 80; // ~16/sec sustained is suspicious
			for (let start = 0; start < inputs.length; start++) {
				const windowEnd = inputs[start].tick + WINDOW;
				let count = 0;
				for (let j = start; j < inputs.length && inputs[j].tick <= windowEnd; j++) {
					count++;
				}
				if (count > MAX_IN_WINDOW) {
					violation = `${count} inputs in ${WINDOW}-tick window (max ${MAX_IN_WINDOW})`;
					break;
				}
			}
		}

		// ── Replay the sim ──
		const state = makeInitialState(seed, config);
		const inputsByTick = new Map<number, CharacterAction[]>();
		for (const inp of inputs) {
			try {
				const action = atob(inp.payload) as CharacterAction;
				if (action === 'up' || action === 'left' || action === 'right') {
					if (!inputsByTick.has(inp.tick)) inputsByTick.set(inp.tick, []);
					inputsByTick.get(inp.tick)!.push(action);
				}
			} catch {
				// skip malformed
			}
		}

		while (!state.gameOver && state.tick < TIME_CAP) {
			const actions = inputsByTick.get(state.tick);
			if (actions) {
				for (const a of actions) {
					state.character.queuedActions.push(a);
				}
			}
			simTick(state, config);
		}

		return { score: state.score, deathTick: state.tick, violation };
	}

	/**
	 * If every match in the given round is RESOLVED (or BYE), advance
	 * to the next round or end the tournament if this was the final.
	 */
	private checkRoundComplete(round: number): Delivery[] {
		if (!this.bracket) return [];
		const allResolved = this.bracket[round].every((slot) => {
			const m = this.matches.get(slot.matchId);
			return m && (m.phase === 'RESOLVED' || m.phase === 'BYE');
		});
		if (!allResolved) return [];

		const nextRound = round + 1;
		if (nextRound >= this.bracket.length) {
			// This was the final — end the tournament
			return this.endTournament();
		}

		// Resolve any byes in the next round and open it
		this.resolveByes(nextRound);
		return this.emitRoundOpen(nextRound);
	}

	/**
	 * End the tournament and emit tournament-end with standings.
	 * Payouts are stubbed for now — no on-chain transfers.
	 */
	private endTournament(): Delivery[] {
		this.phase = 'DONE';

		// Determine standings from the bracket (champion = winner of
		// the final match, runner-up = loser, etc.)
		const standings: TournamentEndMessage['standings'] = [];
		if (this.bracket && this.bracket.length > 0) {
			const finalRound = this.bracket[this.bracket.length - 1];
			const finalMatch = this.matches.get(finalRound[0].matchId);
			if (finalMatch?.winner) {
				standings.push({ place: 1, nametag: finalMatch.winner, payout: '0' });
				const runnerUp = finalMatch.winner === finalMatch.playerA
					? finalMatch.playerB!
					: finalMatch.playerA!;
				standings.push({ place: 2, nametag: runnerUp, payout: '0' });
			}
		}

		const endMsg: TournamentEndMessage = {
			type: 'tournament-end', v: PROTOCOL_VERSION,
			tournamentId: this.id,
			standings,
			payoutTxs: [], // stub — no real payout yet
		};
		return [{ to: '*', message: endMsg }];
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
					inputsA: [],
					inputsB: [],
					resultA: null,
					resultB: null,
					firstResultAt: null,
					readyWaitStartedAt: Date.now(),
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

	// ── timeouts ─────────────────────────────────────────────────────

	/** Ready-wait timeout in ms. If both players don't ready within this window, forfeit. */
	static readonly READY_TIMEOUT_MS = 60_000; // 60 seconds
	/** Result timeout in ms. If both results don't arrive within this window after the first, forfeit. */
	static readonly RESULT_TIMEOUT_MS = 30_000; // 30 seconds

	/**
	 * Check for timed-out matches. Called periodically by the server.
	 * Returns deliveries for any matches that were force-resolved.
	 */
	checkTimeouts(): Delivery[] {
		if (this.phase !== 'RUNNING') return [];
		const now = Date.now();
		const deliveries: Delivery[] = [];

		for (const match of this.matches.values()) {
			// ── Ready-wait timeout: forfeit the player who didn't ready ──
			if (match.phase === 'READY_WAIT') {
				const elapsed = now - match.readyWaitStartedAt;
				if (elapsed > Tournament.READY_TIMEOUT_MS) {
					if (match.readyA && !match.readyB) {
						// B didn't ready — A wins by forfeit
						deliveries.push(...this.forfeitMatch(match, match.playerA!, 'forfeit'));
					} else if (!match.readyA && match.readyB) {
						// A didn't ready — B wins by forfeit
						deliveries.push(...this.forfeitMatch(match, match.playerB!, 'forfeit'));
					} else {
						// Neither readied — dual forfeit
						deliveries.push(...this.forfeitMatch(match, '', 'dual-forfeit'));
					}
				}
			}

			// ── Result timeout: one player submitted, the other didn't ──
			if (match.phase === 'AWAIT_HASHES' && match.firstResultAt) {
				const elapsed = now - match.firstResultAt;
				if (elapsed > Tournament.RESULT_TIMEOUT_MS) {
					if (match.resultA && !match.resultB) {
						deliveries.push(...this.forfeitResolve(match, 'A'));
					} else if (!match.resultA && match.resultB) {
						deliveries.push(...this.forfeitResolve(match, 'B'));
					}
				}
			}
		}

		return deliveries;
	}

	/**
	 * Force-resolve a match via forfeit. The winner advances.
	 */
	private forfeitMatch(match: MatchState, winnerNametag: string, reason: 'forfeit' | 'dual-forfeit'): Delivery[] {
		match.phase = 'RESOLVED';
		match.winner = winnerNametag || null;

		const endMsg: MatchEndMessage = {
			type: 'match-end', v: PROTOCOL_VERSION,
			matchId: match.matchId,
			winner: winnerNametag,
			reason,
			scores: {},
		};
		const deliveries: Delivery[] = [];
		if (match.playerA) deliveries.push({ to: match.playerA, message: endMsg });
		if (match.playerB) deliveries.push({ to: match.playerB, message: endMsg });

		if (winnerNametag) {
			this.advanceWinner(match.roundIndex, match.slotIndex, winnerNametag);
		}

		deliveries.push(...this.checkRoundComplete(match.roundIndex));
		return deliveries;
	}

	/**
	 * Resolve a match where only one player submitted a result.
	 * Run the server replay for the player who submitted, give 0
	 * to the absent player.
	 */
	private forfeitResolve(match: MatchState, submittedSide: 'A' | 'B'): Delivery[] {
		const seed = parseInt(match.seed ?? '0', 16) >>> 0;
		const config = DEFAULT_CONFIG;
		const inputs = submittedSide === 'A' ? match.inputsA : match.inputsB;
		const replay = this.replaySim(seed, inputs, config);
		const score = replay.score;

		const winnerNametag = submittedSide === 'A' ? match.playerA! : match.playerB!;
		const loserNametag = submittedSide === 'A' ? match.playerB! : match.playerA!;

		match.phase = 'RESOLVED';
		match.winner = winnerNametag;

		const scores: Record<string, number> = {};
		scores[winnerNametag] = score;
		scores[loserNametag] = 0;

		console.log(`[match] ${match.matchId}: forfeit-resolve, ${winnerNametag} wins with ${score}`);

		const endMsg: MatchEndMessage = {
			type: 'match-end', v: PROTOCOL_VERSION,
			matchId: match.matchId,
			winner: winnerNametag,
			reason: 'forfeit',
			scores,
		};
		const deliveries: Delivery[] = [];
		if (match.playerA) deliveries.push({ to: match.playerA, message: endMsg });
		if (match.playerB) deliveries.push({ to: match.playerB, message: endMsg });

		this.advanceWinner(match.roundIndex, match.slotIndex, winnerNametag);
		deliveries.push(...this.checkRoundComplete(match.roundIndex));
		return deliveries;
	}

	// ── public state queries (for spectators / new connections) ──────

	/** Build current lobby state for a new connection. Always available. */
	buildPublicLobbyState(): LobbyStateMessage {
		return this.buildLobbyState();
	}

	/** Build current bracket for a new connection. Null if not yet generated. */
	buildPublicBracket(): BracketMessage | null {
		return this.bracket ? this.buildBracket() : null;
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
