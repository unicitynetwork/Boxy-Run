/**
 * Daily Cup — points-only seasonal scoring.
 *
 * Top 5 of each day's Daily Challenge get points: 10 / 6 / 4 / 2 / 1.
 * A "season" is a rolling 7-day window — the home page displays the
 * sum across the last 7 dates. The settlement job runs once per UTC
 * day (idempotent on date), reading yesterday's daily_challenge_scores
 * rows and writing season_points.
 */

import { ensureSchema, getDb } from './db';

/**
 * Points awarded for ranks 1..5. Anything beyond gets nothing.
 * Curve over flat: rewards #1 noticeably, but mid-pack ranks still
 * matter so cracking top-5 has value.
 */
const POINTS_BY_RANK = [10, 6, 4, 2, 1];

/** Number of days summed for the season standings. */
export const SEASON_WINDOW_DAYS = 7;

/** UTC date string in YYYY-MM-DD form. */
function utcDateString(d: Date): string {
	return d.toISOString().split('T')[0];
}

/** Today, in UTC. Daily reset is UTC 00:00. */
function todayUtc(): string {
	return utcDateString(new Date());
}

/** Yesterday, in UTC. */
function yesterdayUtc(): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - 1);
	return utcDateString(d);
}

/**
 * Settle a specific day's daily challenge into season_points. Reads
 * the top 5 from `daily_challenge_scores` and inserts one row per
 * winner. Idempotent: re-running for the same date does nothing
 * thanks to the UNIQUE(nametag, date) constraint.
 *
 * Returns the number of rows inserted (0 if already settled, 0 if no
 * one played that day).
 */
export async function settleDay(date: string): Promise<number> {
	await ensureSchema();
	const db = getDb();

	const top = await db.execute({
		sql: `SELECT nickname, score
		      FROM daily_challenge_scores
		      WHERE date = ?
		      ORDER BY score DESC
		      LIMIT 5`,
		args: [date],
	});
	if (top.rows.length === 0) {
		return 0;
	}

	let inserted = 0;
	for (let i = 0; i < top.rows.length; i++) {
		const r = top.rows[i];
		const nametag = String(r.nickname);
		const score = Number(r.score);
		const rank = i + 1;
		const points = POINTS_BY_RANK[i] ?? 0;
		try {
			await db.execute({
				sql: `INSERT INTO season_points (nametag, date, rank, points, score)
				      VALUES (?, ?, ?, ?, ?)`,
				args: [nametag, date, rank, points, score],
			});
			inserted++;
		} catch (err: any) {
			// UNIQUE conflict = already settled, fine to skip.
			if (!String(err?.message || '').includes('UNIQUE')) {
				console.error('[season] settle insert failed', { date, nametag }, err);
			}
		}
	}
	if (inserted > 0) {
		console.log(`[season] settled ${date}: ${inserted} winners`);
	}
	return inserted;
}

/**
 * Run the daily settlement if it hasn't run yet today. Cheap to call
 * frequently — the early-out makes this a no-op once yesterday is
 * already in season_points. Designed to be invoked from the server's
 * 1Hz reconcile tick.
 */
let lastSettledDate: string | null = null;
export async function maybeRunDailySettlement(): Promise<void> {
	const yesterday = yesterdayUtc();
	if (lastSettledDate === yesterday) return;
	try {
		await settleDay(yesterday);
		lastSettledDate = yesterday;
	} catch (err) {
		console.error('[season] daily settlement failed', err);
	}
}

/**
 * Top N players by points summed across the last SEASON_WINDOW_DAYS.
 * Used by the home page to render the season leaderboard.
 */
export async function getSeasonStandings(limit = 30): Promise<Array<{
	rank: number;
	nametag: string;
	points: number;
	wins: number;     // number of days they ranked 1st in the window
	bestRank: number; // best rank achieved in the window
	daysScored: number;
}>> {
	await ensureSchema();
	const db = getDb();
	const cutoff = (() => {
		const d = new Date();
		d.setUTCDate(d.getUTCDate() - SEASON_WINDOW_DAYS);
		return utcDateString(d);
	})();

	const rows = await db.execute({
		sql: `SELECT nametag,
		             SUM(points)              AS total,
		             SUM(CASE WHEN rank = 1 THEN 1 ELSE 0 END) AS wins,
		             MIN(rank)                AS best_rank,
		             COUNT(*)                 AS days
		      FROM season_points
		      WHERE date > ?
		      GROUP BY nametag
		      ORDER BY total DESC, wins DESC, best_rank ASC
		      LIMIT ?`,
		args: [cutoff, limit],
	});

	return rows.rows.map((r, i) => ({
		rank: i + 1,
		nametag: String(r.nametag),
		points: Number(r.total),
		wins: Number(r.wins),
		bestRank: Number(r.best_rank),
		daysScored: Number(r.days),
	}));
}

/**
 * Pull the most recently settled day's top 5. Renders as the
 * "yesterday's results" card on the home page so players see who
 * earned points before they go play today.
 */
