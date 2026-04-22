/**
 * Pure unit tests for the match-machine reducer.
 *
 * No server, no DB, no WebSockets. Just state + event → {state, effects}.
 * These tests pin every state transition rule. If any fail, the machine
 * is wrong — don't proceed to wire it up.
 */

import { assert, assertEqual, runTest } from './harness';
import {
	apply,
	initialState,
	MatchEvent,
	MatchState,
	Effect,
	READY_TTL_MS,
	READY_OFFLINE_GRACE_MS,
	DONE_OFFLINE_GRACE_MS,
	STUCK_BOTH_OFFLINE_MS,
	GAME_COUNTDOWN_MS,
} from '../server/match-machine';

function seed(overrides: Partial<Parameters<typeof initialState>[0]> = {}): MatchState {
	return initialState({
		matchId: 't/R0M0',
		tournamentId: 't',
		playerA: 'alice',
		playerB: 'bob',
		seed: 'abc123',
		bestOf: 1,
		wager: 0,
		now: 1000,
		...overrides,
	});
}

function effectTypes(effects: Effect[]): string[] {
	return effects.map((e) => e.type);
}

// ─── Phase: awaiting_ready ─────────────────────────────────────────

runTest('machine: initial state is awaiting_ready with no flags', async () => {
	const s = seed();
	assertEqual(s.phase, 'awaiting_ready');
	assertEqual(s.ready.A, false);
	assertEqual(s.ready.B, false);
	assertEqual(s.done.A, false);
	assertEqual(s.done.B, false);
	assertEqual(s.currentGame, 1);
	assertEqual(s.wins.A, 0);
	assertEqual(s.wins.B, 0);
});

runTest('machine: one ready sets flag + broadcasts status + stays awaiting', async () => {
	const s0 = seed();
	const r = apply(s0, { type: 'ready', nametag: 'alice', now: 2000 });
	assertEqual(r.state.phase, 'awaiting_ready');
	assertEqual(r.state.ready.A, true);
	assertEqual(r.state.ready.B, false);
	assertEqual(r.state.firstReadyAt, 2000);
	assertEqual(effectTypes(r.effects), ['broadcast_status']);
});

runTest('machine: both ready → phase flips to playing, emits match-start to both', async () => {
	let s = seed();
	s = apply(s, { type: 'ready', nametag: 'alice', now: 2000 }).state;
	const r = apply(s, { type: 'ready', nametag: 'bob', now: 2500 });
	assertEqual(r.state.phase, 'playing');
	assertEqual(r.state.ready.A, true);
	assertEqual(r.state.ready.B, true);
	// Game 1 start also emits persist_match_started to promote DB status.
	assertEqual(effectTypes(r.effects), ['broadcast_status', 'send_match_start', 'send_match_start', 'persist_match_started']);
	// Countdown begins at now + 3s
	const starts = r.effects.filter((e) => e.type === 'send_match_start') as any[];
	assertEqual(starts[0].startsAt, 2500 + GAME_COUNTDOWN_MS);
});

runTest('machine: non-participant ready is ignored', async () => {
	const s0 = seed();
	const r = apply(s0, { type: 'ready', nametag: 'eve', now: 2000 });
	assertEqual(r.state, s0, 'state unchanged');
	assertEqual(r.effects.length, 0);
});

runTest('machine: re-ready from same player is idempotent (no state change)', async () => {
	let s = seed();
	s = apply(s, { type: 'ready', nametag: 'alice', now: 2000 }).state;
	const r = apply(s, { type: 'ready', nametag: 'alice', now: 2100 });
	assertEqual(r.state.ready.A, true);
	assertEqual(r.state.phase, 'awaiting_ready');
	// firstReadyAt unchanged
	assertEqual(r.state.firstReadyAt, 2000);
	// Re-broadcast but no other effects
	assertEqual(effectTypes(r.effects), ['broadcast_status']);
});

// ─── Phase: playing ────────────────────────────────────────────────

runTest('machine: ready event in playing phase is a no-op (reconnect case)', async () => {
	let s = seed();
	s = apply(s, { type: 'ready', nametag: 'alice', now: 2000 }).state;
	s = apply(s, { type: 'ready', nametag: 'bob', now: 2500 }).state;
	assertEqual(s.phase, 'playing');
	const r = apply(s, { type: 'ready', nametag: 'alice', now: 3000 });
	// This was the production bug: re-ready during play used to reset flags
	// and broadcast {me=false, opp=true} → other side saw "READY EXPIRED".
	// In the state machine it is literally impossible: no state change, no
	// side-effects emitted.
	assertEqual(r.state, s, 'state unchanged');
	assertEqual(r.effects.length, 0);
});

