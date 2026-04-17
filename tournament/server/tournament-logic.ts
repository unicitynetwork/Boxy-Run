/**
 * Tournament logic — stateless functions that operate on the database.
 * No in-memory state, no WebSocket awareness. The server calls these
 * functions and delivers results over whatever transport it uses.
 */

import { generateBracket, hashString } from './bracket';
import { now } from './clock';
import {
	completeTournament,
	createMatch,
	getInputs,
	getMatch,
	getMatchesForRound,
	getMatchesForTournament,
	getRegistrations,
	getTournament,
	updateMatchForfeit,
	updateMatchPlayers,
	updateMatchResult,
	updateMatchStarted,
	updateMatchStatus,
	updateTournamentStatus,
} from './tournament-db';
import { makeInitialState } from '../../src/sim/init';
import { tick as simTick } from '../../src/sim/tick';
import { DEFAULT_CONFIG, type CharacterAction } from '../../src/sim/state';

/**
 * Start a tournament: close registration, generate bracket,
 * create round 0 matches, open the first round.
 */
export async function startTournament(tournamentId: string): Promise<void> {
	const tournament = await getTournament(tournamentId);
	if (!tournament || tournament.status !== 'registration') {
		throw new Error(`Cannot start tournament ${tournamentId}: status is ${tournament?.status}`);
	}

	const players = await getRegistrations(tournamentId);
	if (players.length < 2) {
		await updateTournamentStatus(tournamentId, 'cancelled');
		throw new Error(`Not enough players (${players.length})`);
	}

	// Generate bracket
	const bracket = generateBracket(players, tournamentId);
	const roundHours = (tournament.round_hours as number) || 24;
	const deadline = new Date(now() + roundHours * 60 * 60 * 1000).toISOString();

	// First pass: create all matches in the database
	const r0Byes: Array<{ slot: number; winner: string }> = [];
	for (let r = 0; r < bracket.length; r++) {
		for (let s = 0; s < bracket[r].length; s++) {
			const slot = bracket[r][s];
			const isBye = slot.playerA === null || slot.playerB === null;
			const isRound0 = r === 0;

			// Compute seed for matches that have both players
			let seed: string | null = null;
			if (slot.playerA && slot.playerB) {
				const sorted = [slot.playerA, slot.playerB].sort();
				const seedNum = hashString(`${tournamentId}|${r}|${s}|${sorted[0]}|${sorted[1]}`);
				seed = seedNum.toString(16).padStart(8, '0');
			}

			await createMatch({
				id: `${tournamentId}/R${r}M${s}`,
				tournamentId,
				round: r,
				slot: s,
				playerA: slot.playerA,
				playerB: slot.playerB,
				status: isRound0 ? (isBye ? 'complete' : 'ready_wait') : 'pending',
				seed,
				roundDeadline: isRound0 ? deadline : null,
			});

			// Defer bye advancement until all matches exist
			if (isBye && isRound0) {
				const winner = slot.playerA ?? slot.playerB;
				if (winner) r0Byes.push({ slot: s, winner });
			}
		}
	}

	// Second pass: now that all matches exist, advance R0 byes into R1
	for (const bye of r0Byes) {
		await updateMatchResult(`${tournamentId}/R0M${bye.slot}`, bye.winner, 0, 0);
		await advanceWinner(tournamentId, 0, bye.slot, bye.winner);
	}

	await updateTournamentStatus(tournamentId, 'active', 0);
	console.log(`[tournament] ${tournamentId} started with ${players.length} players, ${bracket.length} rounds`);
}

/**
 * Advance a match winner to the next round's bracket slot.
 */
export async function advanceWinnerExternal(tournamentId: string, fromRound: number, fromSlot: number, winner: string): Promise<void> {
	return advanceWinner(tournamentId, fromRound, fromSlot, winner);
}

async function advanceWinner(tournamentId: string, fromRound: number, fromSlot: number, winner: string): Promise<void> {
	const nextRound = fromRound + 1;
	const nextSlot = Math.floor(fromSlot / 2);
	const nextMatchId = `${tournamentId}/R${nextRound}M${nextSlot}`;

	const nextMatch = await getMatch(nextMatchId);
	if (!nextMatch) return; // final match, no next round

	const isPlayerA = fromSlot % 2 === 0;
	const currentA = (nextMatch.player_a as string | null);
	const currentB = (nextMatch.player_b as string | null);
	const newA = isPlayerA ? winner : currentA;
	const newB = isPlayerA ? currentB : winner;

	await updateMatchPlayers(nextMatchId, newA, newB);

	// Compute seed if both players are now known
	if (newA && newB) {
		const sorted = [newA, newB].sort();
		const seedNum = hashString(`${tournamentId}|${nextRound}|${nextSlot}|${sorted[0]}|${sorted[1]}`);
		const seed = seedNum.toString(16).padStart(8, '0');
		const db = (await import('./db')).getDb();
		await db.execute({
			sql: 'UPDATE matches SET seed = ? WHERE id = ?',
			args: [seed, nextMatchId],
		});
	}
}

/**
 * Check if the current round is complete. If so, open the next round
 * or complete the tournament.
 */
