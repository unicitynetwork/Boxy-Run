/**
 * MatchManager — owns in-memory MatchState and executes effects.
 *
 * The rest of the server talks to this manager; it never touches the
 * old disjoint maps directly. The manager's job is narrowly:
 *   - Load state lazily from DB on first access
 *   - Apply events through the pure `apply()` reducer
 *   - Execute returned effects (sendTo, persist, replay, wager settlement)
 *
 * When you need to change match behavior, you change the reducer, not
 * this file. This file just glues the machine to the outside world.
 */

import { getDb, ensureSchema } from './db';
import { getMatch, getTournament, storeInput, updateMatchResult, updateMatchSeriesProgress } from './tournament-db';
import { replayGame, advanceWinnerExternal, checkRoundAdvance, startMatch } from './tournament-logic';
import { now } from './clock';
import type { ServerMessage } from '../protocol/messages';
import {
	apply,
	initialState,
	MatchEvent,
	MatchState,
	Effect,
	SERIES_NEXT_DELAY_MS,
} from './match-machine';

// ─── Types for caller-provided side-effect implementations ──────────

export interface ManagerIO {
	/** Send a JSON message to the socket registered under `nametag`. */
	sendTo(nametag: string, msg: ServerMessage): void;
	/** Is this nametag currently online (WS open)? */
	isOnline(nametag: string): boolean;
	/** Broadcast to everyone (not per-match; used by tests). */
	broadcast?(msg: ServerMessage): void;
}

// ─── State storage ──────────────────────────────────────────────────

const states = new Map<string, MatchState>();

/** Test-only / admin-only: clear everything. */
export function _resetAll(): void {
	states.clear();
}

export function getState(matchId: string): MatchState | undefined {
	return states.get(matchId);
}

// ─── Lazy load from DB ──────────────────────────────────────────────

async function loadOrSeed(matchId: string): Promise<MatchState | null> {
	const existing = states.get(matchId);
	if (existing) return existing;

	const match = await getMatch(matchId);
	if (!match) return null;
	if (!match.player_a || !match.player_b) return null;
	// Don't reseed completed/forfeited matches. Stale setTimeout callbacks
	// (e.g. advance_to_next_game from the previous game) can fire after the
	// match resolved and was deleted from memory. Without this guard,
	// loadOrSeed would recreate the match in awaiting_ready phase, making
	// isInActiveMatch return true forever and blocking new challenges.
	if (match.status === 'complete' || match.status === 'forfeit') return null;

	const tournamentId = match.tournament_id as string;
	const tournament = tournamentId ? await getTournament(tournamentId) : null;
	const bestOf = (tournament?.best_of as number) || 1;
	const initialSeed = (match.seed as string) || '0';

	// Recover persisted series progress (written on every game-resolve via
	// `persist_series_progress`). After a server restart mid-Bo3 we restart
	// from `current_game` with the right `winsA`/`winsB` and `current_seed`
	// instead of resetting to game 1 with 0-0 (which would corrupt the
	// series — players who were 1-1 would replay with the score wiped).
	const seriesWinsA = (match.series_wins_a as number | null) ?? 0;
	const seriesWinsB = (match.series_wins_b as number | null) ?? 0;
	const currentGame = (match.current_game as number | null) ?? 1;
	const currentSeed = (match.current_seed as string | null) ?? initialSeed;

	const state = initialState({
		matchId,
		tournamentId,
		playerA: match.player_a as string,
		playerB: match.player_b as string,
		seed: currentSeed,
		bestOf,
		now: now(),
	});
	state.wins = { A: seriesWinsA, B: seriesWinsB };
	state.currentGame = currentGame;

	// DB status='active' means the match has been started server-side, but the
	// per-game ready handshake still happens client-side (audio unlock + visual
	// countdown). Seed as 'awaiting_ready' so client match-ready events trigger
	// the proper transition, NOT as 'playing' (which would drop them as no-ops).
	return state;
}

