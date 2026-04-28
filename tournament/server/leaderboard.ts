/**
 * Leaderboard HTTP handlers. Pure request→response functions that
 * the main server routes to based on URL path.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ensureSchema, getDb } from './db';

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'Content-Type',
	'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

function json(res: ServerResponse, status: number, body: unknown): void {
	const data = JSON.stringify(body);
	res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
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

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => resolve(Buffer.concat(chunks).toString()));
		req.on('error', reject);
	});
}

const submitScore: Handler = async (req, res) => {
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
	// Sanity: cap input list size to prevent abuse (long fake input streams)
	if (inputs.length > 50000) {
		json(res, 400, { error: 'too_many_inputs', message: 'input list too large' });
		return;
	}

	// Server-authoritative replay — derive score+coins from the seed+inputs
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

	// Update all-time
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
 * operators for manual reconciliation. NOT exposed to clients — real
 * deposits land via the Sphere arena watcher (`arena-watcher.ts`), which
 * mirrors actual on-chain transfers into `player_transactions`.
 */
const adminCredit: Handler = async (req, res) => {
	if (req.headers['x-admin-key'] !== (process.env.ADMIN_KEY || 'boxyrun-admin-2024')) {
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
	try {
		const body = JSON.parse(await readBody(req));
		const { nametag, event, data } = body as { nametag?: string; event: string; data?: any };
		console.log(`[client-log] ${nametag || 'anon'}: ${event}`, data ? JSON.stringify(data) : '');
		json(res, 200, { ok: true });
	} catch (err: any) {
		json(res, 400, { error: err.message });
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
		// Admin-only ledger seed/adjust — replaces the old public /api/deposit.
		// Real deposits flow through the Sphere arena watcher; this endpoint
		// is for tests and manual reconciliation.
		if (path === '/api/admin/credit' && req.method === 'POST') {
			await adminCredit(req, res, url);
			return true;
		}
		if (path === '/api/admin/wipe-leaderboard' && req.method === 'POST') {
			if (req.headers['x-admin-key'] !== (process.env.ADMIN_KEY || 'boxyrun-admin-2024')) {
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
		// Targeted delete — kill a single player's entries across all
		// leaderboards. Used to remove cheated scores.
		if (path === '/api/admin/delete-player' && req.method === 'POST') {
			if (req.headers['x-admin-key'] !== (process.env.ADMIN_KEY || 'boxyrun-admin-2024')) {
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
		// Inspect: per-player ledger summary (for spotting forgeries)
		if (path === '/api/admin/ledger-summary' && req.method === 'GET') {
			if (req.headers['x-admin-key'] !== (process.env.ADMIN_KEY || 'boxyrun-admin-2024')) {
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
		// Wipe the player_transactions ledger entirely (forged credits etc.)
		if (path === '/api/admin/wipe-transactions' && req.method === 'POST') {
			if (req.headers['x-admin-key'] !== (process.env.ADMIN_KEY || 'boxyrun-admin-2024')) {
				json(res, 403, { error: 'Unauthorized' });
				return true;
			}
			await ensureSchema();
			const db = getDb();
			await db.execute('DELETE FROM player_transactions');
			json(res, 200, { status: 'ok', message: 'player_transactions wiped' });
			return true;
		}
		// Targeted: delete a single player's transactions
		if (path === '/api/admin/delete-transactions' && req.method === 'POST') {
			if (req.headers['x-admin-key'] !== (process.env.ADMIN_KEY || 'boxyrun-admin-2024')) {
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
		// Daily challenge — server-authoritative replay verification
		if (path === '/api/daily-challenge/scores' && req.method === 'POST') {
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
			// Recompute the seed for today server-side — clients can't lie
			// about which seed they played (they'd just get score=0 for a
			// mismatched seed).
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
