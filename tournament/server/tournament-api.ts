/**
 * REST API for tournament management. Stateless HTTP handlers
 * that operate on the database.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
	createTournament,
	getMatch,
	getMatchesForTournament,
	getRegistrationCount,
	getRegistrations,
	getTournament,
	listTournaments,
	registerPlayer,
} from './tournament-db';
import { startTournament } from './tournament-logic';
import { getDb, ensureSchema } from './db';
import { now } from './clock';

const ADMIN_KEY = process.env.ADMIN_KEY || 'boxyrun-admin-2024';
// On-chain wallet that escrows every UCT represented in the ledger. The
// internal player_transactions ledger is a *view* on this wallet: the sum
// of all player balances + unpaid prize pools MUST equal this wallet's
// on-chain balance. Any drift is a bug (or fraud) and surfaces via the
// admin balance-sheet endpoint.
const ARENA_WALLET = process.env.ARENA_WALLET || '@boxyrunarena';

function json(res: ServerResponse, status: number, body: unknown): void {
	const data = JSON.stringify(body);
	res.writeHead(status, {
		'Content-Type': 'application/json',
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
		'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
	});
	res.end(data);
}

function isAdmin(req: IncomingMessage): boolean {
	return req.headers['x-admin-key'] === ADMIN_KEY;
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => resolve(Buffer.concat(chunks).toString()));
		req.on('error', reject);
	});
}

/**
 * Route tournament API requests. Returns true if handled.
 */