export async function checkRoundAdvance(tournamentId: string): Promise<boolean> {
	const tournament = await getTournament(tournamentId);
	if (!tournament || tournament.status !== 'active') return false;

	const round = tournament.current_round as number;
	const matches = await getMatchesForRound(tournamentId, round);

	const allDone = matches.every(m =>
		m.status === 'complete' || m.status === 'forfeit',
	);
	if (!allDone) return false;

	const allMatches = await getMatchesForTournament(tournamentId);
	const totalRounds = Math.max(...allMatches.map(m => m.round as number)) + 1;
	const nextRound = round + 1;

	if (nextRound >= totalRounds) {
		// Tournament is complete — admin must manually trigger prize payout
		await completeTournament(tournamentId);
		console.log(`[tournament] ${tournamentId} complete (prize pending admin payout)`);
		return true;
	}

	// Open the next round
	const roundHours = (tournament.round_hours as number) || 24;
	const deadline = new Date(now() + roundHours * 60 * 60 * 1000).toISOString();

	const nextMatches = await getMatchesForRound(tournamentId, nextRound);
	for (const m of nextMatches) {
		if (m.player_a && m.player_b) {
			await updateMatchStatus(m.id as string, 'ready_wait');
			const db = (await import('./db')).getDb();
			await db.execute({
				sql: 'UPDATE matches SET round_deadline = ? WHERE id = ?',
				args: [deadline, m.id],
			});
		} else if (m.player_a || m.player_b) {
			// Bye — auto-advance
			const winner = (m.player_a || m.player_b) as string;
			await updateMatchResult(m.id as string, winner, 0, 0);
			await advanceWinner(tournamentId, nextRound, m.slot as number, winner);
		}
	}

	await updateTournamentStatus(tournamentId, 'active', nextRound);
	console.log(`[tournament] ${tournamentId} round ${nextRound} started`);
	return true;
}

/**
 * Check for timed-out matches in the current round and forfeit them.
 */
export async function checkForfeits(tournamentId: string): Promise<string[]> {
	const tournament = await getTournament(tournamentId);
	if (!tournament || tournament.status !== 'active') return [];

	const round = tournament.current_round as number;
	const matches = await getMatchesForRound(tournamentId, round);
	const forfeited: string[] = [];

	for (const m of matches) {
		if (m.status !== 'ready_wait') continue;
		if (!m.round_deadline) continue;

		const deadline = new Date(m.round_deadline as string).getTime();
		if (now() <= deadline) continue;

		// Deadline passed — forfeit
		// TODO: in future, check who was "ready" and award to them
		// For now: if neither played, dual-forfeit with no winner
		await updateMatchForfeit(m.id as string, null);
		forfeited.push(m.id as string);
		console.log(`[tournament] ${m.id}: forfeit (deadline passed)`);
	}

	return forfeited;
}

/**
 * Start a match: both players are ready. Set status to active,
 * generate seed if not already set.
 */
export async function startMatch(matchId: string): Promise<{
	seed: string;
	playerA: string;
	playerB: string;
}> {
	const match = await getMatch(matchId);
	if (!match) throw new Error(`Match ${matchId} not found`);
	if (match.status !== 'ready_wait') throw new Error(`Match ${matchId} is ${match.status}`);

	const seed = (match.seed as string) || '00000000';
	await updateMatchStarted(matchId, seed);

	return {
		seed,
		playerA: match.player_a as string,
		playerB: match.player_b as string,
	};
}

/**
 * Resolve a match by replaying both players' input traces.
 * Returns the winner and scores.
 */
export async function resolveMatch(matchId: string): Promise<{
	winner: string;
	scoreA: number;
	scoreB: number;
}> {
	const match = await getMatch(matchId);
	if (!match) throw new Error(`Match ${matchId} not found`);

	const seed = parseInt((match.seed as string) || '0', 16) >>> 0;
	const inputsA = await getInputs(matchId, 'A');
	const inputsB = await getInputs(matchId, 'B');

	const scoreA = replaySim(seed, inputsA);
	const scoreB = replaySim(seed, inputsB);

	const playerA = match.player_a as string;
	const playerB = match.player_b as string;
	const winner = scoreA >= scoreB ? playerA : playerB;

	await updateMatchResult(matchId, winner, scoreA, scoreB);

	// Advance winner in bracket
	const tournamentId = match.tournament_id as string;
	const round = match.round as number;
	const slot = match.slot as number;
	await advanceWinner(tournamentId, round, slot, winner);

	// Check if round is complete
	await checkRoundAdvance(tournamentId);

	console.log(`[match] ${matchId}: ${playerA}=${scoreA} ${playerB}=${scoreB} → winner: ${winner}`);
	return { winner, scoreA, scoreB };
}

/**
 * Replay a player's sim from seed + inputs. Returns final score.
 */
export function replayGame(seed: number, inputs: Array<{ tick: number; payload: string }>): number {
	return replaySim(seed, inputs);
}

function replaySim(seed: number, inputs: Array<{ tick: number; payload: string }>): number {
	const config = DEFAULT_CONFIG;
	const state = makeInitialState(seed, config);
	const TIME_CAP = 36000;

	const inputsByTick = new Map<number, CharacterAction[]>();
	for (const inp of inputs) {
		try {
			const action = atob(inp.payload) as CharacterAction;
			if (action === 'up' || action === 'left' || action === 'right' || action === 'fire') {
				if (!inputsByTick.has(inp.tick)) inputsByTick.set(inp.tick, []);
				inputsByTick.get(inp.tick)!.push(action);
			}
		} catch {}
	}

	while (!state.gameOver && state.tick < TIME_CAP) {
		const actions = inputsByTick.get(state.tick);
		if (actions) {
			for (const a of actions) state.character.queuedActions.push(a);
		}
		simTick(state, config);
	}

	return state.score;
}
