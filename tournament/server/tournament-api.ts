/**
 * REST API for tournament management. Stateless HTTP handlers
 * that operate on the database.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
	createTournament,
	getMatchesForTournament,
	getRegistrationCount,
	getRegistrations,
	getTournament,
	listTournaments,
	registerPlayer,
} from './tournament-db';
import { startTournament } from './tournament-logic';

function json(res: ServerResponse, status: number, body: unknown): void {
	const data = JSON.stringify(body);
	res.writeHead(status, {
		'Content-Type': 'application/json',
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Headers': 'Content-Type',
		'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
	});
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

/**
 * Route tournament API requests. Returns true if handled.
 */
export async function handleTournamentApi(
	req: IncomingMessage,
	res: ServerResponse,
): Promise<boolean> {
	const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
	const path = url.pathname;

	if (req.method === 'OPTIONS' && path.startsWith('/api/tournaments')) {
		json(res, 200, { message: 'OK' });
		return true;
	}

	// POST /api/tournaments — create a tournament
	if (path === '/api/tournaments' && req.method === 'POST') {
		try {
			const body = JSON.parse(await readBody(req));
			const id = body.id || `t-${Date.now()}`;
			await createTournament({
				id,
				name: body.name || 'Tournament',
				maxPlayers: body.maxPlayers || 32,
				roundHours: body.roundHours || 24,
				startsAt: body.startsAt || new Date(Date.now() + 3600000).toISOString(),
			});
			json(res, 201, { id, status: 'registration' });
			return true;
		} catch (err: any) {
			json(res, 400, { error: err.message });
			return true;
		}
	}

	// GET /api/tournaments — list tournaments
	if (path === '/api/tournaments' && req.method === 'GET') {
		const tournaments = await listTournaments();
		json(res, 200, { tournaments });
		return true;
	}

	// Match /api/tournaments/:id patterns
	const tournamentMatch = path.match(/^\/api\/tournaments\/([^/]+)$/);
	const registerMatch = path.match(/^\/api\/tournaments\/([^/]+)\/register$/);
	const bracketMatch = path.match(/^\/api\/tournaments\/([^/]+)\/bracket$/);
	const startMatch = path.match(/^\/api\/tournaments\/([^/]+)\/start$/);

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
			const nametag = body.nametag;
			if (!nametag) { json(res, 400, { error: 'nametag required' }); return true; }

			const tournament = await getTournament(id);
			if (!tournament) { json(res, 404, { error: 'Tournament not found' }); return true; }
			if (tournament.status !== 'registration') {
				json(res, 400, { error: 'Registration is closed' });
				return true;
			}

			const count = await getRegistrationCount(id);
			if (count >= (tournament.max_players as number)) {
				json(res, 400, { error: 'Tournament is full' });
				return true;
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

		const matches = await getMatchesForTournament(id);
		json(res, 200, {
			tournament,
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

	// DELETE /api/tournaments/:id — operator deletes a tournament
	if (tournamentMatch && req.method === 'DELETE') {
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

	// POST /api/tournaments/:id/start — operator starts the tournament
	if (startMatch && req.method === 'POST') {
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
