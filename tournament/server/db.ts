/**
 * SQLite database for leaderboard storage. Uses @libsql/client with
 * a file: URL so there's no external service dependency — just a
 * SQLite file on a Fly.io persistent volume.
 *
 * Env var: DB_PATH (default: ./boxyrun.db)
 */

import { createClient, type Client } from '@libsql/client';

let client: Client | null = null;
let schemaReady = false;

export function getDb(): Client {
	if (!client) {
		const dbPath = process.env.DB_PATH || './boxyrun.db';
		client = createClient({ url: `file:${dbPath}` });
	}
	return client;
}

export async function ensureSchema(): Promise<void> {
	if (schemaReady) return;
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
	await db.execute(`
		CREATE TABLE IF NOT EXISTS player_transactions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			nametag TEXT NOT NULL,
			amount INTEGER NOT NULL,
			type TEXT NOT NULL,
			memo TEXT DEFAULT '',
			timestamp TEXT NOT NULL,
			tx_id TEXT UNIQUE
		)
	`);
	// Migration: add tx_id to existing deployments. UNIQUE here means
	// duplicate on-chain transfer events from the arena watcher silently
	// no-op rather than double-crediting. NULL stays allowed for non-deposit
	// rows (entry_fee, wager_*, tournament_prize) which don't have a chain id.
	try { await db.execute(`ALTER TABLE player_transactions ADD COLUMN tx_id TEXT`); } catch {}
	try { await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_player_tx_txid ON player_transactions (tx_id) WHERE tx_id IS NOT NULL`); } catch {}
	await db.execute(`
		CREATE INDEX IF NOT EXISTS idx_player_tx_nametag
		ON player_transactions (nametag)
	`);
	await db.execute(`
		CREATE TABLE IF NOT EXISTS daily_challenge_scores (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			nickname TEXT NOT NULL,
			score INTEGER NOT NULL,
			coins INTEGER NOT NULL DEFAULT 0,
			date TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			UNIQUE(nickname, date)
		)
	`);
	await db.execute(`
		CREATE INDEX IF NOT EXISTS idx_daily_challenge_date_score
		ON daily_challenge_scores (date, score DESC)
	`);
	schemaReady = true;
	console.log('[db] schema ready');
}