runTest('machine: one done in playing — no phase change yet', async () => {
	let s = seed();
	s = apply(s, { type: 'ready', nametag: 'alice', now: 1 }).state;
	s = apply(s, { type: 'ready', nametag: 'bob', now: 2 }).state;
	const r = apply(s, { type: 'done', nametag: 'alice', now: 10 });
	assertEqual(r.state.phase, 'playing');
	assertEqual(r.state.done.A, true);
	assertEqual(r.state.firstDoneAt, 10);
	// First done now emits replay_dead_player so the alive player can see
	// the dead player's score via polling.
	assertEqual(r.effects.length, 1);
	assertEqual((r.effects[0] as any).type, 'replay_dead_player');
});

runTest('machine: both done → resolving + replay effect', async () => {
	let s = seed();
	s = apply(s, { type: 'ready', nametag: 'alice', now: 1 }).state;
	s = apply(s, { type: 'ready', nametag: 'bob', now: 2 }).state;
	s = apply(s, { type: 'done', nametag: 'alice', now: 10 }).state;
	const r = apply(s, { type: 'done', nametag: 'bob', now: 15 });
	assertEqual(r.state.phase, 'resolving');
	assertEqual(effectTypes(r.effects), ['replay_game']);
	const replay = r.effects[0] as any;
	assertEqual(replay.gameNumber, 1);
	assertEqual(replay.seed, 'abc123');
});

runTest('machine: done before ready is a no-op', async () => {
	const s0 = seed();
	const r = apply(s0, { type: 'done', nametag: 'alice', now: 10 });
	assertEqual(r.state, s0);
	assertEqual(r.effects.length, 0);
});

// ─── Phase: resolving → resolved (Bo1) ─────────────────────────────

runTest('machine: Bo1 resolution — persist + advance + match-end + no wager', async () => {
	let s = seed({ bestOf: 1, wager: 0 });
	s = apply(s, { type: 'ready', nametag: 'alice', now: 1 }).state;
	s = apply(s, { type: 'ready', nametag: 'bob', now: 2 }).state;
	s = apply(s, { type: 'done', nametag: 'alice', now: 10 }).state;
	s = apply(s, { type: 'done', nametag: 'bob', now: 15 }).state;
	const r = apply(s, {
		type: 'game_resolved', now: 20,
		gameWinner: 'alice', scoreA: 100, scoreB: 50,
	});
	assertEqual(r.state.phase, 'resolved');
	assertEqual(r.state.wins.A, 1);
	assertEqual(r.state.wins.B, 0);
	assertEqual(effectTypes(r.effects), [
		'persist_result', 'advance_bracket', 'send_match_end',
	]);
	const end = r.effects.find((e) => e.type === 'send_match_end') as any;
	assertEqual(end.seriesEnd, false); // Bo1 — not a series end
	assertEqual(end.winner, 'alice');
});

runTest('machine: Bo1 with wager — settles at resolution', async () => {
	let s = seed({ bestOf: 1, wager: 50 });
	s = apply(s, { type: 'ready', nametag: 'alice', now: 1 }).state;
	s = apply(s, { type: 'ready', nametag: 'bob', now: 2 }).state;
	s = apply(s, { type: 'done', nametag: 'alice', now: 10 }).state;
	s = apply(s, { type: 'done', nametag: 'bob', now: 15 }).state;
	const r = apply(s, {
		type: 'game_resolved', now: 20,
		gameWinner: 'bob', scoreA: 50, scoreB: 100,
	});
	const settle = r.effects.find((e) => e.type === 'settle_wager') as any;
	assert(settle, 'wager settled');
	assertEqual(settle.winner, 'bob');
	assertEqual(settle.loser, 'alice');
	assertEqual(settle.amount, 50);
});

// ─── Series progression (Bo3) ─────────────────────────────────────

