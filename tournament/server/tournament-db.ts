/**
 * Tournament persistence layer — SQLite via @libsql/client.
 * All tournament state lives in the database, not in memory.
 * Server restarts don't lose anything.
 */

import { getDb, ensureSchema as ensureLeaderboardSchema } from './db';

export async function ensureTournamentSchema(): Promise<void> {
	await ensureLeaderboardSchema();
	const db = getDb();

	await db.execute(`
		CREATE TABLE IF NOT EXISTS tournaments (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'registration',
			max_players INTEGER NOT NULL DEFAULT 32,
			round_hours INTEGER NOT NULL DEFAULT 24,
			current_round INTEGER NOT NULL DEFAULT -1,
			prize_pool INTEGER NOT NULL DEFAULT 0,
			entry_fee INTEGER NOT NULL DEFAULT 0,
			best_of INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL,
			starts_at TEXT NOT NULL,
			completed_at TEXT
		)
	`);

	// Migrations for existing DBs (must run after CREATE TABLE so the
	// table exists; SQLite ALTER TABLE on a missing table fails silently
	// in our try/catch and the column is then never added).
	try { await db.execute('ALTER TABLE tournaments ADD COLUMN prize_pool INTEGER NOT NULL DEFAULT 0'); } catch {}
	try { await db.execute('ALTER TABLE tournaments ADD COLUMN best_of INTEGER NOT NULL DEFAULT 1'); } catch {}
	try { await db.execute('ALTER TABLE tournaments ADD COLUMN prize_paid INTEGER NOT NULL DEFAULT 0'); } catch {}
	try { await db.execute('ALTER TABLE tournaments ADD COLUMN entry_fee INTEGER NOT NULL DEFAULT 0'); } catch {}

	await db.execute(`
		CREATE TABLE IF NOT EXISTS registrations (
			tournament_id TEXT NOT NULL,
			nametag TEXT NOT NULL,
			registered_at TEXT NOT NULL,
			PRIMARY KEY (tournament_id, nametag)
		)
	`);

	await db.execute(`
		CREATE TABLE IF NOT EXISTS matches (
			id TEXT PRIMARY KEY,
			tournament_id TEXT NOT NULL,
			round INTEGER NOT NULL,
			slot INTEGER NOT NULL,
			player_a TEXT,
			player_b TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			winner TEXT,
			score_a INTEGER,
			score_b INTEGER,
			seed TEXT,
			started_at TEXT,
			completed_at TEXT,
			round_deadline TEXT
		)
	`);

	await db.execute(`
		CREATE INDEX IF NOT EXISTS idx_matches_tournament
		ON matches (tournament_id, round, slot)
	`);

	// Series progress: persisted on every game-resolve so a server restart
	// mid-Bo3 can rebuild the machine state with the right wins/currentGame.
	// Defaults reflect "fresh match, game 1, 0-0".
	try { await db.execute('ALTER TABLE matches ADD COLUMN series_wins_a INTEGER NOT NULL DEFAULT 0'); } catch {}
	try { await db.execute('ALTER TABLE matches ADD COLUMN series_wins_b INTEGER NOT NULL DEFAULT 0'); } catch {}
	try { await db.execute('ALTER TABLE matches ADD COLUMN current_game INTEGER NOT NULL DEFAULT 1'); } catch {}
	try { await db.execute('ALTER TABLE matches ADD COLUMN current_seed TEXT'); } catch {}

	await db.execute(`
		CREATE TABLE IF NOT EXISTS match_inputs (
			match_id TEXT NOT NULL,
			side TEXT NOT NULL,
			tick INTEGER NOT NULL,
			payload TEXT NOT NULL
		)
	`);

	await db.execute(`
		CREATE INDEX IF NOT EXISTS idx_match_inputs_match
		ON match_inputs (match_id, side)
	`);

	console.log('[db] tournament schema ready');
}

