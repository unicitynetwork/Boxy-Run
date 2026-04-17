/**
 * Match lifecycle state machine.
 *
 * The SINGLE source of truth for a match's runtime state. Replaces the
 * disjoint per-concern maps (readyFlags, matchSides, matchDone,
 * tournamentSeries, readyFirstAt, matchDoneFirstAt, matchPhase) that grew
 * organically and allowed inconsistent combinations.
 *
 * Design:
 *   - `MatchState` holds everything needed to reason about one match.
 *   - `apply(state, event)` is a pure reducer: state + event → {state, effects}.
 *   - Invalid transitions are no-ops by construction (can't send a `ready`
 *     event while in `playing` phase — ignored, not an error).
 *   - Effects are DATA (broadcast, persist, resolve, nextGame, ...) — not
 *     side-effects inside the reducer. The caller (MatchManager) executes
 *     them. Keeps the reducer testable without spinning a server.
 *
 * Phases:
 *   awaiting_ready  — neither or only one player has readied for the current
 *                     game. Offline auto-ready + 30s TTL live here.
 *   playing         — both readied, countdown emitted, game running. Re-sends
 *                     of `ready` in this phase are reconnects — no-op state.
 *   resolving       — both have `done`, waiting for the replay + persist.
 *                     Transient; usually flipped in one tick.
 *   resolved        — final state. For in-memory GC; caller may drop.
 *
 *   Series games step: resolving → awaiting_ready (with new seed + game++).
 */

// ─── Phases & state ─────────────────────────────────────────────────

export type Phase = 'awaiting_ready' | 'playing' | 'resolving' | 'resolved';

export interface MatchState {
	readonly matchId: string;
	readonly tournamentId: string;
	readonly playerA: string;
	readonly playerB: string;
	readonly bestOf: number;

	phase: Phase;

	// Series state (currentGame = 1 for Bo1 or the first game of a Bo3/Bo5)
	currentGame: number;
	seed: string;
	wins: { A: number; B: number };

	// Per-game handshake + completion flags
	ready: { A: boolean; B: boolean };
	done: { A: boolean; B: boolean };

	// Timestamps the reconciler consults. Null when not in the relevant phase.
	phaseEnteredAt: number;
	firstReadyAt: number | null;
	firstDoneAt: number | null;

	// Financials
	wager: number;

	// Result of the most recently resolved game (for match-end/game-result messages)
	lastGameResult: {
		scoreA: number;
		scoreB: number;
		winner: string;
	} | null;
}

/** Timing constants — shared by reconciler and tests. */
export const READY_TTL_MS = 10_000;
export const READY_OFFLINE_GRACE_MS = 5_000;
export const DONE_OFFLINE_GRACE_MS = 30_000;
export const STUCK_BOTH_OFFLINE_MS = 45_000;
export const GAME_COUNTDOWN_MS = 3_000;
export const SERIES_NEXT_DELAY_MS = 4_000;

// ─── Events (inputs to the reducer) ─────────────────────────────────

export type MatchEvent =
	| { type: 'ready'; nametag: string; now: number; opponentOnline?: boolean }
	| { type: 'done'; nametag: string; now: number }
	| { type: 'reconcile'; now: number; onlineA: boolean; onlineB: boolean }
	| {
			type: 'game_resolved';
			now: number;
			gameWinner: string;
			scoreA: number;
			scoreB: number;
	  }
	| { type: 'advance_to_next_game'; now: number; newSeed: string };

// ─── Effects (outputs, executed by caller) ──────────────────────────

