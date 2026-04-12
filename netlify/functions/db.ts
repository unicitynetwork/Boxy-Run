/**
 * Shared Turso/libSQL database connection for Netlify Functions.
 *
 * Environment variables (set in Netlify dashboard):
 *   TURSO_URL      — e.g. libsql://your-db-name-your-org.turso.io
 *   TURSO_AUTH_TOKEN — auth token from `turso db tokens create`
 *
 * For local dev without Turso, set TURSO_URL=file:local.db to use a
 * local SQLite file (no auth token needed).
 */

import { createClient, type Client } from '@libsql/client';

let client: Client | null = null;

export function getDb(): Client {
	if (!client) {
		const url = process.env.TURSO_URL || 'file:local.db';
		const authToken = process.env.TURSO_AUTH_TOKEN;
		client = createClient(authToken ? { url, authToken } : { url });
	}
	return client;
}

/**
 * Initialize the scores table if it doesn't exist. Called once per
 * cold start. Idempotent.
 */
export async function ensureSchema(): Promise<void> {
	const db = getDb();
	await db.execute(`
		CREATE TABLE IF NOT EXISTS scores (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			nickname TEXT NOT NULL,
			score INTEGER NOT NULL,
			coins INTEGER NOT NULL DEFAULT 0,
			date TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			gameplay_hash TEXT DEFAULT '',
			game_duration INTEGER DEFAULT 0
		)
	`);
	await db.execute(`
		CREATE INDEX IF NOT EXISTS idx_scores_date_score
		ON scores (date, score DESC)
	`);
	await db.execute(`
		CREATE INDEX IF NOT EXISTS idx_scores_nickname_date
		ON scores (nickname, date)
	`);
	// All-time top scores table (separate for fast queries)
	await db.execute(`
		CREATE TABLE IF NOT EXISTS alltime (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			nickname TEXT NOT NULL UNIQUE,
			score INTEGER NOT NULL,
			coins INTEGER NOT NULL DEFAULT 0,
			date TEXT NOT NULL,
			timestamp TEXT NOT NULL
		)
	`);
	await db.execute(`
		CREATE INDEX IF NOT EXISTS idx_alltime_score
		ON alltime (score DESC)
	`);
}
