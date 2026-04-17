/**
 * WebSocket entry points for live tournament matches.
 *
 * This module is a thin protocol/transport layer. All match-state
 * logic lives in match-machine.ts (pure reducer) + match-manager.ts
 * (effect executor). These handlers translate WS/REST messages into
 * MatchEvents, delegate to the manager, and surface errors back to
 * the caller. There are no in-memory mirrors of match state here —
 * the machine is the single source of truth.
 *
 * The only in-memory maps here are the WS registries (`players`,
 * `sockets`) — everything else is in the state machine.
 */

import type { WebSocket } from 'ws';
import {
	getMatch,
	getTournament,
	storeInput,
} from './tournament-db';
import { now } from './clock';
import * as manager from './match-manager';
import type { ServerMessage, MatchStartMessage } from '../protocol/messages';

/** Connected players: nametag → socket */
const players = new Map<string, WebSocket>();
/** Socket → nametag reverse mapping */
const sockets = new Map<WebSocket, string>();

/** IO adapter bound to this module's socket routing. */
const managerIO: manager.ManagerIO = {
	sendTo(nametag, msg) { sendTo(nametag, msg); },
	isOnline(nametag) { return !!players.get(nametag); },
};

/**
 * Project the live machine state into a shape the /api/.../state endpoint
 * can return. Returns nulls when the match isn't in the machine (e.g.
 * hasn't been touched since server boot) — callers should fall back to
 * the DB row's `status` to decide if the match is pre-ready / resolved.
 * `fallbackSides` lets the endpoint still show online-flags for ready_wait
 * matches that haven't seeded the machine yet.
 */
export function getMatchLiveState(
	matchId: string,
	fallbackSides?: { A: string; B: string } | null,
): {
	ready: { A: boolean; B: boolean } | null;
	done: { A: boolean; B: boolean } | null;
	online: { A: boolean; B: boolean } | null;
	series: {
		bestOf: number;
		winsA: number;
		winsB: number;
		currentGame: number;
		currentSeed: string;
	} | null;
	machinePhase: string | null;
	lastGameResult: { scoreA: number; scoreB: number; winner: string } | null;
} {
	// Machine state is the ONLY source of truth. If the match isn't in the
	// machine, we have no live state to project — callers should fall back
	// to DB status for the phase.
	const machineState = manager.getState(matchId);

	const sideAB =
		(machineState ? { A: machineState.playerA, B: machineState.playerB } : null) ??
		(fallbackSides && fallbackSides.A && fallbackSides.B ? fallbackSides : null);

	const ready = machineState
		? { A: machineState.ready.A, B: machineState.ready.B }
		: null;

	const done = machineState
		? { A: machineState.done.A, B: machineState.done.B }
		: null;

	const online = sideAB
		? { A: !!players.get(sideAB.A), B: !!players.get(sideAB.B) }
		: null;

	const seriesOut = machineState && machineState.bestOf > 1
		? {
			bestOf: machineState.bestOf,
			winsA: machineState.wins.A,
			winsB: machineState.wins.B,
			currentGame: machineState.currentGame,
			currentSeed: machineState.seed,
		}
		: null;

	return {
		ready, done, online, series: seriesOut,
		machinePhase: machineState?.phase ?? null,
		lastGameResult: machineState?.lastGameResult ?? null,
	};
}

export function registerSocket(ws: WebSocket, nametag: string): void {
	// Clean up old socket for same nametag
	const old = players.get(nametag);
	if (old && old !== ws) {
		sockets.delete(old);
	}
	players.set(nametag, ws);
	sockets.set(ws, nametag);
}

export function unregisterSocket(ws: WebSocket): void {
	const nametag = sockets.get(ws);
	if (nametag && players.get(nametag) === ws) {
		players.delete(nametag);
	}
	sockets.delete(ws);
}

export function getNametag(ws: WebSocket): string | undefined {
	return sockets.get(ws);
}

/** Get all connected player nametags. */
export function getOnlinePlayers(): string[] {
	return Array.from(players.keys());
}

/**
 * Send a typed ServerMessage to a single player. Typed so adding a
 * field to a message in protocol/messages.ts forces every sender here
 * to match.
 */
