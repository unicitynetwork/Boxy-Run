/**
 * Challenge invitation system — 1v1 peer invites. Unified with the tournament
 * match code: an accepted challenge just creates a 2-player "challenge-*"
 * tournament that runs through the exact same match lifecycle.
 *
 * The applyChallenge* functions are pure-ish cores usable from both WS and
 * REST (like applyReady). They return structured results; callers translate
 * to WS errors or HTTP status codes.
 *
 * Side effects (sendTo broadcasts to invitee / challenger) live inside the
 * applier so both transports produce consistent real-time pushes.
 */

import { getDb, ensureSchema } from './db';
import { now } from './clock';
import { sendTo, getOnlinePlayers } from './tournament-ws';
import * as manager from './match-manager';
import { createTournament, getMatchesForRound, registerPlayer } from './tournament-db';
import { startTournament, startMatch } from './tournament-logic';

// ── State ────────────────────────────────────────────────────────────

export interface PendingChallenge {
	id: string;
	from: string;
	to: string;
	wager: number;
	bestOf: number;
	createdAt: number;
}

const pending = new Map<string, PendingChallenge>();
let counter = 0;

export const CHALLENGE_EXPIRY_MS = 30_000;

/** Test-only: reset in-memory challenge state. */
export function _resetChallenges(): void {
	pending.clear();
	counter = 0;
}

export function getPendingChallenge(id: string): PendingChallenge | undefined {
	return pending.get(id);
}

// When a challenge is accepted, store the result so the challenger can poll it.
const acceptedChallenges = new Map<string, {
	matchId: string; tournamentId: string; seed: string;
	playerA: string; playerB: string; bestOf: number;
}>();

/** Get the status of a challenge: pending, accepted (with match details), or expired. */
export function getChallengeStatus(id: string): any {
	if (pending.has(id)) return { status: 'pending' };
	const accepted = acceptedChallenges.get(id);
	if (accepted) return { status: 'accepted', ...accepted };
	return { status: 'expired' };
}

/** Get all pending challenges TO a player (incoming invites). */
export function getPendingChallengesFor(nametag: string): PendingChallenge[] {
	const result: PendingChallenge[] = [];
	for (const ch of pending.values()) {
		if (ch.to === nametag) result.push(ch);
	}
	return result;
}

// ── Balance helper ───────────────────────────────────────────────────

async function getBalance(nametag: string): Promise<number> {
	await ensureSchema();
	const db = getDb();
	const r = await db.execute({
		sql: 'SELECT COALESCE(SUM(amount), 0) as balance FROM player_transactions WHERE nametag = ?',
		args: [nametag],
	});
	return (r.rows[0]?.balance as number) ?? 0;
}

// ── Apply functions ──────────────────────────────────────────────────

export type ChallengeErrorCode =
	| 'opponent_offline'
	| 'self_challenge'
	| 'insufficient_balance'
	| 'invalid_challenge'
	| 'challenge_failed';

export type ChallengeResult<T = unknown> =
	| { ok: true; data: T }
	| { ok: false; status: 400 | 403 | 404 | 409; code: ChallengeErrorCode; message: string };

/**
 * Send a new challenge from `from` to `opponent`. Validates the invitation
 * precondition (opponent online, not self, challenger has balance), stores
 * the pending challenge, and pushes `challenge-sent` + `challenge-received`
 * over WS to both sides.
 */
export async function applyChallenge(
	from: string,
	opponent: string,
	wager: number,
	bestOf: number,
): Promise<ChallengeResult<{ challengeId: string }>> {
	if (!getOnlinePlayers().includes(opponent)) {
		return { ok: false, status: 409, code: 'opponent_offline', message: `${opponent} is not online` };
	}
	if (from === opponent) {
		return { ok: false, status: 400, code: 'self_challenge', message: 'Cannot challenge yourself' };
	}
	if (wager > 0) {
		const bal = await getBalance(from);
		if (bal < wager) {
			return { ok: false, status: 403, code: 'insufficient_balance', message: `Insufficient balance (${bal} UCT). Need ${wager} UCT.` };
		}
	}

	// Cancel any existing pending challenge FROM this sender (to anyone).
	// Without this, rapid clicks or rematches create duplicate pending
	// challenges. The old ones expire later and push stale challenge-declined
	// messages that disrupt the active game.
	for (const [existingId, ch] of pending) {
		if (ch.from === from) {
			pending.delete(existingId);
		}
	}

	const id = `ch-${++counter}`;
	const record: PendingChallenge = { id, from, to: opponent, wager, bestOf, createdAt: now() };
	pending.set(id, record);

	sendTo(from, { type: 'challenge-sent', v: 0, challengeId: id, opponent, wager, bestOf });
	sendTo(opponent, { type: 'challenge-received', v: 0, challengeId: id, from, wager, bestOf });

	return { ok: true, data: { challengeId: id } };
}

/**
 * Accept a pending challenge. Creates the 2-player tournament, starts the
 * match, notifies both sides via `challenge-start`.
 */
