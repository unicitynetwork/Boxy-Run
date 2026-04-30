/**
 * Leaderboard HTTP handlers. Pure request→response functions that
 * the main server routes to based on URL path.
 *
 * Identity model — IMPORTANT context:
 * The server does NOT verify nametag ownership for low-stakes endpoints
 * like /api/scores or /api/log. Body-trust is fine here because:
 *   - Score submission is replay-verified server-side: the score is
 *     derived from (seed, inputs), not what the client sends. An
 *     impersonator can only put their own real score under someone
 *     else's nickname, which is a non-attack (it raises the victim's
 *     daily best, doesn't lower it).
 *   - /api/log is purely diagnostic; pollution costs nothing.
 *
 * Real value-moving operations (entry fees, wager settlement) flow
 * through `arena-watcher.ts`, which credits the ledger only when an
 * actual on-chain Sphere transfer arrives. The transfer's senderNametag
 * is cryptographically bound by the wallet — no client-asserted nametag
 * touches the money path.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ensureSchema, getDb } from './db';
import { isAdminRequest } from './admin-key';

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

// CORS: wide-open. Read endpoints are obviously safe; write endpoints
// either rely on body validation (replay-verify on /scores) or require
// X-Admin-Key. Without complex auth there's no per-origin trust to
// enforce, so wildcard keeps embedding/iframe leaderboards easy.
const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
	'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
};

function json(res: ServerResponse, status: number, body: unknown): void {
	const data = JSON.stringify(body);
	res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
	res.end(data);
}

/** Deterministic daily seed from a date string like "2026-04-25". */
function dailySeedForDate(date: string): number {
	let hash = 0;
	for (let i = 0; i < date.length; i++) {
		hash = ((hash << 5) - hash + date.charCodeAt(i)) | 0;
	}
	return hash >>> 0;
}

/**
 * Bounded request-body reader. Without this cap, an attacker could send
 * a multi-GB POST and OOM the Fly machine. 1 MiB is generous: the
 * largest legitimate body (a 50K-input replay) is around 800 KB.
 */
const MAX_BODY_BYTES = 1024 * 1024;
function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		req.on('data', (c) => {
			total += (c as Buffer).length;
			if (total > MAX_BODY_BYTES) {
				req.destroy();
				reject(new Error('payload_too_large'));
				return;
			}
			chunks.push(c);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString()));
		req.on('error', reject);
	});
}

/**
 * Per-IP rate limiter for the expensive endpoints (replay verification,
 * admin operations). Sliding window — N hits in `windowMs` from a single
 * IP triggers 429.
 *
 * Memory: a long-lived prod server sees many distinct IPs; without
 * eviction the map grows without bound. The sweep below runs every 5
 * min and drops entries whose newest hit is older than the largest
 * window we use.
 */
const rateLimits = new Map<string, number[]>();
const RATE_LIMIT_SWEEP_MAX_AGE_MS = 5 * 60 * 1000;
function rateLimit(req: IncomingMessage, res: ServerResponse, key: string, max: number, windowMs: number): boolean {
	const ip = String(req.headers['fly-client-ip'] || req.socket.remoteAddress || 'unknown');
	const k = `${key}:${ip}`;
	const now = Date.now();
	const arr = (rateLimits.get(k) || []).filter(t => now - t < windowMs);
	if (arr.length >= max) {
		json(res, 429, { error: 'rate_limited', retry_after_ms: windowMs - (now - arr[0]) });
		return false;
	}
	arr.push(now);
	rateLimits.set(k, arr);
	return true;
}
setInterval(() => {
	const cutoff = Date.now() - RATE_LIMIT_SWEEP_MAX_AGE_MS;
	for (const [k, arr] of rateLimits) {
		const newest = arr.length === 0 ? 0 : arr[arr.length - 1];
		if (newest < cutoff) rateLimits.delete(k);
	}
}, 5 * 60 * 1000).unref();