export function sendTo(nametag: string, msg: ServerMessage): void {
	const ws = players.get(nametag);
	if (ws?.readyState === 1) {
		ws.send(JSON.stringify(msg));
	}
}

export function broadcastToAll(msg: ServerMessage): void {
	const encoded = JSON.stringify(msg);
	for (const ws of players.values()) {
		if (ws.readyState === 1) ws.send(encoded);
	}
}

/** Outcome of applyReady() — used by both the WS and REST entry points. */
type ReadyResult =
	| { ok: true; phase: 'reconnected' | 'waiting' | 'started'; matchStart?: MatchStartPayload }
	| { ok: false; status: 404 | 403 | 409; code: string; message: string };

type MatchStartPayload = MatchStartMessage;

/**
 * Core match-ready logic, usable from both WS and REST.
 *
 *   - Validates the match exists, caller is a participant, phase is valid.
 *   - Sets ready flags; auto-readies offline opponents; schedules fallback.
 *   - When both ready, starts the match and returns the match-start payload.
 *   - Broadcasts match-status / match-start to both players over WS as side
 *     effect (a caller with a zombie WS won't receive it, but the opponent
 *     will, and the REST caller sees state via the return value).
 *
 * Idempotent: calling twice while the state hasn't changed has the same
 * effect as calling once. Active-match re-readies are debounced (1.5s) to
 * prevent ping-pong loops with buggy clients.
 */
export async function applyReady(nametag: string, matchId: string): Promise<ReadyResult> {
	const match = await getMatch(matchId);
	if (!match) {
		return { ok: false, status: 404, code: 'not_found', message: `Match ${matchId} not found` };
	}

	const playerA = match.player_a as string;
	const playerB = match.player_b as string;
	if (nametag !== playerA && nametag !== playerB) {
		return { ok: false, status: 403, code: 'not_in_match', message: 'You are not in this match' };
	}

	const tournamentId = match.tournament_id as string;
	const tournament = tournamentId ? await getTournament(tournamentId) : null;
	const bestOf = (tournament?.best_of as number) || 1;

	if (match.status !== 'active' && match.status !== 'ready_wait') {
		return { ok: false, status: 409, code: 'wrong_phase', message: `Match is ${match.status}` };
	}

	// All ready handling lives in the machine now — it loads state from DB if
	// this is the first event after a server restart, applies the ready
	// transition, and emits broadcast_status / send_match_start effects.
	const prev = manager.getState(matchId);
	const opponentName = nametag === playerA ? playerB : playerA;
	const next = await manager.applyEvent(
		matchId,
		{
			type: 'ready',
			nametag,
			now: now(),
			opponentOnline: !!players.get(opponentName),
		},
		managerIO,
	);
	if (!next) {
		return { ok: false, status: 404, code: 'not_found', message: 'Match state unavailable' };
	}

	// DB status promotion is driven by the `persist_match_started` effect
	// inside the machine — fires on the first awaiting_ready → playing
	// transition. Nothing to do here.

	const opponent = nametag === playerA ? playerB : playerA;
	const youAre: 'A' | 'B' = nametag === playerA ? 'A' : 'B';
	const matchStart: MatchStartPayload = {
		type: 'match-start', v: 0, matchId,
		seed: next.seed, opponent, youAre,
		gameNumber: next.currentGame,
		startsAt: Date.now() + 3000, timeCapTicks: 36000, bestOf, tournamentId,
	};

	// Reconnect case: machine no-op'd because phase was already 'playing'.
	// Send match-start to the caller so their client can re-sync. The "both
	// just readied" case is handled by the machine's send_match_start effect.
	const wasReconnect = prev?.phase === 'playing' && next.phase === 'playing';
	if (wasReconnect) sendTo(nametag, matchStart);

	const phase = next.phase === 'playing'
		? (wasReconnect ? 'reconnected' : 'started')
		: 'waiting';
	return { ok: true, phase, matchStart };
}

/**
 * WS entry point: translate applyReady result to an error message on failure.
 * On success, side-effect pushes already happened inside applyReady.
 */
