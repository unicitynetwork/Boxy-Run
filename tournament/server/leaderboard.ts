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
	} catch (err) {
		console.error('[api] error:', err);
		json(res, 500, { error: 'Internal server error' });
		return true;
	}

	return false;
}