export type Effect =
	| { type: 'broadcast_status'; readyA: boolean; readyB: boolean }
	| { type: 'send_match_start'; to: string; seed: string; gameNumber: number; startsAt: number }
	| { type: 'send_ready_expired'; to: string }
	| { type: 'replay_game'; gameNumber: number; seed: string }
	| { type: 'send_game_result'; gameNumber: number; winsA: number; winsB: number; winner: string; scoreA: number; scoreB: number }
	| { type: 'send_series_next'; gameNumber: number; seed: string; winsA: number; winsB: number; startsAt: number }
	| { type: 'send_match_end'; winner: string; scoreA: number; scoreB: number; seriesEnd: boolean; forfeit?: boolean }
	/** Match has just transitioned awaiting_ready → playing for the first
	 * time. Persist DB status ready_wait → active so the bracket sees it. */
	| { type: 'persist_match_started' }
	/** A game just resolved (interim or final). Persist series progress
	 * so a server restart can rebuild the machine state at the right
	 * game number with the right per-side wins. */
	| { type: 'persist_series_progress'; winsA: number; winsB: number; currentGame: number; currentSeed: string }
	| { type: 'persist_result'; winner: string; scoreA: number; scoreB: number }
	| { type: 'advance_bracket'; winner: string }
	| { type: 'settle_wager'; winner: string; loser: string; amount: number }
	| { type: 'log'; level: 'info' | 'warn'; msg: string };

// ─── Constructors ───────────────────────────────────────────────────

export function initialState(opts: {
	matchId: string;
	tournamentId: string;
	playerA: string;
	playerB: string;
	seed: string;
	bestOf: number;
	wager?: number;
	now: number;
}): MatchState {
	return {
		matchId: opts.matchId,
		tournamentId: opts.tournamentId,
		playerA: opts.playerA,
		playerB: opts.playerB,
		bestOf: opts.bestOf,
		phase: 'awaiting_ready',
		currentGame: 1,
		seed: opts.seed,
		wins: { A: 0, B: 0 },
		ready: { A: false, B: false },
		done: { A: false, B: false },
		phaseEnteredAt: opts.now,
		firstReadyAt: null,
		firstDoneAt: null,
		wager: opts.wager ?? 0,
		lastGameResult: null,
	};
}

// ─── Helpers ────────────────────────────────────────────────────────

function sideOf(state: MatchState, nametag: string): 'A' | 'B' | null {
	if (nametag === state.playerA) return 'A';
	if (nametag === state.playerB) return 'B';
	return null;
}

function winsNeeded(bestOf: number): number {
	return Math.ceil(bestOf / 2);
}

function enterPhase(state: MatchState, phase: Phase, now: number): MatchState {
	return { ...state, phase, phaseEnteredAt: now };
}

function resetForNewGame(state: MatchState, newSeed: string, now: number): MatchState {
	return {
		...state,
		phase: 'awaiting_ready',
		currentGame: state.currentGame + 1,
		seed: newSeed,
		ready: { A: false, B: false },
		done: { A: false, B: false },
		phaseEnteredAt: now,
		firstReadyAt: null,
		firstDoneAt: null,
		lastGameResult: null,
	};
}

// ─── Reducer ────────────────────────────────────────────────────────

/**
 * Apply an event to the current state. Returns the new state and any
 * effects the caller should execute. Pure — no I/O, no side effects.
 *
 * Invalid-for-current-phase events are no-ops (state + no effects).
 * This is intentional: reconnects / retries / out-of-order messages
 * are silently absorbed rather than causing phase drift.
 */
export function apply(state: MatchState, event: MatchEvent): {
	state: MatchState;
	effects: Effect[];
} {
	switch (event.type) {
		case 'ready':
			return applyReady(state, event);
		case 'done':
			return applyDone(state, event);
		case 'reconcile':
			return applyReconcile(state, event);
		case 'game_resolved':
			return applyGameResolved(state, event);
		case 'advance_to_next_game':
			return applyAdvanceToNextGame(state, event);
	}
}

