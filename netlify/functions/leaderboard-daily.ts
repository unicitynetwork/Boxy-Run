/**
 * GET /api/leaderboard/daily — Today's leaderboard.
 *
 * Query params: ?limit=10&offset=0
 */

import type { Context } from '@netlify/functions';
import { ensureSchema, getDb } from './db';

export default async (request: Request, _context: Context) => {
	if (request.method === 'OPTIONS') return corsResponse(200, { message: 'OK' });

	await ensureSchema();
	const db = getDb();

	try {
		const url = new URL(request.url);
		const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10', 10), 100);
		const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
		const today = new Date().toISOString().split('T')[0];

		const rows = await db.execute({
			sql: 'SELECT nickname, score, coins, timestamp FROM scores WHERE date = ? ORDER BY score DESC LIMIT ? OFFSET ?',
			args: [today, limit, offset],
		});

		const countResult = await db.execute({
			sql: 'SELECT COUNT(*) as total FROM scores WHERE date = ?',
			args: [today],
		});

		const leaderboard = rows.rows.map((row, idx) => ({
			rank: offset + idx + 1,
			nickname: row.nickname,
			score: row.score,
			coins: row.coins,
			timestamp: row.timestamp,
		}));

		const tomorrow = new Date();
		tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
		tomorrow.setUTCHours(0, 0, 0, 0);

		return corsResponse(200, {
			date: today,
			reset_time: tomorrow.toISOString(),
			total_players: countResult.rows[0].total,
			leaderboard,
		});
	} catch (err) {
		console.error('Error getting leaderboard:', err);
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

export const config = { path: '/api/leaderboard/daily' };