// ── Tournament CRUD ──────────────────────────────────────────────

export async function createTournament(opts: {
	id: string;
	name: string;
	maxPlayers?: number;
	roundHours?: number;
	prizePool?: number;
	entryFee?: number;
	bestOf?: number;
	startsAt: string; // ISO date string
}): Promise<void> {
	const db = getDb();
	await db.execute({
		sql: `INSERT INTO tournaments (id, name, max_players, round_hours, prize_pool, entry_fee, best_of, created_at, starts_at)
		      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		args: [opts.id, opts.name, opts.maxPlayers ?? 32, opts.roundHours ?? 24,
		       opts.prizePool ?? 0, opts.entryFee ?? 0, opts.bestOf ?? 1,
		       new Date().toISOString(), opts.startsAt],
	});
}

export async function getTournament(id: string) {
	const db = getDb();
	const result = await db.execute({ sql: 'SELECT * FROM tournaments WHERE id = ?', args: [id] });
	return result.rows[0] ?? null;
}

export async function listTournaments() {
	const db = getDb();
	const result = await db.execute('SELECT * FROM tournaments ORDER BY created_at DESC LIMIT 20');
	return result.rows;
}

export async function updateTournamentStatus(id: string, status: string, currentRound?: number) {
	const db = getDb();
	if (currentRound !== undefined) {
		await db.execute({
			sql: 'UPDATE tournaments SET status = ?, current_round = ? WHERE id = ?',
			args: [status, currentRound, id],
		});
	} else {
		await db.execute({
			sql: 'UPDATE tournaments SET status = ? WHERE id = ?',
			args: [status, id],
		});
	}
}

export async function completeTournament(id: string) {
	const db = getDb();
	await db.execute({
		sql: 'UPDATE tournaments SET status = ?, completed_at = ? WHERE id = ?',
		args: ['complete', new Date().toISOString(), id],
	});
}

// ── Registrations ────────────────────────────────────────────────

export async function registerPlayer(tournamentId: string, nametag: string) {
	const db = getDb();
	await db.execute({
		sql: 'INSERT OR IGNORE INTO registrations (tournament_id, nametag, registered_at) VALUES (?, ?, ?)',
		args: [tournamentId, nametag, new Date().toISOString()],
	});
}

export async function getRegistrations(tournamentId: string): Promise<string[]> {
	const db = getDb();
	const result = await db.execute({
		sql: 'SELECT nametag FROM registrations WHERE tournament_id = ? ORDER BY registered_at',
		args: [tournamentId],
	});
	return result.rows.map(r => r.nametag as string);
}

export async function getRegistrationCount(tournamentId: string): Promise<number> {
	const db = getDb();
	const result = await db.execute({
		sql: 'SELECT COUNT(*) as count FROM registrations WHERE tournament_id = ?',
		args: [tournamentId],
	});
	return (result.rows[0]?.count as number) ?? 0;
}

// ── Matches ──────────────────────────────────────────────────────

export async function createMatch(opts: {
	id: string;
	tournamentId: string;
	round: number;
	slot: number;
	playerA: string | null;
	playerB: string | null;
	status: string;
	seed: string | null;
	roundDeadline: string | null;
}) {
	const db = getDb();
	await db.execute({
		sql: `INSERT INTO matches (id, tournament_id, round, slot, player_a, player_b, status, seed, round_deadline)
		      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		args: [opts.id, opts.tournamentId, opts.round, opts.slot,
		       opts.playerA, opts.playerB, opts.status, opts.seed, opts.roundDeadline],
	});
}

export async function getMatch(matchId: string) {
	const db = getDb();
	const result = await db.execute({ sql: 'SELECT * FROM matches WHERE id = ?', args: [matchId] });
	return result.rows[0] ?? null;
}