/** Cache wager on the state (called from the challenge module on accept). */
export function setWager(matchId: string, wager: number): void {
	const s = states.get(matchId);
	if (s) s.wager = wager;
}

// ─── Effect execution ───────────────────────────────────────────────

async function runEffects(
	state: MatchState,
	effects: Effect[],
	io: ManagerIO,
): Promise<void> {
	for (const effect of effects) {
		try {
			await runEffect(state, effect, io);
		} catch (err) {
			console.error(`[machine] effect ${effect.type} threw for ${state.matchId}:`, err);
			// DON'T rethrow — one effect failing should not prevent subsequent
			// effects (e.g. bracket advance failing should NOT block match-end).
		}
	}
}

async function runEffect(
	state: MatchState,
	effect: Effect,
	io: ManagerIO,
): Promise<void> {
	switch (effect.type) {
			case 'broadcast_status':
				io.sendTo(state.playerA, {
					type: 'match-status', v: 0, matchId: state.matchId,
					readyA: effect.readyA, readyB: effect.readyB,
				});
				io.sendTo(state.playerB, {
					type: 'match-status', v: 0, matchId: state.matchId,
					readyA: effect.readyA, readyB: effect.readyB,
				});
				break;

			case 'send_match_start': {
				const youAre = effect.to === state.playerA ? 'A' : 'B';
				const opponent = effect.to === state.playerA ? state.playerB : state.playerA;
				io.sendTo(effect.to, {
					type: 'match-start', v: 0,
					matchId: state.matchId,
					seed: effect.seed,
					opponent,
					youAre,
					gameNumber: effect.gameNumber,
					startsAt: effect.startsAt,
					timeCapTicks: 36000,
					bestOf: state.bestOf,
					tournamentId: state.tournamentId,
				});
				break;
			}

			case 'send_ready_expired':
				io.sendTo(effect.to, {
					type: 'ready-expired', v: 0, matchId: state.matchId,
				});
				break;

			case 'replay_game': {
				// Look up inputs per side and replay. Emit `game_resolved` back
				// into the machine.
				const seedNum = parseInt(effect.seed, 16) >>> 0;
				const { getInputs } = await import('./tournament-db');
				const side = (tag: 'A' | 'B') =>
					effect.gameNumber > 1 ? `${tag}:g${effect.gameNumber}` : tag;
				const inputsA = (await getInputs(state.matchId, side('A'))) as any[];
				const inputsB = (await getInputs(state.matchId, side('B'))) as any[];
				const scoreA = replayGame(seedNum, inputsA);
				const scoreB = replayGame(seedNum, inputsB);
				// Fair tiebreaker: on equal scores, use seed parity (deterministic
				// but not biased toward a fixed side like the old `>=` was).
				const gameWinner = scoreA > scoreB ? state.playerA
					: scoreB > scoreA ? state.playerB
					: (seedNum % 2 === 0 ? state.playerA : state.playerB);
				// Log input counts alongside scores. A wide score gap with a
				// matching input-count gap is the smoking gun for client-side
				// input loss (WS dropped, browser tab throttled, etc.) — the
				// player sees themselves jumping locally but the server never
				// stored the input, so the deterministic replay dies earlier.
				console.log(
					`[machine] ${state.matchId} game ${effect.gameNumber} replayed: ${state.playerA}=${scoreA}(${inputsA.length}in) ${state.playerB}=${scoreB}(${inputsB.length}in) → ${gameWinner}`,
				);
				await applyEventInner(
					state.matchId,
					{ type: 'game_resolved', now: now(), gameWinner, scoreA, scoreB },
					io,
				);
				break;
			}

			case 'send_game_result':
				console.log(`[machine] send_game_result game=${effect.gameNumber} to ${state.playerA},${state.playerB}`);
				for (const target of [state.playerA, state.playerB]) {
					io.sendTo(target, {
						type: 'game-result', v: 0, matchId: state.matchId,
						gameNumber: effect.gameNumber,
						winner: effect.winner,
						scoreA: effect.scoreA,
						scoreB: effect.scoreB,
						winsA: effect.winsA,
						winsB: effect.winsB,
						bestOf: state.bestOf,
					});
				}
				// Schedule series advance after delay.
				setTimeout(() => {
					const newSeed = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
					applyEvent(
						state.matchId,
						{ type: 'advance_to_next_game', now: now(), newSeed },
						io,
					).catch((e) => console.error('[machine advance] error:', e));
				}, SERIES_NEXT_DELAY_MS);
				break;

			case 'send_series_next':
				for (const target of [state.playerA, state.playerB]) {
					io.sendTo(target, {
						type: 'series-next', v: 0,
						seriesId: state.matchId, matchId: state.matchId,
						seed: effect.seed,
						opponent: target === state.playerA ? state.playerB : state.playerA,
						youAre: target === state.playerA ? 'A' : 'B',
						startsAt: effect.startsAt,
						winsA: effect.winsA, winsB: effect.winsB,
						gameNumber: effect.gameNumber,
						bestOf: state.bestOf,
						wager: state.wager,
						tournamentId: state.tournamentId,
					});
				}
				break;

			case 'send_match_end':
				for (const target of [state.playerA, state.playerB]) {
					io.sendTo(target, {
						type: 'match-end', v: 0, matchId: state.matchId,
						winner: effect.winner,
						scoreA: effect.scoreA,
						scoreB: effect.scoreB,
						seriesEnd: effect.seriesEnd,
						bestOf: state.bestOf,
						wager: state.wager,
						forfeit: effect.forfeit,
					});
				}
				break;

			case 'persist_series_progress':
				try {
					await updateMatchSeriesProgress(
						state.matchId,
						effect.winsA,
						effect.winsB,
						effect.currentGame,
						effect.currentSeed,
					);
				} catch (err) {
					console.error(`[machine] persist_series_progress ${state.matchId}:`, err);
				}
				break;

			case 'persist_match_started':
				// Promote DB status ready_wait → active. Idempotent at our
				// caller layer: startMatch throws if status is already active,
				// so guard on DB state before calling.
				try {
					const row = await getMatch(state.matchId);
					if (row && row.status === 'ready_wait') {
						await startMatch(state.matchId);
					}
				} catch (err) {
					console.error(`[machine] persist_match_started ${state.matchId}:`, err);
				}
				break;

			case 'persist_result':
				await updateMatchResult(state.matchId, effect.winner, effect.scoreA, effect.scoreB);
				break;

			case 'advance_bracket': {
				const match = await getMatch(state.matchId);
				if (match) {
					await advanceWinnerExternal(
						state.tournamentId,
						match.round as number,
						match.slot as number,
						effect.winner,
					);
					await checkRoundAdvance(state.tournamentId);
				}
				break;
			}

			case 'settle_wager':
				try {
					await ensureSchema();
					const db = getDb();
					const ts = new Date(now()).toISOString();
					// ATOMIC: both rows commit together or neither does. The
					// previous two-statement version could leave the loser
					// debited but the winner not credited if the second write
					// failed — money lost from the ledger.
					await db.batch([
						{
							sql: 'INSERT INTO player_transactions (nametag, amount, type, memo, timestamp) VALUES (?, ?, ?, ?, ?)',
							args: [effect.loser, -effect.amount, 'wager_loss', `Lost to ${effect.winner}`, ts],
						},
						{
							sql: 'INSERT INTO player_transactions (nametag, amount, type, memo, timestamp) VALUES (?, ?, ?, ?, ?)',
							args: [effect.winner, effect.amount, 'wager_win', `Beat ${effect.loser}`, ts],
						},
					], 'write');
					console.log(`[machine wager] ${effect.winner} won ${effect.amount} UCT from ${effect.loser}`);
				} catch (err) {
					console.error('[machine wager] settlement failed:', err);
				}
				break;

			case 'log':
				if (effect.level === 'warn') console.warn(effect.msg);
				else console.log(effect.msg);
				break;
	}
}