export async function handleReady(nametag: string, matchId: string): Promise<void> {
	const result = await applyReady(nametag, matchId);
	if (!result.ok) {
		sendTo(nametag, { type: 'error', v: 0, code: result.code, message: result.message });
	}
}

/**
 * Reconciliation pass for a single ready_wait / active match. Called from
 * the server's 1s tick. Replaces the previous setTimeout-based fallbacks
 * with state-based checks against now(), so tests can fast-forward and
 * production behavior is easier to reason about.
 *
 * Idempotent: running twice in a row produces the same state as once.
 */
export async function reconcileMatch(matchId: string): Promise<void> {
	const match = await getMatch(matchId);
	if (!match) return;

	const playerA = match.player_a as string;
	const playerB = match.player_b as string;
	if (!playerA || !playerB) return;

	// All reconcile rules (ready TTL, offline grace, force-resolve, series
	// advance timers) are now machine-internal. reconcile loadOrSeeds if
	// needed, so server-restart + fresh match tick both work.
	if (match.status === 'active' || match.status === 'ready_wait') {
		await manager.reconcile(matchId, managerIO);
	}
}

/**
 * Handle an input message — relay to opponent and store.
 */
export async function handleInput(
	nametag: string,
	matchId: string,
	tick: number,
	payload: string,
): Promise<void> {
	// Sides + currentGame both come from the machine — the only source of
	// truth for an in-flight match. Inputs only flow during play, and the
	// machine is always seeded by then (at challenge accept or at both-ready).
	const machineState = manager.getState(matchId);
	if (!machineState) return;
	// Reject inputs once both players are done (resolving/resolved). Late
	// inputs arriving after match-done (e.g. from the WS queue flush) would
	// corrupt the replay — the server replays whatever is in the DB at
	// replay time, so extra inputs change the score.
	if (machineState.phase === 'resolving' || machineState.phase === 'resolved') return;

	const side = nametag === machineState.playerA ? 'A' : nametag === machineState.playerB ? 'B' : null;
	if (!side) return;

	// For series games, tag with game number in the side field (e.g., "A:g2").
	// Reading from machine state ensures the tag matches the replay lookup.
	const currentGame = machineState.currentGame;
	const tagged = currentGame > 1 ? `${side}:g${currentGame}` : side;
	await storeInput(matchId, tagged, tick, payload);

	// Relay to opponent
	const opponent = side === 'A' ? machineState.playerB : machineState.playerA;
	sendTo(opponent, { type: 'opponent-input', v: 0, matchId, tick, payload });
}

async function getGameInputs(matchId: string, gameNumber: number, side: string): Promise<Array<{ tick: number; payload: string }>> {
	const tagged = gameNumber > 1 ? `${side}:g${gameNumber}` : side;
	const { getInputs } = await import('./tournament-db');
	return getInputs(matchId, tagged) as any;
}

async function setMatchWinnerAndAdvance(matchId: string, winner: string, scoreA: number, scoreB: number, tournamentId: string): Promise<void> {
	const { updateMatchResult } = await import('./tournament-db');
	const { checkRoundAdvance, advanceWinnerExternal } = await import('./tournament-logic');
	await updateMatchResult(matchId, winner, scoreA, scoreB);
	const match = await getMatch(matchId);
	if (match) {
		await advanceWinnerExternal(tournamentId, match.round as number, match.slot as number, winner);
	}
	await checkRoundAdvance(tournamentId);
}

/**
 * Handle a "done" message — player's game is over. All logic lives in
 * the state machine; this wrapper just routes the event and broadcasts
 * the bracket-update push when the machine drops the resolved state.
 */
export async function handleDone(nametag: string, matchId: string): Promise<void> {
	const result = await manager.applyEvent(matchId, { type: 'done', nametag, now: now() }, managerIO);
	if (!result) {
		console.log(`[handleDone] ${matchId}: ${nametag} done but match not found`);
		return;
	}
	if (!manager.getState(matchId)) {
		// Match resolved → machine dropped the state → push bracket-update.
		broadcastToAll({ type: 'bracket-update', v: 0, matchId });
	}
}