export async function handleTournamentApi(
	req: IncomingMessage,
	res: ServerResponse,
): Promise<boolean> {
	const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
	const path = url.pathname;

	if (req.method === 'OPTIONS' && (path.startsWith('/api/tournaments') || path.startsWith('/api/online') || path.startsWith('/api/challenges'))) {
		json(res, 200, { message: 'OK' });
		return true;
	}

	// GET /api/online — list connected players
	if (path === '/api/online' && req.method === 'GET') {
		const { getOnlinePlayers } = await import('./tournament-ws');
		json(res, 200, { players: getOnlinePlayers() });
		return true;
	}

	// GET /api/challenges/:id/status — poll challenge state (pending/accepted/expired)
	const challengeStatusMatch = path.match(/^\/api\/challenges\/([^/]+)\/status$/);
	if (challengeStatusMatch && req.method === 'GET') {
		const { getChallengeStatus } = await import('./challenge');
		json(res, 200, getChallengeStatus(challengeStatusMatch[1]));
		return true;
	}

	// GET /api/challenges/pending?nametag=X — incoming challenges for a player
	if (path === '/api/challenges/pending' && req.method === 'GET') {
		const nametag = url.searchParams.get('nametag');
		if (!nametag) { json(res, 400, { error: 'nametag required' }); return true; }
		const { getPendingChallengesFor } = await import('./challenge');
		json(res, 200, { challenges: getPendingChallengesFor(nametag) });
		return true;
	}

	// GET /api/admin/balance-sheet — system-wide token balance (admin only)
	// Conservation invariant: sum(all balances) + sum(unpaid prize pools)
	// should equal sum(deposits) + sum(wager_win) - sum(wager_loss),
	// i.e. net tokens in the system (plus the prize pool escrow).
	if (path === '/api/admin/balance-sheet' && req.method === 'GET') {
		if (!isAdmin(req)) { json(res, 403, { error: 'Unauthorized' }); return true; }
		try {
			await ensureSchema();
			const db = getDb();

			// Per-type totals from player_transactions
			const byType = await db.execute(
				`SELECT type, COALESCE(SUM(amount), 0) as total, COUNT(*) as count
				 FROM player_transactions
				 GROUP BY type`,
			);
			const totals: Record<string, { total: number; count: number }> = {};
			for (const row of byType.rows) {
				totals[row.type as string] = {
					total: Number(row.total),
					count: Number(row.count),
				};
			}

			// Sum of every player's net balance (positive = holdings)
			const balAgg = await db.execute(
				`SELECT COALESCE(SUM(amount), 0) as totalBalance,
				        COUNT(DISTINCT nametag) as playerCount
				 FROM player_transactions`,
			);
			const totalBalance = Number(balAgg.rows[0]?.totalBalance ?? 0);
			const playerCount = Number(balAgg.rows[0]?.playerCount ?? 0);

			// Outstanding prize pools (tournaments that haven't paid yet)
			const poolAgg = await db.execute(
				`SELECT COALESCE(SUM(prize_pool), 0) as unpaidPools, COUNT(*) as activeCount
				 FROM tournaments
				 WHERE prize_paid = 0`,
			);
			const unpaidPrizePools = Number(poolAgg.rows[0]?.unpaidPools ?? 0);
			const unpaidTournaments = Number(poolAgg.rows[0]?.activeCount ?? 0);

			// Paid prize pools (historical — tokens that LEFT the system via payout)
			const paidAgg = await db.execute(
				`SELECT COALESCE(SUM(prize_pool), 0) as paidPools
				 FROM tournaments
				 WHERE prize_paid = 1`,
			);
			const paidPrizePools = Number(paidAgg.rows[0]?.paidPools ?? 0);

			json(res, 200, {
				arenaWallet: ARENA_WALLET,  // on-chain wallet this ledger tracks
				totalBalance,               // sum(all ledger amounts) — tokens credited to players
				playerCount,
				unpaidPrizePools,           // tokens escrowed in ongoing tournaments
				unpaidTournaments,
				paidPrizePools,             // tokens paid out as tournament prizes (historical)
				byType: totals,             // keyed breakdown by transaction type
				// Reconciliation target: the on-chain balance of `arenaWallet`
				// MUST equal this value. Any drift means funds have moved on-chain
				// without a corresponding ledger entry (or vice versa).
				expectedArenaBalance: totalBalance + unpaidPrizePools,
			});
			return true;
		} catch (err: any) {
			json(res, 500, { error: err.message });
			return true;
		}
	}

	// POST /api/tournaments — create a tournament (admin only)
	if (path === '/api/tournaments' && req.method === 'POST') {
		if (!isAdmin(req)) { json(res, 403, { error: 'Unauthorized' }); return true; }
		try {
			const body = JSON.parse(await readBody(req));
			const id = body.id || `t-${Date.now()}`;
			await createTournament({
				id,
				name: body.name || 'Tournament',
				maxPlayers: body.maxPlayers ?? 32,
				roundHours: body.roundHours ?? 24,
				prizePool: body.prizePool ?? 0,
				entryFee: body.entryFee ?? 0,
				bestOf: body.bestOf ?? 1,
				startsAt: body.startsAt || new Date(Date.now() + 3600000).toISOString(),
			});
			json(res, 201, { id, status: 'registration' });
			return true;
		} catch (err: any) {
			json(res, 400, { error: err.message });
			return true;
		}
	}

	// GET /api/tournaments — list tournaments (exclude 1v1 challenges)
	if (path === '/api/tournaments' && req.method === 'GET') {
		const all = await listTournaments();
		const tournaments = all.filter(t => !String(t.id).startsWith('challenge-'));
		json(res, 200, { tournaments });
		return true;
	}

	// ── Challenges (1v1 peer invites) ────────────────────────────
	// POST /api/challenges  — create a new challenge invitation
	// POST /api/challenges/:id/accept
	// POST /api/challenges/:id/decline
	// All idempotent where sensible. Share core logic with the WS path.
	if (path === '/api/challenges' && req.method === 'POST') {
		try {
			const body = JSON.parse(await readBody(req));
			const from = String(body.from || '').trim();
			const opponent = String(body.opponent || '').trim();
			const wager = Number(body.wager) || 0;
			const bestOf = Number(body.bestOf) || 1;
			if (!from || !opponent) {
				json(res, 400, { error: 'from_and_opponent_required' });
				return true;
			}
			const { applyChallenge } = await import('./challenge');
			const r = await applyChallenge(from, opponent, wager, bestOf);
			if (!r.ok) {
				json(res, r.status, { error: r.code, message: r.message });
			} else {
				json(res, 201, { challengeId: r.data.challengeId });
			}
			return true;
		} catch (err: any) {
			json(res, 400, { error: err.message });
			return true;
		}
	}

	const challengeAcceptMatch = path.match(/^\/api\/challenges\/([^/]+)\/accept$/);
	if (challengeAcceptMatch && req.method === 'POST') {
		try {
			const body = JSON.parse(await readBody(req));
			const acceptor = String(body.by || '').trim();
			if (!acceptor) { json(res, 400, { error: 'by_required' }); return true; }
			const { applyChallengeAccept } = await import('./challenge');
			const r = await applyChallengeAccept(acceptor, challengeAcceptMatch[1]);
			if (!r.ok) {
				json(res, r.status, { error: r.code, message: r.message });
			} else {
				json(res, 200, { status: 'accepted', ...r.data });
			}
			return true;
		} catch (err: any) {
			json(res, 400, { error: err.message });
			return true;
		}
	}

	const challengeDeclineMatch = path.match(/^\/api\/challenges\/([^/]+)\/decline$/);
	if (challengeDeclineMatch && req.method === 'POST') {
		try {
			const body = JSON.parse(await readBody(req));
			const decliner = String(body.by || '').trim();
			if (!decliner) { json(res, 400, { error: 'by_required' }); return true; }
			const { applyChallengeDecline } = await import('./challenge');
			const r = applyChallengeDecline(decliner, challengeDeclineMatch[1]);
			if (!r.ok) {
				json(res, r.status, { error: r.code, message: r.message });
			} else {
				json(res, 200, { status: 'ok', declined: r.data.declined });
			}
			return true;
		} catch (err: any) {
			json(res, 400, { error: err.message });
			return true;
		}
	}

	// Match /api/tournaments/:id patterns
	const tournamentMatch = path.match(/^\/api\/tournaments\/([^/]+)$/);
	const registerMatch = path.match(/^\/api\/tournaments\/([^/]+)\/register$/);
	const bracketMatch = path.match(/^\/api\/tournaments\/([^/]+)\/bracket$/);
	const startMatch = path.match(/^\/api\/tournaments\/([^/]+)\/start$/);
	const payPrizeMatch = path.match(/^\/api\/tournaments\/([^/]+)\/pay-prize$/);
	const matchStateMatch = path.match(/^\/api\/tournaments\/([^/]+)\/matches\/(\d+)\/(\d+)\/state$/);
	const matchReadyMatch = path.match(/^\/api\/tournaments\/([^/]+)\/matches\/(\d+)\/(\d+)\/ready$/);
	const matchDoneMatch = path.match(/^\/api\/tournaments\/([^/]+)\/matches\/(\d+)\/(\d+)\/done$/);

	// POST /api/tournaments/:tid/matches/:round/:slot/ready
	// Idempotent REST equivalent of the WS `match-ready` message. Lets clients
	// with a zombie WebSocket still progress the ready handshake. Body: {nametag}.
	if (matchReadyMatch && req.method === 'POST') {
		const tid = matchReadyMatch[1];
		const round = parseInt(matchReadyMatch[2], 10);
		const slot = parseInt(matchReadyMatch[3], 10);
		const matchId = `${tid}/R${round}M${slot}`;
		try {
			const body = JSON.parse(await readBody(req));
			const nametag = String(body.nametag || '').trim();
			if (!nametag) {
				json(res, 400, { error: 'nametag_required' });
				return true;
			}
			const { applyReady } = await import('./tournament-ws');
			const result = await applyReady(nametag, matchId);
			if (!result.ok) {
				json(res, result.status, { error: result.code, message: result.message });
				return true;
			}
			json(res, 200, {
				status: 'ok',
				phase: result.phase,           // 'waiting' | 'started' | 'reconnected'
				matchStart: result.matchStart, // present when phase is 'started' or 'reconnected'
			});
			return true;
		} catch (err: any) {
			json(res, 400, { error: err.message });
			return true;
		}
	}

	// POST /api/tournaments/:tid/matches/:round/:slot/done
	// REST equivalent of WS `match-done`. Lets clients with a dropped WS reliably
	// signal "I finished" so the server can replay. Body: {nametag}. Idempotent.
	if (matchDoneMatch && req.method === 'POST') {
		const tid = matchDoneMatch[1];
		const round = parseInt(matchDoneMatch[2], 10);
		const slot = parseInt(matchDoneMatch[3], 10);
		const matchId = `${tid}/R${round}M${slot}`;
		try {
			const body = JSON.parse(await readBody(req));
			const nametag = String(body.nametag || '').trim();
			if (!nametag) {
				json(res, 400, { error: 'nametag_required' });
				return true;
			}
			const { handleDone } = await import('./tournament-ws');
			await handleDone(nametag, matchId);
			json(res, 200, { status: 'ok' });
			return true;
		} catch (err: any) {
			json(res, 400, { error: err.message });
			return true;
		}
	}

	// GET /api/tournaments/:tid/matches/:round/:slot/state — self-healing match state
	// Returns DB match row PLUS in-memory ready/done/series info so clients can
	// recover from missed WS pushes by polling. Cheap — single DB read + Map lookups.
	if (matchStateMatch && req.method === 'GET') {
		const tid = matchStateMatch[1];
		const round = parseInt(matchStateMatch[2], 10);
		const slot = parseInt(matchStateMatch[3], 10);
		const matchId = `${tid}/R${round}M${slot}`;
		try {
			const match = await getMatch(matchId);
			if (!match) { json(res, 404, { error: 'Match not found' }); return true; }
			const { getMatchLiveState } = await import('./tournament-ws');
			const fallback = match.player_a && match.player_b
				? { A: match.player_a as string, B: match.player_b as string }
				: null;
			const live = await getMatchLiveState(matchId, fallback);
			const tournament = await getTournament(tid);
			json(res, 200, {
				matchId,
				tournamentId: tid,
				round,
				slot,
				phase: match.status,
				playerA: match.player_a,
				playerB: match.player_b,
				seed: match.seed,
				bestOf: (tournament?.best_of as number) || 1,
				deadline: match.round_deadline,
				winner: match.winner,
				scoreA: match.score_a,
				scoreB: match.score_b,
				// Live (in-memory) state — may be null if server restarted and no one
				// has interacted with this match since.
				ready: live.ready,
				done: live.done,
				online: live.online,
				series: live.series,
				machinePhase: live.machinePhase,
				deadScore: live.deadScore,
				lastGameResult: live.lastGameResult,
				now: Date.now(),
			});
			return true;
		} catch (err: any) {
			json(res, 500, { error: err.message });
			return true;
		}
	}

	// POST /api/tournaments/:id/pay-prize — admin pays the winner
	if (payPrizeMatch && req.method === 'POST') {
		if (!isAdmin(req)) { json(res, 403, { error: 'Unauthorized' }); return true; }
		const id = payPrizeMatch[1];
		try {
			const tournament = await getTournament(id);
			if (!tournament) { json(res, 404, { error: 'Tournament not found' }); return true; }
			if (tournament.status !== 'complete') { json(res, 400, { error: 'Tournament not complete' }); return true; }
			if (tournament.prize_paid) { json(res, 400, { error: 'Prize already paid' }); return true; }
			const prizePool = (tournament.prize_pool as number) || 0;
			if (prizePool <= 0) { json(res, 400, { error: 'No prize pool' }); return true; }

			// Find winner from final match
			const { getMatchesForTournament } = await import('./tournament-db');
			const matches = await getMatchesForTournament(id);
			const maxRound = Math.max(...matches.map(m => m.round as number));
			const finalMatch = matches.find(m => m.round === maxRound && m.winner);
			if (!finalMatch || !finalMatch.winner) {
				json(res, 400, { error: 'No winner found' });
				return true;
			}
			const winner = finalMatch.winner as string;

			const db = (await import('./db')).getDb();
			const ts = new Date().toISOString();
			// ATOMIC: credit + mark-paid commit together. Without this, an
			// admin retry after a partial failure could double-credit the
			// winner (insert succeeded, update failed → prize_paid=0 → next
			// retry inserts again).
			await db.batch([
				{
					sql: 'INSERT INTO player_transactions (nametag, amount, type, memo, timestamp) VALUES (?, ?, ?, ?, ?)',
					args: [winner, prizePool, 'tournament_prize', `Won tournament ${tournament.name}`, ts],
				},
				{
					sql: 'UPDATE tournaments SET prize_paid = 1 WHERE id = ?',
					args: [id],
				},
			], 'write');
			console.log(`[admin] paid ${prizePool} UCT to ${winner} for tournament ${id}`);
			json(res, 200, { status: 'paid', winner, amount: prizePool });
			return true;
		} catch (err: any) {
			json(res, 400, { error: err.message });
			return true;
		}
	}

	// GET /api/tournaments/:id — get tournament details
	if (tournamentMatch && req.method === 'GET') {
		const id = tournamentMatch[1];
		const tournament = await getTournament(id);
		if (!tournament) { json(res, 404, { error: 'Tournament not found' }); return true; }
		const count = await getRegistrationCount(id);
		const players = await getRegistrations(id);
		json(res, 200, { ...tournament, playerCount: count, players });
		return true;
	}

	// POST /api/tournaments/:id/register — register for a tournament
	if (registerMatch && req.method === 'POST') {
		const id = registerMatch[1];
		try {
			const body = JSON.parse(await readBody(req));
			const nametag = typeof body.nametag === 'string' ? body.nametag.trim() : '';
			if (!nametag) { json(res, 400, { error: 'nametag required' }); return true; }

			const tournament = await getTournament(id);
			if (!tournament) { json(res, 404, { error: 'Tournament not found' }); return true; }
			if (tournament.status !== 'registration') {
				json(res, 400, { error: 'Registration is closed' });
				return true;
			}

			const count = await getRegistrationCount(id);
			const maxP = tournament.max_players as number;
			if (maxP > 0 && count >= maxP) {
				json(res, 400, { error: 'Tournament is full' });
				return true;
			}

			const entryFee = (tournament.entry_fee as number) || 0;

			// Duplicate registration → idempotent, no fee charged again
			const existing = await getRegistrations(id);
			const alreadyIn = existing.includes(nametag);

			if (entryFee > 0 && !alreadyIn) {
				await ensureSchema();
				const db = getDb();
				// Balance check
				const bal = await db.execute({
					sql: 'SELECT COALESCE(SUM(amount), 0) as balance FROM player_transactions WHERE nametag = ?',
					args: [nametag],
				});
				const balance = (bal.rows[0]?.balance as number) ?? 0;
				if (balance < entryFee) {
					json(res, 402, { error: 'insufficient_balance', balance, entryFee });
					return true;
				}
				// ATOMIC: debit + prize-pool credit commit together. The
				// previous version could leave the player charged but the
				// pool not increased (or vice versa) on partial failure.
				const ts = new Date(now()).toISOString();
				await db.batch([
					{
						sql: 'INSERT INTO player_transactions (nametag, amount, type, memo, timestamp) VALUES (?, ?, ?, ?, ?)',
						args: [nametag, -entryFee, 'entry_fee', `Entered ${tournament.name}`, ts],
					},
					{
						sql: 'UPDATE tournaments SET prize_pool = prize_pool + ? WHERE id = ?',
						args: [entryFee, id],
					},
				], 'write');
			}

			await registerPlayer(id, nametag);
			const newCount = await getRegistrationCount(id);
			json(res, 200, { status: 'registered', playerCount: newCount });
			return true;
		} catch (err: any) {
			json(res, 400, { error: err.message });
			return true;
		}
	}

	// GET /api/tournaments/:id/bracket — get bracket with match statuses
	if (bracketMatch && req.method === 'GET') {
		const id = bracketMatch[1];
		const tournament = await getTournament(id);
		if (!tournament) { json(res, 404, { error: 'Tournament not found' }); return true; }

		const playerCount = await getRegistrationCount(id);
		const players = await getRegistrations(id);
		const matches = await getMatchesForTournament(id);
		json(res, 200, {
			tournament: { ...tournament, playerCount, players },
			matches: matches.map(m => ({
				id: m.id,
				round: m.round,
				slot: m.slot,
				playerA: m.player_a,
				playerB: m.player_b,
				status: m.status,
				winner: m.winner,
				scoreA: m.score_a,
				scoreB: m.score_b,
				roundDeadline: m.round_deadline,
			})),
		});
		return true;
	}

	// DELETE /api/tournaments/:id — admin deletes a tournament
	if (tournamentMatch && req.method === 'DELETE') {
		if (!isAdmin(req)) { json(res, 403, { error: 'Unauthorized' }); return true; }
		const id = tournamentMatch[1];
		try {
			const db = (await import('./db')).getDb();
			await db.execute({ sql: 'DELETE FROM registrations WHERE tournament_id = ?', args: [id] });
			await db.execute({ sql: 'DELETE FROM match_inputs WHERE match_id LIKE ?', args: [id + '/%'] });
			await db.execute({ sql: 'DELETE FROM matches WHERE tournament_id = ?', args: [id] });
			await db.execute({ sql: 'DELETE FROM tournaments WHERE id = ?', args: [id] });
			json(res, 200, { deleted: id });
			return true;
		} catch (err: any) {
			json(res, 400, { error: err.message });
			return true;
		}
	}

	// POST /api/tournaments/:id/register-and-autostart
	// For 1v1 challenges: register and auto-start if 2 players reached
	const autoMatch = path.match(/^\/api\/tournaments\/([^/]+)\/join$/);
	if (autoMatch && req.method === 'POST') {
		const id = autoMatch[1];
		try {
			const body = JSON.parse(await readBody(req));
			const nametag = body.nametag;
			if (!nametag) { json(res, 400, { error: 'nametag required' }); return true; }

			const tournament = await getTournament(id);
			if (!tournament) { json(res, 404, { error: 'Tournament not found' }); return true; }
			if (tournament.status !== 'registration') {
				json(res, 400, { error: 'Registration is closed' });
				return true;
			}

			await registerPlayer(id, nametag);
			const count = await getRegistrationCount(id);

			// Auto-start if we hit max_players (for 1v1 challenges, max=2)
			if (count >= (tournament.max_players as number)) {
				const { startTournament: start } = await import('./tournament-logic');
				await start(id);
				json(res, 200, { status: 'started', playerCount: count });
			} else {
				json(res, 200, { status: 'registered', playerCount: count });
			}
			return true;
		} catch (err: any) {
			json(res, 400, { error: err.message });
			return true;
		}
	}

	// POST /api/tournaments/:id/start — admin starts the tournament
	if (startMatch && req.method === 'POST') {
		if (!isAdmin(req)) { json(res, 403, { error: 'Unauthorized' }); return true; }
		const id = startMatch[1];
		try {
			await startTournament(id);
			json(res, 200, { status: 'started' });
			return true;
		} catch (err: any) {
			json(res, 400, { error: err.message });
			return true;
		}
	}

	return false;
}