const submitScore: Handler = async (req, res) => {
	if (!rateLimit(req, res, 'scores', 30, 60_000)) return;

	await ensureSchema();
	const db = getDb();
	const body = JSON.parse(await readBody(req));
	const { nickname, seed, inputs } = body as {
		nickname: string;
		seed: number;
		inputs: Array<{ tick: number; payload: string }>;
	};

	if (!nickname || typeof seed !== 'number' || !Array.isArray(inputs)) {
		json(res, 400, { error: 'invalid_request', message: 'nickname, seed and inputs required' });
		return;
	}
	if (inputs.length > 50000) {
		json(res, 400, { error: 'too_many_inputs', message: 'input list too large' });
		return;
	}

	// Server-authoritative replay — the actual score is derived from the
	// seed+inputs, not what the client claims. This makes nickname spoofing
	// pointless: an impersonator would need to actually play a winning game
	// to put a high score under someone else's name.
	const { replayScoreAndCoins } = await import('./tournament-logic');
	let score: number, coins: number;
	try {
		const result = replayScoreAndCoins(seed >>> 0, inputs);
		score = result.score;
		coins = result.coins;
	} catch (err) {
		console.warn('[scores] replay failed', err);
		json(res, 400, { error: 'replay_failed', message: 'Could not verify gameplay' });
		return;
	}

	const today = new Date().toISOString().split('T')[0];
	const timestamp = new Date().toISOString();

	const existing = await db.execute({
		sql: 'SELECT score FROM scores WHERE nickname = ? AND date = ? ORDER BY score DESC LIMIT 1',
		args: [nickname, today],
	});

	if (existing.rows.length > 0 && (existing.rows[0].score as number) >= score) {
		json(res, 200, {
			status: 'rejected',
			message: 'Score not higher than daily best',
			data: { current_best: existing.rows[0].score, submitted_score: score },
		});
		return;
	}

	await db.execute({ sql: 'DELETE FROM scores WHERE nickname = ? AND date = ?', args: [nickname, today] });
	await db.execute({
		sql: 'INSERT INTO scores (nickname, score, coins, date, timestamp, gameplay_hash, game_duration) VALUES (?, ?, ?, ?, ?, ?, ?)',
		args: [nickname, score, coins, today, timestamp, '', inputs.length],
	});

	const at = await db.execute({ sql: 'SELECT score FROM alltime WHERE nickname = ?', args: [nickname] });
	if (at.rows.length === 0) {
		await db.execute({
			sql: 'INSERT INTO alltime (nickname, score, coins, date, timestamp) VALUES (?, ?, ?, ?, ?)',
			args: [nickname, score, coins, today, timestamp],
		});
	} else if ((at.rows[0].score as number) < score) {
		await db.execute({
			sql: 'UPDATE alltime SET score = ?, coins = ?, date = ?, timestamp = ? WHERE nickname = ?',
			args: [score, coins, today, timestamp, nickname],
		});
	}

	const rankResult = await db.execute({
		sql: 'SELECT COUNT(*) as rank FROM scores WHERE date = ? AND score > ?',
		args: [today, score],
	});
	const rank = ((rankResult.rows[0].rank as number) ?? 0) + 1;

	json(res, 200, {
		status: 'accepted',
		message: 'New daily high score recorded',
		data: { previous_best: existing.rows.length > 0 ? existing.rows[0].score : 0, new_best: score, coins, rank },
	});
};

