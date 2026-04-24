/**
 * Unified challenge system — live 1v1 invites AND shareable links.
 *
 * All challenges live in a single `pending` Map. A live challenge has a
 * `to` field (targeted at a specific player). A link challenge has
 * `to: null` and a `code` (anyone can accept). Both flow through the
 * same accept/decline/expire logic.
 *
 * When any challenge is accepted, ALL other pending challenges involving
 * either player are cancelled — no double-matches.
 *
 * Clients poll `GET /api/challenges/pending?nametag=X` every 2s to see
 * incoming challenges. WS pushes are a courtesy for faster notification
 * but the system works without them.
 */

import { getDb, ensureSchema } from './db';
import { now } from './clock';
import { sendTo, getOnlinePlayers } from './tournament-ws';
import { getBusyBots } from './bots';
import * as manager from './match-manager';
import { createTournament, getMatchesForRound, registerPlayer } from './tournament-db';
import { startTournament, startMatch } from './tournament-logic';

// ── State ────────────────────────────────────────────────────────────

export interface PendingChallenge {
	id: string;
	from: string;
	to: string | null;   // null = link challenge (anyone can accept)
	wager: number;
	bestOf: number;
	createdAt: number;
	code: string | null;  // non-null for link challenges (the shareable code)
}

const pending = new Map<string, PendingChallenge>();
let counter = 0;

export const CHALLENGE_EXPIRY_MS = 60_000;      // live challenges: 60s
export const LINK_EXPIRY_MS = 5 * 60_000;       // link challenges: 5 min

/** Test-only: reset in-memory challenge state. */
export function _resetChallenges(): void {
	pending.clear();
	acceptedChallenges.clear();
	acceptedLinks.clear();
	counter = 0;
}

export function getPendingChallenge(id: string): PendingChallenge | undefined {
	return pending.get(id);
}

// Accepted challenge results — keyed by challengeId for live, code for links.
const acceptedChallenges = new Map<string, {
	matchId: string; tournamentId: string; seed: string;
	playerA: string; playerB: string; bestOf: number;
}>();
const acceptedLinks = new Map<string, {
	matchId: string; tournamentId: string; seed: string;
	acceptedBy: string;
}>();

/** Get the status of a challenge: pending, accepted (with match details), or expired. */
export function getChallengeStatus(id: string): any {
	if (pending.has(id)) return { status: 'pending' };
	const accepted = acceptedChallenges.get(id);
	if (accepted) return { status: 'accepted', ...accepted };
	return { status: 'expired' };
}

/**
 * Get all pending challenges visible to a player:
 *   - Live challenges targeted at them (to === nametag)
 *   - Open link challenges from other players (to === null, from !== nametag)
 */
export function getPendingChallengesFor(nametag: string): PendingChallenge[] {
	const result: PendingChallenge[] = [];
	for (const ch of pending.values()) {
		if (ch.to === nametag) result.push(ch);
		else if (ch.to === null && ch.from !== nametag) result.push(ch);
	}
	return result;
}

/** Look up a pending link challenge by its shareable code. */
export function getChallengeLinkByCode(code: string): PendingChallenge | undefined {
	for (const ch of pending.values()) {
		if (ch.code === code) return ch;
	}
	return undefined;
}

