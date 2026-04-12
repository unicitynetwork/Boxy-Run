/**
 * GET /api/leaderboard/alltime — All-time top scores.
 *
 * Query params: ?limit=10
 */

import type { Context } from '@netlify/functions';
import { ensureSchema, getDb } from './db';

export default async (request: Request, _context: Context) => {
	if (request.method === 'OPTIONS') return corsResponse(200, { message: 'OK' });

	await ensureSchema();
	const db = getDb();

	try {
		const url = new URL(request.url);
		const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10', 10), 50);

		const rows = await db.execute({
			sql: 'SELECT nickname, score, coins, date, timestamp FROM alltime ORDER BY score DESC LIMIT ?',
			args: [limit],
		});

		const leaderboard = rows.rows.map((row, idx) => ({
			rank: idx + 1,
			nickname: row.nickname,
			score: row.score,
			coins: row.coins,
			date: row.date,
			timestamp: row.timestamp,
		}));

		return corsResponse(200, { leaderboard });
	} catch (err) {
		console.error('Error getting all-time leaderboard:', err);
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

export const config = { path: '/api/leaderboard/alltime' };