function applyReady(
	state: MatchState,
	event: { type: 'ready'; nametag: string; now: number; opponentOnline?: boolean },
): { state: MatchState; effects: Effect[] } {
	const side = sideOf(state, event.nametag);
	if (!side) return { state, effects: [] };

	// Only meaningful in awaiting_ready. In 'playing' this is a reconnect;
	// the caller should re-send match-start but the state machine ignores.
	if (state.phase !== 'awaiting_ready') {
		return { state, effects: [] };
	}

	if (state.ready[side]) {
		// Already ready; re-affirm the broadcast but no state change.
		return {
			state,
			effects: [
				{ type: 'broadcast_status', readyA: state.ready.A, readyB: state.ready.B },
			],
		};
	}

	let ready = { ...state.ready, [side]: true };
	const firstReadyAt = state.firstReadyAt ?? event.now;
	const effects: Effect[] = [];

	// Opponent is offline at ready time → auto-ready them so the readier
	// doesn't have to wait out the 5s reconciler grace. This matches the
	// legacy pre-machine behavior and keeps offline-opponent games
	// starting promptly.
	if (event.opponentOnline === false) {
		const oppSide = side === 'A' ? 'B' : 'A';
		if (!ready[oppSide]) {
			ready = { ...ready, [oppSide]: true };
		}
	}

	// Both ready → transition to playing, emit match-start.
	if (ready.A && ready.B) {
		const startsAt = event.now + GAME_COUNTDOWN_MS;
		const startEffects: Effect[] = [
			{ type: 'broadcast_status', readyA: true, readyB: true },
			{
				type: 'send_match_start',
				to: state.playerA,
				seed: state.seed,
				gameNumber: state.currentGame,
				startsAt,
			},
			{
				type: 'send_match_start',
				to: state.playerB,
				seed: state.seed,
				gameNumber: state.currentGame,
				startsAt,
			},
		];
		// Game 1 only → promote DB ready_wait → active. Subsequent games
		// are already under an 'active' row; persisting again would be a
		// no-op but clearer to skip.
		if (state.currentGame === 1) {
			startEffects.push({ type: 'persist_match_started' });
		}
		return {
			state: {
				...state,
				ready,
				firstReadyAt,
				phase: 'playing',
				phaseEnteredAt: event.now,
			},
			effects: startEffects,
		};
	}

	effects.push({ type: 'broadcast_status', readyA: ready.A, readyB: ready.B });
	return {
		state: { ...state, ready, firstReadyAt },
		effects,
	};
}

function applyDone(
	state: MatchState,
	event: { type: 'done'; nametag: string; now: number },
): { state: MatchState; effects: Effect[] } {
	const side = sideOf(state, event.nametag);
	if (!side) return { state, effects: [] };

	// Only meaningful in playing. In any other phase, ignore.
	if (state.phase !== 'playing') return { state, effects: [] };

	if (state.done[side]) return { state, effects: [] };

	const done = { ...state.done, [side]: true };
	const firstDoneAt = state.firstDoneAt ?? event.now;

	// Both done → go to resolving, tell the caller to replay inputs.
	if (done.A && done.B) {
		return {
			state: {
				...state,
				done,
				firstDoneAt,
				phase: 'resolving',
				phaseEnteredAt: event.now,
			},
			effects: [
				{ type: 'replay_game', gameNumber: state.currentGame, seed: state.seed },
			],
		};
	}

	return {
		state: { ...state, done, firstDoneAt },
		effects: [],
	};
}