/** Look up an accepted link challenge by its code (for the join page). */
export function getAcceptedLinkByCode(code: string): { matchId: string; tournamentId: string; seed: string; acceptedBy: string } | undefined {
	return acceptedLinks.get(code);
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

// ── Code generator ──────────────────────────────────────────────────

function generateCode(): string {
	const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
	let code = '';
	for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
	return code;
}

// ── Apply functions ──────────────────────────────────────────────────

export type ChallengeErrorCode =
	| 'opponent_offline'
	| 'opponent_busy'
	| 'self_challenge'
	| 'insufficient_balance'
	| 'invalid_challenge'
	| 'challenge_failed';

export type ChallengeResult<T = unknown> =
	| { ok: true; data: T }
	| { ok: false; status: 400 | 403 | 404 | 409; code: ChallengeErrorCode; message: string };

/**
 * Send a live challenge from `from` to `opponent`.
 * Cancels any existing outgoing challenges from this player.
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
	if (getBusyBots().includes(opponent)) {
		return { ok: false, status: 409, code: 'opponent_busy', message: `${opponent} is currently in a match` };
	}
	if (wager > 0) {
		const bal = await getBalance(from);
		if (bal < wager) {
			return { ok: false, status: 403, code: 'insufficient_balance', message: `Insufficient balance (${bal} UCT). Need ${wager} UCT.` };
		}
	}

	// Cancel any existing outgoing challenges (live or link) from this sender
	cancelOutgoing(from);

	const id = `ch-${++counter}`;
	const record: PendingChallenge = { id, from, to: opponent, wager, bestOf, createdAt: now(), code: null };
	pending.set(id, record);

	sendTo(from, { type: 'challenge-sent', v: 0, challengeId: id, opponent, wager, bestOf });
	sendTo(opponent, { type: 'challenge-received', v: 0, challengeId: id, from, wager, bestOf });

	return { ok: true, data: { challengeId: id } };
}

/**
 * Create a shareable challenge link. Returns a code that can be shared.
 * Cancels any existing outgoing challenges from this player.
 */
export async function createChallengeLink(
	from: string, bestOf: number, wager: number,
): Promise<ChallengeResult<{ code: string; challengeId: string }>> {
	if (wager > 0) {
		const bal = await getBalance(from);
		if (bal < wager) {
			return { ok: false, status: 403, code: 'insufficient_balance', message: `Insufficient balance (${bal} UCT). Need ${wager} UCT.` };
		}
	}

	// Cancel any existing outgoing challenges (live or link) from this sender
	cancelOutgoing(from);

	let code = generateCode();
	while ([...pending.values()].some(ch => ch.code === code)) code = generateCode();

	const id = `ch-${++counter}`;
	const record: PendingChallenge = { id, from, to: null, wager, bestOf, createdAt: now(), code };
	pending.set(id, record);
	return { ok: true, data: { code, challengeId: id } };
}

/**
 * Accept a pending challenge (live or link). Creates the 2-player
 * tournament, starts the match, notifies both sides via challenge-start.
 * Cancels ALL other pending challenges involving either player.
 */
export async function applyChallengeAccept(
	acceptor: string,
	challengeId: string,
): Promise<ChallengeResult<{ matchId: string; seed: string; tournamentId: string; youAre: string; opponent: string; bestOf: number }>> {
	const ch = pending.get(challengeId);
	if (!ch) {
		return { ok: false, status: 404, code: 'invalid_challenge', message: 'Challenge not found' };
	}
	// Live challenge: only the target can accept
	if (ch.to !== null && ch.to !== acceptor) {
		return { ok: false, status: 404, code: 'invalid_challenge', message: 'Challenge not found' };
	}
	// Link challenge: anyone except the creator can accept
	if (ch.to === null && ch.from === acceptor) {
		return { ok: false, status: 400, code: 'self_challenge', message: 'Cannot accept your own challenge' };
	}

	pending.delete(challengeId);

	// Cancel ALL other pending challenges involving either player
	for (const [id, other] of pending) {
		if (other.from === ch.from || other.from === acceptor ||
			other.to === ch.from || other.to === acceptor) {
			pending.delete(id);
		}
	}

	if (ch.wager > 0) {
		const bal = await getBalance(acceptor);
		if (bal < ch.wager) {
			sendTo(ch.from, { type: 'challenge-declined', v: 0, challengeId, by: acceptor });
			return { ok: false, status: 403, code: 'insufficient_balance', message: `Insufficient balance (${bal} UCT). Need ${ch.wager} UCT.` };
		}
	}

	try {
		const tId = `challenge-${Date.now()}`;
		await createTournament({
			id: tId,
			name: `${ch.from} vs ${acceptor}`,
			maxPlayers: 2,
			bestOf: ch.bestOf,
			startsAt: new Date().toISOString(),
		});
		await registerPlayer(tId, ch.from);
		await registerPlayer(tId, acceptor);
		await startTournament(tId);

		const matches = await getMatchesForRound(tId, 0);
		const match = matches.find((m) => m.status === 'ready_wait');
		if (!match) {
			return { ok: false, status: 409, code: 'challenge_failed', message: 'Match not created' };
		}

		const result = await startMatch(match.id as string);
		const startsAt = Date.now() + 3000;
		const matchId = match.id as string;

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
			opponent: acceptor,
			youAre: ch.from === result.playerA ? 'A' : 'B',
		});
		sendTo(acceptor, {
			...pushBase,
			opponent: ch.from,
			youAre: acceptor === result.playerA ? 'A' : 'B',
		});

		// Store so the challenger can poll the status
		acceptedChallenges.set(challengeId, {
			matchId, tournamentId: tId, seed: result.seed,
			playerA: result.playerA, playerB: result.playerB, bestOf: ch.bestOf,
		});
		setTimeout(() => acceptedChallenges.delete(challengeId), 60_000);

		// For link challenges, store accepted state by code too
		if (ch.code) {
			acceptedLinks.set(ch.code, {
				matchId, tournamentId: tId, seed: result.seed, acceptedBy: acceptor,
			});
			setTimeout(() => acceptedLinks.delete(ch.code!), 60_000);
		}

		const acceptorSide = acceptor === result.playerA ? 'A' : 'B';
		const opponent = acceptorSide === 'A' ? result.playerB : result.playerA;
		return { ok: true, data: {
			matchId, seed: result.seed, tournamentId: tId,
			youAre: acceptorSide, opponent, bestOf: ch.bestOf,
		} };
	} catch (err: any) {
		console.error('[challenge-accept] error:', err);
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
	if (!ch) return { ok: true, data: { declined: false } };
	// Only the target can decline a live challenge
	if (ch.to !== null && ch.to !== decliner) {
		return { ok: true, data: { declined: false } };
	}
	pending.delete(challengeId);
	sendTo(ch.from, { type: 'challenge-declined', v: 0, challengeId, by: decliner });
	return { ok: true, data: { declined: true } };
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Cancel all outgoing challenges (live + link) from a player. */
function cancelOutgoing(from: string): void {
	for (const [id, ch] of pending) {
		if (ch.from === from) {
			pending.delete(id);
		}
	}
}

/**
 * Reconciliation pass — expire stale challenges. Called from the 1s tick.
 * Live challenges expire at 60s. Link challenges expire at 5 min.
 */
export function reconcileChallenges(): void {
	const t = now();
	for (const [id, ch] of pending) {
		const expiryMs = ch.to === null ? LINK_EXPIRY_MS : CHALLENGE_EXPIRY_MS;
		if (t - ch.createdAt > expiryMs) {
			pending.delete(id);
			// Only send expiry notifications for live (targeted) challenges
			if (ch.to !== null) {
				sendTo(ch.from, { type: 'challenge-declined', v: 0, challengeId: id, by: '' });
				sendTo(ch.to, { type: 'challenge-declined', v: 0, challengeId: id, by: '' });
				sendTo(ch.from, { type: 'error', v: 0, code: 'challenge_expired', message: 'Challenge expired' });
			}
		}
	}
}