// ─── Per-match mutex ────────────────────────────────────────────────
// Without serialization, concurrent applyEvent calls (WS handler +
// reconciler tick, or two WS messages arriving back-to-back) can both
// read stale state, both see "both done", and both trigger replay_game.
// A simple promise-chain-per-match serializes access without blocking
// other matches.
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(matchId: string, fn: () => Promise<T>): Promise<T> {
	const prev = locks.get(matchId) ?? Promise.resolve();
	const next = prev.then(fn, fn); // run fn after previous settles (success or fail)
	locks.set(matchId, next);
	// Clean up when chain settles to avoid unbounded growth
	next.then(() => { if (locks.get(matchId) === next) locks.delete(matchId); },
	          () => { if (locks.get(matchId) === next) locks.delete(matchId); });
	return next;
}

// ─── Public entry points ────────────────────────────────────────────

/**
 * Inner apply — no lock. Used by effects that re-enter applyEvent
 * (replay_game → game_resolved, advance_to_next_game).
 */
async function applyEventInner(
	matchId: string,
	event: MatchEvent,
	io: ManagerIO,
): Promise<MatchState | null> {
	let state = states.get(matchId);
	if (!state) {
		const loaded = await loadOrSeed(matchId);
		if (!loaded) return null;
		state = loaded;
		states.set(matchId, state);
	}

	const { state: next, effects } = apply(state, event);
	states.set(matchId, next);
	if (effects.length > 0) await runEffects(next, effects, io);
	// Drop resolved matches from memory once effects have run.
	if (next.phase === 'resolved') {
		states.delete(matchId);
	}
	return next;
}