export async function applyChallengeAccept(
	acceptor: string,
	challengeId: string,
): Promise<ChallengeResult<{ matchId: string; seed: string; tournamentId: string }>> {
	const ch = pending.get(challengeId);
	if (!ch || ch.to !== acceptor) {
		return { ok: false, status: 404, code: 'invalid_challenge', message: 'Challenge not found' };
	}
	pending.delete(challengeId);

	// Cancel ALL other pending challenges involving either player.
	// Without this, stale invites expire later and push challenge-declined
	// messages that disrupt the active game with "CHALLENGE EXPIRED" overlays.
	for (const [id, other] of pending) {
		if (other.from === ch.from || other.from === acceptor ||
			other.to === ch.from || other.to === acceptor) {
			pending.delete(id);
		}
	}


	if (ch.wager > 0) {
		const bal = await getBalance(acceptor);
		if (bal < ch.wager) {
			// Notify the challenger that acceptor declined due to balance
			sendTo(ch.from, { type: 'challenge-declined', v: 0, challengeId, by: acceptor });
			return { ok: false, status: 403, code: 'insufficient_balance', message: `Insufficient balance (${bal} UCT). Need ${ch.wager} UCT.` };
		}
	}

	try {
		const tId = `challenge-${Date.now()}`;
		// IMPORTANT: pass bestOf so server-restart mid-series correctly resumes
		// the right format (loadOrSeed reads tournament.best_of from the DB).
		await createTournament({
			id: tId,
			name: `${ch.from} vs ${ch.to}`,
			maxPlayers: 2,
			bestOf: ch.bestOf,
			startsAt: new Date().toISOString(),
		});
		await registerPlayer(tId, ch.from);
		await registerPlayer(tId, ch.to);
		await startTournament(tId);

		const matches = await getMatchesForRound(tId, 0);
		const match = matches.find((m) => m.status === 'ready_wait');
		if (!match) {
			return { ok: false, status: 409, code: 'challenge_failed', message: 'Match not created' };
		}

		const result = await startMatch(match.id as string);
		const startsAt = Date.now() + 3000;
		const matchId = match.id as string;

		// Seed the state machine for ALL challenges (Bo1 too). The wager
		// rides on machine state.wager — the only source of truth. Previously
		// we used a separate matchWagersMap which was ignored by Bo1 lazy
		// loadOrSeed → wagers silently weren't settled.
		manager.seedFromChallenge({
			matchId,
			tournamentId: tId,
			playerA: result.playerA,
			playerB: result.playerB,
			seed: result.seed,
			bestOf: ch.bestOf,
			wager: ch.wager,
		});

		const pushBase = {
			type: 'challenge-start' as const, v: 0 as const, challengeId,
			tournamentId: tId, matchId,
			seed: result.seed, startsAt, wager: ch.wager, bestOf: ch.bestOf,
		};
		sendTo(ch.from, {
			...pushBase,
			opponent: ch.to,
			youAre: ch.from === result.playerA ? 'A' : 'B',
		});
		sendTo(ch.to, {
			...pushBase,
			opponent: ch.from,
			youAre: ch.to === result.playerA ? 'A' : 'B',
		});

		// Store so the challenger can poll the status
		acceptedChallenges.set(challengeId, {
			matchId, tournamentId: tId, seed: result.seed,
			playerA: result.playerA, playerB: result.playerB, bestOf: ch.bestOf,
		});
		// Clean up after 60s (challenger should have redirected by then)
		setTimeout(() => acceptedChallenges.delete(challengeId), 60_000);

		const acceptorSide = acceptor === result.playerA ? 'A' : 'B';
		const opponent = acceptorSide === 'A' ? result.playerB : result.playerA;
		return { ok: true, data: {
			matchId, seed: result.seed, tournamentId: tId,
			youAre: acceptorSide, opponent, bestOf: ch.bestOf,
		} };
	} catch (err: any) {
		console.error('[challenge-accept] error:', err);
		// Best-effort notify both sides
		sendTo(ch.from, { type: 'error', v: 0, code: 'challenge_failed', message: err.message });
		sendTo(acceptor, { type: 'error', v: 0, code: 'challenge_failed', message: err.message });
		return { ok: false, status: 409, code: 'challenge_failed', message: err.message };
	}
}

/** Decline a pending challenge. Idempotent — unknown/expired IDs succeed silently. */
export function applyChallengeDecline(
	decliner: string,
	challengeId: string,
): ChallengeResult<{ declined: boolean }> {
	const ch = pending.get(challengeId);
	if (!ch || ch.to !== decliner) {
		// Treat as idempotent — no one to notify, no error
		return { ok: true, data: { declined: false } };
	}
	pending.delete(challengeId);
	sendTo(ch.from, { type: 'challenge-declined', v: 0, challengeId, by: decliner });
	return { ok: true, data: { declined: true } };
}

/**
 * Reconciliation pass — expire challenges past 30s. Called from the 1s tick.
 */
export function reconcileChallenges(): void {
	const t = now();
	for (const [id, ch] of pending) {
		if (t - ch.createdAt > CHALLENGE_EXPIRY_MS) {
			pending.delete(id);
			// Notify BOTH sides so their UIs clean up:
			//   - challenger (ch.from) shows "expired" status
			//   - invitee (ch.to) can remove the pending invite banner
			// Use challenge-declined with an empty `by` to signal "expired, not
			// actively declined" (client can branch on `by === ''`).
			sendTo(ch.from, { type: 'challenge-declined', v: 0, challengeId: id, by: '' });
			sendTo(ch.to, { type: 'challenge-declined', v: 0, challengeId: id, by: '' });
			// Keep the legacy error push on the challenger side for older clients.
			sendTo(ch.from, { type: 'error', v: 0, code: 'challenge_expired', message: 'Challenge expired' });
		}
	}
}
