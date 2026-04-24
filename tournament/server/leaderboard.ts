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
	const { nickname, score, coins } = body as { nickname: string; score: number; coins: number };

	if (!nickname || typeof score !== 'number') {
		json(res, 400, { error: 'invalid_request', message: 'nickname and score required' });
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
		args: [nickname, score, coins ?? 0, today, timestamp, body.gameplay_hash ?? '', body.game_duration ?? 0],
	});

	// Update all-time
	const at = await db.execute({ sql: 'SELECT score FROM alltime WHERE nickname = ?', args: [nickname] });
	if (at.rows.length === 0) {
		await db.execute({
			sql: 'INSERT INTO alltime (nickname, score, coins, date, timestamp) VALUES (?, ?, ?, ?, ?)',
			args: [nickname, score, coins ?? 0, today, timestamp],
		});
	} else if ((at.rows[0].score as number) < score) {
		await db.execute({
			sql: 'UPDATE alltime SET score = ?, coins = ?, date = ?, timestamp = ? WHERE nickname = ?',
			args: [score, coins ?? 0, today, timestamp, nickname],
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
		data: { previous_best: existing.rows.length > 0 ? existing.rows[0].score : 0, new_best: score, rank },
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

const recordDeposit: Handler = async (req, res) => {
	await ensureSchema();
	const db = getDb();
	const body = JSON.parse(await readBody(req));
	const { nametag, amount } = body as { nametag: string; amount: number };

	if (!nametag || typeof amount !== 'number' || amount === 0) {
		json(res, 400, { error: 'nametag and amount required' });
		return;
	}

	// For deductions, check sufficient balance
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
	const type = amount > 0 ? 'deposit' : 'entry_fee';
	const memo = amount > 0 ? 'UCT deposit' : 'Game entry fee';
	await db.execute({
		sql: 'INSERT INTO player_transactions (nametag, amount, type, memo, timestamp) VALUES (?, ?, ?, ?, ?)',
		args: [nametag, amount, type, memo, timestamp],
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
		if (path === '/api/deposit' && req.method === 'POST') {
			await recordDeposit(req, res, url);
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