const dailyLeaderboard: Handler = async (_req, res, url) => {
	await ensureSchema();
	const db = getDb();
	const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10', 10), 100);
	const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
	const today = new Date().toISOString().split('T')[0];

	const rows = await db.execute({
		sql: 'SELECT nickname, score, coins, timestamp FROM scores WHERE date = ? ORDER BY score DESC LIMIT ? OFFSET ?',
		args: [today, limit, offset],
	});
	const count = await db.execute({ sql: 'SELECT COUNT(*) as total FROM scores WHERE date = ?', args: [today] });

	const tomorrow = new Date();
	tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
	tomorrow.setUTCHours(0, 0, 0, 0);

	json(res, 200, {
		date: today,
		reset_time: tomorrow.toISOString(),
		total_players: count.rows[0].total,
		leaderboard: rows.rows.map((r, i) => ({
			rank: offset + i + 1, nickname: r.nickname, score: r.score, coins: r.coins, timestamp: r.timestamp,
		})),
	});
};

const alltimeLeaderboard: Handler = async (_req, res, url) => {
	await ensureSchema();
	const db = getDb();
	const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10', 10), 50);

	const rows = await db.execute({
		sql: 'SELECT nickname, score, coins, date, timestamp FROM alltime ORDER BY score DESC LIMIT ?',
		args: [limit],
	});

	json(res, 200, {
		leaderboard: rows.rows.map((r, i) => ({
			rank: i + 1, nickname: r.nickname, score: r.score, coins: r.coins, date: r.date, timestamp: r.timestamp,
		})),
	});
};

const historyLeaderboard: Handler = async (_req, res, url) => {
	await ensureSchema();
	const db = getDb();
	const date = url.searchParams.get('date');
	const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10', 10), 100);
	const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

	if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		json(res, 400, { error: 'Date parameter required (YYYY-MM-DD)' });
		return;
	}

	const rows = await db.execute({
		sql: 'SELECT nickname, score, coins, timestamp FROM scores WHERE date = ? ORDER BY score DESC LIMIT ? OFFSET ?',
		args: [date, limit, offset],
	});
	const count = await db.execute({ sql: 'SELECT COUNT(*) as total FROM scores WHERE date = ?', args: [date] });

	json(res, 200, {
		date,
		total_players: count.rows[0].total,
		leaderboard: rows.rows.map((r, i) => ({
			rank: offset + i + 1, nickname: r.nickname, score: r.score, coins: r.coins, timestamp: r.timestamp,
		})),
	});
};

/**
 * Admin-only ledger adjuster. Used by tests for fixture seeding and by
 * operators for manual reconciliation. Real deposits flow through the
 * Sphere arena watcher (`arena-watcher.ts`).
 */
const adminCredit: Handler = async (req, res) => {
	if (!isAdminRequest(req)) {
		json(res, 403, { error: 'Unauthorized' });
		return;
	}
	await ensureSchema();
	const db = getDb();
	const body = JSON.parse(await readBody(req));
	const { nametag, amount, type, memo } = body as { nametag: string; amount: number; type?: string; memo?: string };

	if (!nametag || typeof amount !== 'number' || amount === 0) {
		json(res, 400, { error: 'nametag and amount required' });
		return;
	}

	if (amount < 0) {
		const cur = await db.execute({
			sql: 'SELECT COALESCE(SUM(amount), 0) as balance FROM player_transactions WHERE nametag = ?',
			args: [nametag],
		});
		const balance = cur.rows[0].balance as number;
		if (balance + amount < 0) {
			json(res, 400, { error: 'insufficient_balance', balance });
			return;
		}
	}

	const timestamp = new Date().toISOString();
	const txType = type || (amount > 0 ? 'deposit' : 'entry_fee');
	const txMemo = memo || (amount > 0 ? 'admin credit' : 'admin debit');
	await db.execute({
		sql: 'INSERT INTO player_transactions (nametag, amount, type, memo, timestamp) VALUES (?, ?, ?, ?, ?)',
		args: [nametag, amount, txType, txMemo, timestamp],
	});

	const bal = await db.execute({
		sql: 'SELECT COALESCE(SUM(amount), 0) as balance FROM player_transactions WHERE nametag = ?',
		args: [nametag],
	});

	json(res, 200, { status: 'ok', balance: bal.rows[0].balance });
};