function playGame(state: MatchState, winner: string, atTick: number): MatchState {
	const after: MatchState[] = [state];
	after.push(apply(after[after.length - 1], { type: 'ready', nametag: state.playerA, now: atTick + 1 }).state);
	after.push(apply(after[after.length - 1], { type: 'ready', nametag: state.playerB, now: atTick + 2 }).state);
	after.push(apply(after[after.length - 1], { type: 'done', nametag: state.playerA, now: atTick + 10 }).state);
	after.push(apply(after[after.length - 1], { type: 'done', nametag: state.playerB, now: atTick + 11 }).state);
	return apply(after[after.length - 1], {
		type: 'game_resolved', now: atTick + 12,
		gameWinner: winner, scoreA: winner === state.playerA ? 100 : 50,
		scoreB: winner === state.playerB ? 100 : 50,
	}).state;
}

runTest('machine: Bo3 2-0 sweep — resolves on game 2 with seriesEnd=true', async () => {
	let s = seed({ bestOf: 3 });
	s = playGame(s, 'alice', 0);
	assertEqual(s.phase, 'resolving', 'after game 1 resolved: phase=resolving (interim)');
	assertEqual(s.wins.A, 1);
	s = apply(s, { type: 'advance_to_next_game', now: 100, newSeed: 'def456' }).state;
	assertEqual(s.phase, 'awaiting_ready');
	assertEqual(s.currentGame, 2);
	s = playGame(s, 'alice', 200);
	assertEqual(s.phase, 'resolved');
	assertEqual(s.wins.A, 2);
	assertEqual(s.wins.B, 0);
});

runTest('machine: Bo3 2-1 — 3 games played, resolved on game 3', async () => {
	let s = seed({ bestOf: 3 });
	s = playGame(s, 'alice', 0);
	s = apply(s, { type: 'advance_to_next_game', now: 100, newSeed: 'g2' }).state;
	s = playGame(s, 'bob', 200);      // 1-1
	assertEqual(s.phase, 'resolving');
	assertEqual(s.wins.A, 1);
	assertEqual(s.wins.B, 1);
	s = apply(s, { type: 'advance_to_next_game', now: 300, newSeed: 'g3' }).state;
	s = playGame(s, 'alice', 400);   // 2-1
	assertEqual(s.phase, 'resolved');
	assertEqual(s.wins.A, 2);
	assertEqual(s.wins.B, 1);
});

runTest('machine: interim game emits game-result not match-end', async () => {
	let s = seed({ bestOf: 3 });
	s = apply(s, { type: 'ready', nametag: 'alice', now: 1 }).state;
	s = apply(s, { type: 'ready', nametag: 'bob', now: 2 }).state;
	s = apply(s, { type: 'done', nametag: 'alice', now: 10 }).state;
	s = apply(s, { type: 'done', nametag: 'bob', now: 11 }).state;
	const r = apply(s, {
		type: 'game_resolved', now: 12,
		gameWinner: 'alice', scoreA: 100, scoreB: 50,
	});
	// Interim game emits game-result + persists series progress so a
	// server restart can resume at the right score.
	assertEqual(effectTypes(r.effects), ['send_game_result', 'persist_series_progress']);
	// Series isn't over → no match-end, no final persist yet
	assert(!r.effects.some((e) => e.type === 'send_match_end'));
	assert(!r.effects.some((e) => e.type === 'persist_result'));
});

runTest('machine: advance_to_next_game resets per-game flags, increments counter', async () => {
	let s = seed({ bestOf: 3 });
	s = playGame(s, 'alice', 0);
	const r = apply(s, { type: 'advance_to_next_game', now: 100, newSeed: 'g2' });
	assertEqual(r.state.phase, 'awaiting_ready');
	assertEqual(r.state.currentGame, 2);
	assertEqual(r.state.seed, 'g2');
	assertEqual(r.state.ready.A, false);
	assertEqual(r.state.ready.B, false);
	assertEqual(r.state.done.A, false);
	assertEqual(r.state.done.B, false);
	assertEqual(r.state.firstReadyAt, null);
	assertEqual(r.state.firstDoneAt, null);
	// Wins carry over
	assertEqual(r.state.wins.A, 1);
});

// ─── Reconciler ─────────────────────────────────────────────────────

runTest('reconcile: no-op when nothing has happened', async () => {
	const s0 = seed();
	const r = apply(s0, { type: 'reconcile', now: 2000, onlineA: true, onlineB: true });
	assertEqual(r.state, s0);
	assertEqual(r.effects.length, 0);
});