export async function getYesterdayResults(): Promise<{
	date: string;
	results: Array<{ rank: number; nametag: string; points: number; score: number }>;
}> {
	await ensureSchema();
	const db = getDb();
	const yesterday = yesterdayUtc();
	const rows = await db.execute({
		sql: `SELECT nametag, rank, points, score
		      FROM season_points
		      WHERE date = ?
		      ORDER BY rank ASC`,
		args: [yesterday],
	});
	return {
		date: yesterday,
		results: rows.rows.map(r => ({
			rank: Number(r.rank),
			nametag: String(r.nametag),
			points: Number(r.points),
			score: Number(r.score),
		})),
	};
}

/**
 * Today's top score on the daily challenge — drives the "live status"
 * card. Returns null if nobody has played today yet.
 */
export async function getTodayLeader(): Promise<{
	date: string;
	leader: { nametag: string; score: number } | null;
	plays: number;
}> {
	await ensureSchema();
	const db = getDb();
	const today = todayUtc();
	const rows = await db.execute({
		sql: `SELECT nickname, score
		      FROM daily_challenge_scores
		      WHERE date = ?
		      ORDER BY score DESC
		      LIMIT 1`,
		args: [today],
	});
	const count = await db.execute({
		sql: `SELECT COUNT(*) AS n FROM daily_challenge_scores WHERE date = ?`,
		args: [today],
	});
	const leader = rows.rows[0]
		? { nametag: String(rows.rows[0].nickname), score: Number(rows.rows[0].score) }
		: null;
	return {
		date: today,
		leader,
		plays: Number(count.rows[0]?.n ?? 0),
	};
}

/**
 * A player's score + rank in TODAY's daily challenge, if they've
 * played. Powers the inline "you: N (rank #X)" line in the cup card.
 */
export async function getPlayerTodayResult(nametag: string): Promise<{
	score: number;
	rank: number;
	totalPlayers: number;
} | null> {
	await ensureSchema();
	const db = getDb();
	const today = todayUtc();
	const own = await db.execute({
		sql: `SELECT score FROM daily_challenge_scores
		      WHERE nickname = ? AND date = ?`,
		args: [nametag, today],
	});
	if (own.rows.length === 0) return null;
	const score = Number(own.rows[0].score);

	const above = await db.execute({
		sql: `SELECT COUNT(*) AS n FROM daily_challenge_scores
		      WHERE date = ? AND score > ?`,
		args: [today, score],
	});
	const total = await db.execute({
		sql: `SELECT COUNT(*) AS n FROM daily_challenge_scores WHERE date = ?`,
		args: [today],
	});
	return {
		score,
		rank: Number(above.rows[0]?.n ?? 0) + 1,
		totalPlayers: Number(total.rows[0]?.n ?? 0),
	};
}

/**
 * Unified "personal status" — combines today's run + season standing.
 * The home page uses this to render the "your position" widgets in
 * one round-trip.
 */
export async function getPlayerStatus(nametag: string): Promise<{
	nametag: string;
	today: { score: number; rank: number; totalPlayers: number } | null;
	season: { points: number; wins: number; daysScored: number; rank: number | null } | null;
}> {
	const [today, season] = await Promise.all([
		getPlayerTodayResult(nametag),
		getPlayerSeasonStanding(nametag),
	]);
	return { nametag, today, season };
}

/**
 * A specific player's standing in the current season — used for the
 * "your standing" pinned row on the home page when the user is
 * outside the visible top 10.
 */
export async function getPlayerSeasonStanding(nametag: string): Promise<{
	points: number;
	wins: number;
	daysScored: number;
	rank: number | null; // null if outside top 100 (not worth ranking exactly)
} | null> {
	await ensureSchema();
	const db = getDb();
	const cutoff = (() => {
		const d = new Date();
		d.setUTCDate(d.getUTCDate() - SEASON_WINDOW_DAYS);
		return utcDateString(d);
	})();

	const own = await db.execute({
		sql: `SELECT SUM(points) AS total,
		             SUM(CASE WHEN rank = 1 THEN 1 ELSE 0 END) AS wins,
		             COUNT(*) AS days
		      FROM season_points
		      WHERE nametag = ? AND date > ?`,
		args: [nametag, cutoff],
	});
	const row = own.rows[0];
	const points = Number(row?.total ?? 0);
	if (points === 0) return null;

	// Rank = number of players with strictly more points + 1
	const above = await db.execute({
		sql: `SELECT COUNT(*) AS above FROM (
		        SELECT nametag, SUM(points) AS total
		        FROM season_points
		        WHERE date > ?
		        GROUP BY nametag
		        HAVING total > ?
		      )`,
		args: [cutoff, points],
	});
	const rank = Number(above.rows[0]?.above ?? 0) + 1;
	return {
		points,
		wins: Number(row?.wins ?? 0),
		daysScored: Number(row?.days ?? 0),
		rank: rank > 100 ? null : rank,
	};
}