function applyGameResolved(
	state: MatchState,
	event: { type: 'game_resolved'; now: number; gameWinner: string; scoreA: number; scoreB: number },
): { state: MatchState; effects: Effect[] } {
	if (state.phase !== 'resolving') return { state, effects: [] };

	const winnerSide = sideOf(state, event.gameWinner);
	if (!winnerSide) return { state, effects: [] };

	const wins = {
		A: state.wins.A + (winnerSide === 'A' ? 1 : 0),
		B: state.wins.B + (winnerSide === 'B' ? 1 : 0),
	};
	const need = winsNeeded(state.bestOf);
	const seriesOver = wins.A >= need || wins.B >= need;

	const lastGameResult = {
		scoreA: event.scoreA,
		scoreB: event.scoreB,
		winner: event.gameWinner,
	};

	if (seriesOver) {
		const seriesWinner = wins.A > wins.B ? state.playerA : state.playerB;
		const seriesLoser = seriesWinner === state.playerA ? state.playerB : state.playerA;
		const effects: Effect[] = [
			{
				type: 'persist_result',
				winner: seriesWinner,
				scoreA: wins.A,
				scoreB: wins.B,
			},
			{ type: 'advance_bracket', winner: seriesWinner },
			{
				type: 'send_match_end',
				winner: seriesWinner,
				scoreA: wins.A,
				scoreB: wins.B,
				seriesEnd: state.bestOf > 1,
			},
		];
		if (state.wager > 0) {
			effects.push({
				type: 'settle_wager',
				winner: seriesWinner,
				loser: seriesLoser,
				amount: state.wager,
			});
		}
		return {
			state: {
				...state,
				wins,
				lastGameResult,
				phase: 'resolved',
				phaseEnteredAt: event.now,
			},
			effects,
		};
	}

	// Interim game of a series — emit game-result, then the caller will
	// schedule an `advance_to_next_game` event after the display delay.
	return {
		state: { ...state, wins, lastGameResult },
		effects: [
			{
				type: 'send_game_result',
				gameNumber: state.currentGame,
				winsA: wins.A,
				winsB: wins.B,
				winner: event.gameWinner,
				scoreA: event.scoreA,
				scoreB: event.scoreB,
			},
			// Persist the new wins so a server restart between this game
			// and the next can rebuild state at the right score.
			{
				type: 'persist_series_progress',
				winsA: wins.A,
				winsB: wins.B,
				currentGame: state.currentGame,
				currentSeed: state.seed,
			},
		],
	};
}

function applyAdvanceToNextGame(
	state: MatchState,
	event: { type: 'advance_to_next_game'; now: number; newSeed: string },
): { state: MatchState; effects: Effect[] } {
	// Legal only right after a non-final game-resolution.
	if (state.phase !== 'resolving') return { state, effects: [] };
	const next = resetForNewGame(state, event.newSeed, event.now);
	return {
		state: next,
		effects: [
			{
				type: 'send_series_next',
				gameNumber: next.currentGame,
				seed: next.seed,
				winsA: next.wins.A,
				winsB: next.wins.B,
				startsAt: event.now + GAME_COUNTDOWN_MS,
			},
			// Persist the new currentGame + seed so a server restart
			// between this advance and game N's first input rebuilds
			// state at game N (not game 1).
			{
				type: 'persist_series_progress',
				winsA: next.wins.A,
				winsB: next.wins.B,
				currentGame: next.currentGame,
				currentSeed: next.seed,
			},
		],
	};
}

