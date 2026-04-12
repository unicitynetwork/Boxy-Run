/**
 * GET /api/leaderboard/history — Historical daily leaderboard.
 *
 * Query params: ?date=2026-04-12&limit=10&offset=0
 */

import type { Context } from '@netlify/functions';
import { ensureSchema, getDb } from './db';

export default async (request: Request, _context: Context) => {
	if (request.method === 'OPTIONS') return corsResponse(200, { message: 'OK' });

	await ensureSchema();
	const db = getDb();

	try {
		const url = new URL(request.url);
		const date = url.searchParams.get('date');
		const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10', 10), 100);
		const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

		if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
			return corsResponse(400, { error: 'Date parameter required (YYYY-MM-DD)' });
		}

		const rows = await db.execute({
			sql: 'SELECT nickname, score, coins, timestamp FROM scores WHERE date = ? ORDER BY score DESC LIMIT ? OFFSET ?',
			args: [date, limit, offset],
		});

		const countResult = await db.execute({
			sql: 'SELECT COUNT(*) as total FROM scores WHERE date = ?',
			args: [date],
		});

		const leaderboard = rows.rows.map((row, idx) => ({
			rank: offset + idx + 1,
			nickname: row.nickname,
			score: row.score,
			coins: row.coins,
			timestamp: row.timestamp,
		}));

		return corsResponse(200, {
			date,
			total_players: countResult.rows[0].total,
			leaderboard,
		});
	} catch (err) {
		console.error('Error getting historical leaderboard:', err);
		return corsResponse(500, { error: 'Internal server error' });
	}
};

function corsResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Headers': 'Content-Type',
			'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
		},
	});
}

export const config = { path: '/api/leaderboard/history' };