/**
 * Apply an event to a match. Loads state if not yet cached. Runs effects.
 * Called from WS / REST handlers and the reconciler tick.
 * Serialized per-match via promise chain — no concurrent mutations.
 * Effects that re-enter (replay_game) use applyEventInner to avoid deadlock.
 */
export async function applyEvent(
	matchId: string,
	event: MatchEvent,
	io: ManagerIO,
): Promise<MatchState | null> {
	return withLock(matchId, () => applyEventInner(matchId, event, io));
}

/**
 * Seed a match state synchronously. Used when the caller has already called
 * startMatch() (challenge accept, or tournament ready_wait→active transition).
 *
 * Phase is 'awaiting_ready' — clients still need to send match-ready (e.g. to
 * unlock audio) and the per-game handshake transitions us to 'playing'.
 * Seeding as 'playing' would make those ready events no-ops by construction,
 * so the client would never get match-status with both ready, and the
 * countdown would never start. (That bug shipped to prod once. Don't repeat.)
 */
export function seedFromChallenge(opts: {
	matchId: string;
	tournamentId: string;
	playerA: string;
	playerB: string;
	seed: string;
	bestOf: number;
	wager: number;
}): MatchState {
	// Idempotent: a match can be seeded from multiple call sites (challenge
	// accept, loadOrSeed on first event after restart, etc). The first seed
	// wins; subsequent calls return the existing state without clobbering
	// the wager/bestOf the first call established.
	const existing = states.get(opts.matchId);
	if (existing) return existing;
	const state = initialState({ ...opts, now: now() });
	states.set(opts.matchId, state);
	return state;
}

/**
 * Reconciler tick — call periodically for all live matches.
 */
export async function reconcile(matchId: string, io: ManagerIO): Promise<void> {
	const state = states.get(matchId) ?? (await loadOrSeed(matchId));
	if (!state) return;
	if (state.phase === 'resolved') return;
	const onlineA = io.isOnline(state.playerA);
	const onlineB = io.isOnline(state.playerB);
	await applyEvent(matchId, { type: 'reconcile', now: now(), onlineA, onlineB }, io);
}

/** Remove a stale match from in-memory state. */
export function cleanupMatch(matchId: string): void {
	states.delete(matchId);
	locks.delete(matchId);
}

/** Iterate all live in-memory matches (for the tick). */
export function liveMatchIds(): string[] {
	return Array.from(states.keys());
}