function applyReconcile(
	state: MatchState,
	event: { type: 'reconcile'; now: number; onlineA: boolean; onlineB: boolean },
): { state: MatchState; effects: Effect[] } {
	const effects: Effect[] = [];

	// Awaiting-ready phase: offline auto-ready + TTL expiry.
	if (state.phase === 'awaiting_ready' && state.firstReadyAt !== null) {
		const elapsed = event.now - state.firstReadyAt;

		// 30s TTL — no progress → clear flags, notify both, stay in awaiting_ready.
		if (elapsed >= READY_TTL_MS) {
			const cleared: MatchState = {
				...state,
				ready: { A: false, B: false },
				firstReadyAt: null,
				phaseEnteredAt: event.now,
			};
			effects.push(
				{ type: 'send_ready_expired', to: state.playerA },
				{ type: 'send_ready_expired', to: state.playerB },
				{ type: 'broadcast_status', readyA: false, readyB: false },
				{ type: 'log', level: 'info', msg: `[${state.matchId}] ready TTL expired` },
			);
			return { state: cleared, effects };
		}

		// 5s offline grace — auto-ready opponents whose WS is down.
		if (elapsed >= READY_OFFLINE_GRACE_MS) {
			let next = state.ready;
			if (!next.A && !event.onlineA) next = { ...next, A: true };
			if (!next.B && !event.onlineB) next = { ...next, B: true };
			if (next !== state.ready) {
				// If the auto-ready makes both ready, re-enter applyReady to trigger
				// match-start (easier than duplicating the logic here).
				const intermediate: MatchState = { ...state, ready: next };
				if (next.A && next.B) {
					const startsAt = event.now + GAME_COUNTDOWN_MS;
					const startEffects: Effect[] = [
						{ type: 'broadcast_status', readyA: true, readyB: true },
						{
							type: 'send_match_start',
							to: state.playerA,
							seed: state.seed,
							gameNumber: state.currentGame,
							startsAt,
						},
						{
							type: 'send_match_start',
							to: state.playerB,
							seed: state.seed,
							gameNumber: state.currentGame,
							startsAt,
						},
						{
							type: 'log',
							level: 'info',
							msg: `[${state.matchId}] both auto-ready (offline) → playing`,
						},
					];
					if (state.currentGame === 1) {
						startEffects.push({ type: 'persist_match_started' });
					}
					return {
						state: {
							...intermediate,
							phase: 'playing',
							phaseEnteredAt: event.now,
						},
						effects: startEffects,
					};
				}
				return {
					state: intermediate,
					effects: [
						{ type: 'broadcast_status', readyA: next.A, readyB: next.B },
						{
							type: 'log',
							level: 'info',
							msg: `[${state.matchId}] auto-ready offline opponent`,
						},
					],
				};
			}
		}
	}

	// Playing phase reconciler rules (independent of each other):
	if (state.phase === 'playing') {
		// Rule 1: 30s auto-done grace for an offline opponent (requires that
		// at least one player has already sent match-done).
		if (state.firstDoneAt !== null) {
			const elapsed = event.now - state.firstDoneAt;
			if (elapsed >= DONE_OFFLINE_GRACE_MS) {
				let next = state.done;
				if (!next.A && !event.onlineA) next = { ...next, A: true };
				if (!next.B && !event.onlineB) next = { ...next, B: true };
				if (next !== state.done) {
					if (next.A && next.B) {
						return {
							state: {
								...state,
								done: next,
								phase: 'resolving',
								phaseEnteredAt: event.now,
							},
							effects: [
								{ type: 'replay_game', gameNumber: state.currentGame, seed: state.seed },
								{
									type: 'log',
									level: 'info',
									msg: `[${state.matchId}] auto-done offline, replaying`,
								},
							],
						};
					}
					return { state: { ...state, done: next }, effects: [] };
				}
			}
		}

	}

	// Force-resolve: both offline 45s+ in any pre-resolved phase. Picks
	// playerA deterministically. Settles wager if one was set.
	if (state.phase === 'awaiting_ready' || state.phase === 'playing') {
		if (!event.onlineA && !event.onlineB) {
			const stuckElapsed = event.now - state.phaseEnteredAt;
			if (stuckElapsed >= STUCK_BOTH_OFFLINE_MS) {
				const effects: Effect[] = [
					{
						type: 'persist_result',
						winner: state.playerA,
						scoreA: state.wins.A,
						scoreB: state.wins.B,
					},
					{ type: 'advance_bracket', winner: state.playerA },
					{
						type: 'send_match_end',
						winner: state.playerA,
						scoreA: state.wins.A,
						scoreB: state.wins.B,
						seriesEnd: state.bestOf > 1,
						forfeit: true,
					},
					{
						type: 'log',
						level: 'warn',
						msg: `[${state.matchId}] both offline ≥45s, force-resolved`,
					},
				];
				if (state.wager > 0) {
					effects.push({
						type: 'settle_wager',
						winner: state.playerA,
						loser: state.playerB,
						amount: state.wager,
					});
				}
				return {
					state: { ...state, phase: 'resolved', phaseEnteredAt: event.now },
					effects,
				};
			}
		}
	}

	return { state, effects };
}