runTest('reconcile: 30s TTL clears ready flags + notifies both', async () => {
	let s = seed();
	s = apply(s, { type: 'ready', nametag: 'alice', now: 1000 }).state;
	const r = apply(s, {
		type: 'reconcile',
		now: 1000 + READY_TTL_MS + 100,
		onlineA: true, onlineB: true,
	});
	assertEqual(r.state.ready.A, false);
	assertEqual(r.state.firstReadyAt, null);
	const types = effectTypes(r.effects);
	assert(types.includes('send_ready_expired'));
	assert(types.includes('broadcast_status'));
});

runTest('reconcile: 5s offline grace auto-readies opponent → match starts', async () => {
	// Auto-ready of offline opponents now happens synchronously in applyReady
	// for challenge-prefixed matches, not via the reconciler's 5s grace
	// (READY_OFFLINE_GRACE_MS = Infinity disables the reconcile path).
	let s = seed({ matchId: 'challenge-t/R0M0', tournamentId: 'challenge-t' });
	const r = apply(s, { type: 'ready', nametag: 'alice', now: 1000, opponentOnline: false });
	assertEqual(r.state.ready.A, true);
	assertEqual(r.state.ready.B, true);
	assertEqual(r.state.phase, 'playing', 'auto-ready flipped phase to playing');
	assert(effectTypes(r.effects).includes('send_match_start'));
});

runTest('reconcile: online opponent is NOT auto-readied even at 5s', async () => {
	let s = seed();
	s = apply(s, { type: 'ready', nametag: 'alice', now: 1000 }).state;
	const r = apply(s, {
		type: 'reconcile',
		now: 1000 + READY_OFFLINE_GRACE_MS + 100,
		onlineA: true, onlineB: true, // both online
	});
	assertEqual(r.state.ready.B, false, 'online opponent not force-readied');
});

runTest('reconcile: 30s auto-done for offline opponent after first done', async () => {
	let s = seed();
	s = apply(s, { type: 'ready', nametag: 'alice', now: 1 }).state;
	s = apply(s, { type: 'ready', nametag: 'bob', now: 2 }).state;
	s = apply(s, { type: 'done', nametag: 'alice', now: 10 }).state; // firstDoneAt=10

	const r = apply(s, {
		type: 'reconcile',
		now: 10 + DONE_OFFLINE_GRACE_MS + 100,
		onlineA: true, onlineB: false,
	});
	assertEqual(r.state.done.A, true);
	assertEqual(r.state.done.B, true);
	assertEqual(r.state.phase, 'resolving');
	assert(effectTypes(r.effects).includes('replay_game'));
});

runTest('reconcile: both offline 45s+ → force-resolve', async () => {
	let s = seed();
	s = apply(s, { type: 'ready', nametag: 'alice', now: 1 }).state;
	s = apply(s, { type: 'ready', nametag: 'bob', now: 2 }).state;
	// phaseEnteredAt = 2 (when it flipped to playing)
	const r = apply(s, {
		type: 'reconcile',
		now: 2 + STUCK_BOTH_OFFLINE_MS + 100,
		onlineA: false, onlineB: false,
	});
	assertEqual(r.state.phase, 'resolved');
	const end = r.effects.find((e) => e.type === 'send_match_end') as any;
	assert(end, 'match-end emitted');
	assertEqual(end.winner, 'alice', 'deterministic: playerA wins on dual-offline');
});

runTest('reconcile is idempotent — running twice = once', async () => {
	let s = seed();
	s = apply(s, { type: 'ready', nametag: 'alice', now: 1000 }).state;
	const r1 = apply(s, {
		type: 'reconcile',
		now: 1000 + READY_TTL_MS + 100,
		onlineA: true, onlineB: true,
	});
	const r2 = apply(r1.state, {
		type: 'reconcile',
		now: 1000 + READY_TTL_MS + 200,
		onlineA: true, onlineB: true,
	});
	// First call cleared flags. Second call should find nothing to do.
	assertEqual(r2.effects.length, 0);
});

// ─── Invalid transitions ────────────────────────────────────────────

runTest('machine: game_resolved in non-resolving phase is ignored', async () => {
	const s = seed();
	const r = apply(s, {
		type: 'game_resolved', now: 100,
		gameWinner: 'alice', scoreA: 1, scoreB: 0,
	});
	assertEqual(r.state, s);
	assertEqual(r.effects.length, 0);
});

runTest('machine: advance_to_next_game in non-resolving phase is ignored', async () => {
	const s = seed();
	const r = apply(s, { type: 'advance_to_next_game', now: 100, newSeed: 'x' });
	assertEqual(r.state, s);
	assertEqual(r.effects.length, 0);
});