export async function getMatchesForTournament(tournamentId: string) {
	const db = getDb();
	const result = await db.execute({
		sql: 'SELECT * FROM matches WHERE tournament_id = ? ORDER BY round, slot',
		args: [tournamentId],
	});
	return result.rows;
}

export async function getMatchesForRound(tournamentId: string, round: number) {
	const db = getDb();
	const result = await db.execute({
		sql: 'SELECT * FROM matches WHERE tournament_id = ? AND round = ? ORDER BY slot',
		args: [tournamentId, round],
	});
	return result.rows;
}

export async function updateMatchStatus(matchId: string, status: string) {
	const db = getDb();
	await db.execute({
		sql: 'UPDATE matches SET status = ? WHERE id = ?',
		args: [status, matchId],
	});
}

export async function updateMatchStarted(matchId: string, seed: string) {
	const db = getDb();
	await db.execute({
		sql: 'UPDATE matches SET status = ?, seed = ?, started_at = ? WHERE id = ?',
		args: ['active', seed, new Date().toISOString(), matchId],
	});
}

export async function updateMatchResult(matchId: string, winner: string, scoreA: number, scoreB: number) {
	const db = getDb();
	await db.execute({
		sql: 'UPDATE matches SET status = ?, winner = ?, score_a = ?, score_b = ?, completed_at = ? WHERE id = ?',
		args: ['complete', winner, scoreA, scoreB, new Date().toISOString(), matchId],
	});
}

export async function updateMatchForfeit(matchId: string, winner: string | null) {
	const db = getDb();
	await db.execute({
		sql: 'UPDATE matches SET status = ?, winner = ?, completed_at = ? WHERE id = ?',
		args: ['forfeit', winner, new Date().toISOString(), matchId],
	});
}

export async function updateMatchPlayers(matchId: string, playerA: string | null, playerB: string | null) {
	const db = getDb();
	await db.execute({
		sql: 'UPDATE matches SET player_a = ?, player_b = ? WHERE id = ?',
		args: [playerA, playerB, matchId],
	});
}

/**
 * Persist series progress so a server restart mid-series can rebuild
 * the machine state with the correct game number + per-side wins.
 * Called from the machine after each game-resolved (interim or final).
 */
export async function updateMatchSeriesProgress(
	matchId: string,
	winsA: number,
	winsB: number,
	currentGame: number,
	currentSeed: string,
): Promise<void> {
	const db = getDb();
	await db.execute({
		sql: 'UPDATE matches SET series_wins_a = ?, series_wins_b = ?, current_game = ?, current_seed = ? WHERE id = ?',
		args: [winsA, winsB, currentGame, currentSeed, matchId],
	});
}

// ── Match Inputs ─────────────────────────────────────────────────

export async function storeInput(matchId: string, side: string, tick: number, payload: string) {
	const db = getDb();
	await db.execute({
		sql: 'INSERT INTO match_inputs (match_id, side, tick, payload) VALUES (?, ?, ?, ?)',
		args: [matchId, side, tick, payload],
	});
}

export async function getInputs(matchId: string, side: string) {
	const db = getDb();
	const result = await db.execute({
		sql: 'SELECT tick, payload FROM match_inputs WHERE match_id = ? AND side = ? ORDER BY tick',
		args: [matchId, side],
	});
	return result.rows.map(r => ({ tick: r.tick as number, payload: r.payload as string }));
}

// ── Bracket helpers ──────────────────────────────────────────────

export async function getPlayerCurrentMatch(tournamentId: string, nametag: string) {
	const db = getDb();
	const tournament = await getTournament(tournamentId);
	if (!tournament || tournament.current_round === -1) return null;

	const result = await db.execute({
		sql: `SELECT * FROM matches
		      WHERE tournament_id = ? AND round = ?
		      AND (player_a = ? OR player_b = ?)
		      AND status IN ('ready_wait', 'active')`,
		args: [tournamentId, tournament.current_round, nametag, nametag],
	});
	return result.rows[0] ?? null;
}