const clientLog: Handler = async (req, res) => {
	if (!rateLimit(req, res, 'client-log', 60, 60_000)) return;
	try {
		const body = JSON.parse(await readBody(req));
		const { nametag, event, data } = body as { nametag?: string; event: string; data?: any };
		console.log(`[client-log] ${nametag || 'anon'}: ${event}`, data ? JSON.stringify(data) : '');
		json(res, 200, { ok: true });
	} catch {
		json(res, 400, { error: 'invalid_request' });
	}
};

const getTransactions: Handler = async (_req, res, url) => {
	await ensureSchema();
	const db = getDb();
	const parts = url.pathname.split('/');
	const nametag = parts[parts.length - 1];
	if (!nametag) { json(res, 400, { error: 'nametag required' }); return; }
	const decoded = decodeURIComponent(nametag);
	const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
	const rows = await db.execute({
		sql: 'SELECT id, amount, type, memo, timestamp FROM player_transactions WHERE nametag = ? ORDER BY id DESC LIMIT ?',
		args: [decoded, limit],
	});
	json(res, 200, {
		nametag: decoded,
		transactions: rows.rows.map(r => ({
			id: r.id,
			amount: r.amount,
			type: r.type,
			memo: r.memo,
			timestamp: r.timestamp,
		})),
	});
};

const getBalance: Handler = async (_req, res, url) => {
	await ensureSchema();
	const db = getDb();
	const nametag = url.pathname.split('/').pop();
	if (!nametag) {
		json(res, 400, { error: 'nametag required' });
		return;
	}
	const bal = await db.execute({
		sql: 'SELECT COALESCE(SUM(amount), 0) as balance FROM player_transactions WHERE nametag = ?',
		args: [decodeURIComponent(nametag)],
	});
	json(res, 200, { nametag: decodeURIComponent(nametag), balance: bal.rows[0].balance });
};

