/**
 * POST /api/scores — Submit a new score.
 *
 * Body: { nickname, score, coins, gameplay_hash?, game_duration? }
 *
 * Only records the score if it's higher than the player's existing
 * daily best (replaces the old entry). Also updates the all-time
 * table if this is a new personal best overall.
 */

import type { Context } from '@netlify/functions';
import { ensureSchema, getDb } from './db';

export default async (request: Request, _context: Context) => {
	if (request.method === 'OPTIONS') return corsResponse(200, { message: 'OK' });
	if (request.method !== 'POST') return corsResponse(405, { error: 'Method not allowed' });

	await ensureSchema();
	const db = getDb();

	try {
		const body = await request.json();
		const { nickname, score, coins } = body as {
			nickname: string;
			score: number;
			coins: number;
		};

		if (!nickname || typeof score !== 'number') {
			return corsResponse(400, { error: 'invalid_request', message: 'nickname and score required' });
		}

		const today = new Date().toISOString().split('T')[0];
		const timestamp = new Date().toISOString();

		// Check existing daily best
		const existing = await db.execute({
			sql: 'SELECT score FROM scores WHERE nickname = ? AND date = ? ORDER BY score DESC LIMIT 1',
			args: [nickname, today],
		});

		if (existing.rows.length > 0 && (existing.rows[0].score as number) >= score) {
			return corsResponse(200, {
				status: 'rejected',
				message: 'Score not higher than daily best',
				data: { current_best: existing.rows[0].score, submitted_score: score },
			});
		}

		// Delete existing daily entry for this player and insert new one
		await db.execute({
			sql: 'DELETE FROM scores WHERE nickname = ? AND date = ?',
			args: [nickname, today],
		});
		await db.execute({
			sql: 'INSERT INTO scores (nickname, score, coins, date, timestamp, gameplay_hash, game_duration) VALUES (?, ?, ?, ?, ?, ?, ?)',
			args: [
				nickname,
				score,
				coins ?? 0,
				today,
				timestamp,
				(body as any).gameplay_hash ?? '',
				(body as any).game_duration ?? 0,
			],
		});

		// Update all-time if this is a new personal best
		const alltimeExisting = await db.execute({
			sql: 'SELECT score FROM alltime WHERE nickname = ?',
			args: [nickname],
		});

		if (alltimeExisting.rows.length === 0) {
			await db.execute({
				sql: 'INSERT INTO alltime (nickname, score, coins, date, timestamp) VALUES (?, ?, ?, ?, ?)',
				args: [nickname, score, coins ?? 0, today, timestamp],
			});
		} else if ((alltimeExisting.rows[0].score as number) < score) {
			await db.execute({
				sql: 'UPDATE alltime SET score = ?, coins = ?, date = ?, timestamp = ? WHERE nickname = ?',
				args: [score, coins ?? 0, today, timestamp, nickname],
			});
		}

		// Get player's rank
		const rankResult = await db.execute({
			sql: 'SELECT COUNT(*) as rank FROM scores WHERE date = ? AND score > ?',
			args: [today, score],
		});
		const rank = ((rankResult.rows[0].rank as number) ?? 0) + 1;

		return corsResponse(200, {
			status: 'accepted',
			message: 'New daily high score recorded',
			data: {
				previous_best: existing.rows.length > 0 ? existing.rows[0].score : 0,
				new_best: score,
				rank,
			},
		});
	} catch (err) {
		console.error('Error submitting score:', err);
		return corsResponse(400, { error: 'invalid_request', message: 'Invalid request format' });
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

export const config = { path: '/api/scores' };