/** Route an HTTP request to the right handler. Returns true if handled. */
export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
	const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
	const path = url.pathname;

	if (req.method === 'OPTIONS' && path.startsWith('/api/')) {
		json(res, 200, { message: 'OK' });
		return true;
	}

	try {
		if (path === '/api/scores' && req.method === 'POST') {
			await submitScore(req, res, url);
			return true;
		}
		if (path === '/api/leaderboard/daily' && req.method === 'GET') {
			await dailyLeaderboard(req, res, url);
			return true;
		}
		if (path === '/api/leaderboard/alltime' && req.method === 'GET') {
			await alltimeLeaderboard(req, res, url);
			return true;
		}
		if (path === '/api/leaderboard/history' && req.method === 'GET') {
			await historyLeaderboard(req, res, url);
			return true;
		}
		if (path === '/api/admin/credit' && req.method === 'POST') {
			await adminCredit(req, res, url);
			return true;
		}
		if (path === '/api/admin/wipe-leaderboard' && req.method === 'POST') {
			if (!isAdminRequest(req)) {
				json(res, 403, { error: 'Unauthorized' });
				return true;
			}
			await ensureSchema();
			const db = getDb();
			await db.execute('DELETE FROM scores');
			await db.execute('DELETE FROM alltime');
			json(res, 200, { status: 'ok', message: 'Leaderboard wiped (scores + alltime)' });
			return true;
		}
		if (path === '/api/admin/delete-player' && req.method === 'POST') {
			if (!isAdminRequest(req)) {
				json(res, 403, { error: 'Unauthorized' });
				return true;
			}
			await ensureSchema();
			const db = getDb();
			const body = JSON.parse(await readBody(req));
			const nickname = String(body.nickname || '').trim();
			if (!nickname) {
				json(res, 400, { error: 'invalid_request', message: 'nickname required' });
				return true;
			}
			const a = await db.execute({ sql: 'DELETE FROM scores WHERE nickname = ?', args: [nickname] });
			const b = await db.execute({ sql: 'DELETE FROM alltime WHERE nickname = ?', args: [nickname] });
			const c = await db.execute({ sql: 'DELETE FROM daily_challenge_scores WHERE nickname = ?', args: [nickname] });
			json(res, 200, {
				status: 'ok',
				deleted: { scores: a.rowsAffected, alltime: b.rowsAffected, daily: c.rowsAffected },
			});
			return true;
		}
		if (path === '/api/admin/ledger-summary' && req.method === 'GET') {
			if (!isAdminRequest(req)) {
				json(res, 403, { error: 'Unauthorized' });
				return true;
			}
			await ensureSchema();
			const db = getDb();
			const rows = await db.execute(
				`SELECT nametag,
					COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE 0 END), 0) as deposits,
					SUM(CASE WHEN type='deposit' THEN 1 ELSE 0 END) as depositCount,
					MAX(CASE WHEN type='deposit' THEN amount ELSE 0 END) as biggestDeposit,
					COALESCE(SUM(amount), 0) as balance
				 FROM player_transactions
				 GROUP BY nametag
				 ORDER BY deposits DESC`,
			);
			json(res, 200, {
				players: rows.rows.map(r => ({
					nametag: r.nametag,
					deposits: Number(r.deposits),
					depositCount: Number(r.depositCount),
					biggestDeposit: Number(r.biggestDeposit),
					balance: Number(r.balance),
				})),
			});
			return true;
		}
		if (path === '/api/admin/wipe-transactions' && req.method === 'POST') {
			if (!isAdminRequest(req)) {
				json(res, 403, { error: 'Unauthorized' });
				return true;
			}
			await ensureSchema();
			const db = getDb();
			await db.execute('DELETE FROM player_transactions');
			json(res, 200, { status: 'ok', message: 'player_transactions wiped' });
			return true;
		}
		if (path === '/api/admin/delete-transactions' && req.method === 'POST') {
			if (!isAdminRequest(req)) {
				json(res, 403, { error: 'Unauthorized' });
				return true;
			}
			await ensureSchema();
			const db = getDb();
			const body = JSON.parse(await readBody(req));
			const nametag = String(body.nametag || '').trim();
			if (!nametag) {
				json(res, 400, { error: 'invalid_request', message: 'nametag required' });
				return true;
			}
			const r = await db.execute({ sql: 'DELETE FROM player_transactions WHERE nametag = ?', args: [nametag] });
			json(res, 200, { status: 'ok', deleted: r.rowsAffected });
			return true;
		}
		// Daily challenge — server-authoritative replay verification (same
		// shape as /api/scores; nickname is body-trusted but the score is
		// computed from inputs, so spoofing accomplishes nothing useful).
		if (path === '/api/daily-challenge/scores' && req.method === 'POST') {
			if (!rateLimit(req, res, 'daily-scores', 10, 60_000)) return true;
			await ensureSchema();
			const db = getDb();
			const body = JSON.parse(await readBody(req));
			const nickname = String(body.nickname || '').trim();
			const inputs = Array.isArray(body.inputs) ? body.inputs : null;
			if (!nickname || !inputs) {
				json(res, 400, { error: 'invalid_request', message: 'nickname and inputs required' });
				return true;
			}
			if (inputs.length > 50000) {
				json(res, 400, { error: 'too_many_inputs', message: 'input list too large' });
				return true;
			}
			const today = new Date().toISOString().split('T')[0];
			const date = String(body.date || today);
			if (date !== today) {
				json(res, 400, { error: 'wrong_date', message: 'Can only submit for today' });
				return true;
			}
			const seed = dailySeedForDate(today);
			let score: number, coins: number;
			try {
				const { replayScoreAndCoins } = await import('./tournament-logic');
				const result = replayScoreAndCoins(seed, inputs);
				score = result.score;
				coins = result.coins;
			} catch (err) {
				console.warn('[daily] replay failed', err);
				json(res, 400, { error: 'replay_failed', message: 'Could not verify gameplay' });
				return true;
			}
			try {
				await db.execute({
					sql: 'INSERT INTO daily_challenge_scores (nickname, score, coins, date, timestamp) VALUES (?, ?, ?, ?, ?)',
					args: [nickname, score, coins, today, new Date().toISOString()],
				});
				json(res, 200, { status: 'ok', date: today, score, coins });
			} catch (err: any) {
				if (err.message?.includes('UNIQUE')) {
					json(res, 409, { error: 'already_played', message: 'You already played today\'s challenge' });
				} else {
					throw err;
				}
			}
			return true;
		}
		// ── Daily Cup (7-day rolling season) ───────────────────────
		// Standings: top 30 by 7-day points sum. Used by the home page.
		if (path === '/api/season/standings' && req.method === 'GET') {
			const { getSeasonStandings } = await import('./season');
			const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '30', 10), 100);
			const standings = await getSeasonStandings(limit);
			json(res, 200, { standings, windowDays: 7 });
			return true;
		}
		// Yesterday's settled top-5 + their points awarded.
		if (path === '/api/season/yesterday' && req.method === 'GET') {
			const { getYesterdayResults } = await import('./season');
			json(res, 200, await getYesterdayResults());
			return true;
		}
		// Live: today's leader + total plays so far.
		if (path === '/api/season/today' && req.method === 'GET') {
			const { getTodayLeader } = await import('./season');
			json(res, 200, await getTodayLeader());
			return true;
		}
		// A specific player's standing — null if outside the season.
		if (path.startsWith('/api/season/player/') && req.method === 'GET') {
			const { getPlayerSeasonStanding } = await import('./season');
			const tag = decodeURIComponent(path.slice('/api/season/player/'.length));
			if (!tag) { json(res, 400, { error: 'nametag required' }); return true; }
			json(res, 200, { nametag: tag, standing: await getPlayerSeasonStanding(tag) });
			return true;
		}
		// Admin: force-settle a date. Useful for backfills + tests.
		if (path === '/api/admin/season/settle' && req.method === 'POST') {
			if (!isAdminRequest(req)) { json(res, 403, { error: 'Unauthorized' }); return true; }
			try {
				const body = JSON.parse(await readBody(req));
				const date = String(body.date || '').trim();
				if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
					json(res, 400, { error: 'date must be YYYY-MM-DD' });
					return true;
				}
				const { settleDay } = await import('./season');
				const inserted = await settleDay(date);
				json(res, 200, { date, inserted });
			} catch (err) {
				console.error('[api] season settle:', err);
				json(res, 500, { error: 'internal_error' });
			}
			return true;
		}
		if (path === '/api/daily-challenge/leaderboard' && req.method === 'GET') {
			await ensureSchema();
			const db = getDb();
			const today = new Date().toISOString().split('T')[0];
			const date = url.searchParams.get('date') || today;
			const rows = await db.execute({
				sql: 'SELECT nickname, score, coins, timestamp FROM daily_challenge_scores WHERE date = ? ORDER BY score DESC LIMIT 20',
				args: [date],
			});
			json(res, 200, {
				date,
				seed: dailySeedForDate(date),
				leaderboard: rows.rows.map((r, i) => ({
					rank: i + 1, nickname: r.nickname, score: r.score, coins: r.coins, timestamp: r.timestamp,
				})),
			});
			return true;
		}
		if (path === '/api/log' && req.method === 'POST') {
			await clientLog(req, res, url);
			return true;
		}
		if (path.startsWith('/api/balance/') && req.method === 'GET') {
			await getBalance(req, res, url);
			return true;
		}
		if (path.startsWith('/api/transactions/') && req.method === 'GET') {
			await getTransactions(req, res, url);
			return true;
		}
	} catch (err) {
		console.error('[api] error:', err);
		json(res, 500, { error: 'Internal server error' });
		return true;
	}

	return false;
}
