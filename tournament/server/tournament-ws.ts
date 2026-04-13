/**
 * WebSocket handler for live tournament matches. Minimal — only
 * handles ready status, input relay, and match completion.
 * All state lives in the database, not in memory.
 */

import type { WebSocket } from 'ws';
import {
	getMatch,
	storeInput,
	updateMatchStatus,
} from './tournament-db';
import { resolveMatch, startMatch } from './tournament-logic';
import { hashString } from './bracket';

/** Connected players: nametag → socket */
const players = new Map<string, WebSocket>();
/** Socket → nametag reverse mapping */
const sockets = new Map<WebSocket, string>();
/** Match ready flags: matchId → Set<nametag> */
const readyFlags = new Map<string, Set<string>>();
/** Match side mapping: matchId → { A: nametag, B: nametag } */
const matchSides = new Map<string, { A: string; B: string }>();
/** Players who have submitted "done" for a match */
const matchDone = new Map<string, Set<string>>();

export function registerSocket(ws: WebSocket, nametag: string): void {
	// Clean up old socket for same nametag
	const old = players.get(nametag);
	if (old && old !== ws) {
		sockets.delete(old);
	}
	players.set(nametag, ws);
	sockets.set(ws, nametag);
}

export function unregisterSocket(ws: WebSocket): void {
	const nametag = sockets.get(ws);
	if (nametag && players.get(nametag) === ws) {
		players.delete(nametag);
	}
	sockets.delete(ws);
}

export function getNametag(ws: WebSocket): string | undefined {
	return sockets.get(ws);
}

export function sendTo(nametag: string, msg: Record<string, unknown>): void {
	const ws = players.get(nametag);
	if (ws?.readyState === 1) {
		ws.send(JSON.stringify(msg));
	}
}

export function broadcastToAll(msg: Record<string, unknown>): void {
	const encoded = JSON.stringify(msg);
	for (const ws of players.values()) {
		if (ws.readyState === 1) ws.send(encoded);
	}
}

/**
 * Handle a match-ready message. When both players are ready,
 * start the match.
 */
export async function handleReady(nametag: string, matchId: string): Promise<void> {
	const match = await getMatch(matchId);
	if (!match || match.status !== 'ready_wait') {
		sendTo(nametag, { type: 'error', v: 0, code: 'not_ready_wait', message: `Match ${matchId} is not awaiting ready` });
		return;
	}

	const playerA = match.player_a as string;
	const playerB = match.player_b as string;
	if (nametag !== playerA && nametag !== playerB) {
		sendTo(nametag, { type: 'error', v: 0, code: 'not_in_match', message: 'You are not in this match' });
		return;
	}

	// Set ready flag
	if (!readyFlags.has(matchId)) readyFlags.set(matchId, new Set());
	readyFlags.get(matchId)!.add(nametag);

	// Notify opponent
	const opponent = nametag === playerA ? playerB : playerA;
	sendTo(opponent, { type: 'match-status', v: 0, matchId, readyA: readyFlags.get(matchId)!.has(playerA), readyB: readyFlags.get(matchId)!.has(playerB) });
	sendTo(nametag, { type: 'match-status', v: 0, matchId, readyA: readyFlags.get(matchId)!.has(playerA), readyB: readyFlags.get(matchId)!.has(playerB) });

	// If both ready, start the match
	if (readyFlags.get(matchId)!.has(playerA) && readyFlags.get(matchId)!.has(playerB)) {
		readyFlags.delete(matchId);
		const result = await startMatch(matchId);
		const startsAt = Date.now() + 3000;

		matchSides.set(matchId, { A: result.playerA, B: result.playerB });

		sendTo(result.playerA, {
			type: 'match-start', v: 0, matchId,
			seed: result.seed, opponent: result.playerB,
			youAre: 'A', startsAt, timeCapTicks: 36000,
		});
		sendTo(result.playerB, {
			type: 'match-start', v: 0, matchId,
			seed: result.seed, opponent: result.playerA,
			youAre: 'B', startsAt, timeCapTicks: 36000,
		});
	}
}

/**
 * Handle an input message — relay to opponent and store.
 */
export async function handleInput(
	nametag: string,
	matchId: string,
	tick: number,
	payload: string,
): Promise<void> {
	const sides = matchSides.get(matchId);
	if (!sides) return;

	const side = nametag === sides.A ? 'A' : nametag === sides.B ? 'B' : null;
	if (!side) return;

	// Store in database
	await storeInput(matchId, side, tick, payload);

	// Relay to opponent
	const opponent = side === 'A' ? sides.B : sides.A;
	sendTo(opponent, { type: 'opponent-input', v: 0, matchId, tick, payload });
}

/**
 * Handle a "done" message — player's game is over, waiting for
 * the opponent to finish too. When both are done, resolve the match.
 */
export async function handleDone(nametag: string, matchId: string): Promise<void> {
	if (!matchDone.has(matchId)) matchDone.set(matchId, new Set());
	matchDone.get(matchId)!.add(nametag);

	const sides = matchSides.get(matchId);
	if (!sides) return;

	// Both done?
	if (matchDone.get(matchId)!.has(sides.A) && matchDone.get(matchId)!.has(sides.B)) {
		matchDone.delete(matchId);
		matchSides.delete(matchId);

		try {
			const result = await resolveMatch(matchId);

			// Send result to both players
			sendTo(sides.A, {
				type: 'match-end', v: 0, matchId,
				winner: result.winner,
				scoreA: result.scoreA,
				scoreB: result.scoreB,
			});
			sendTo(sides.B, {
				type: 'match-end', v: 0, matchId,
				winner: result.winner,
				scoreA: result.scoreA,
				scoreB: result.scoreB,
			});

			// Broadcast bracket update to all connected players
			broadcastToAll({ type: 'bracket-update', v: 0, matchId });
		} catch (err) {
			console.error(`[match] ${matchId} resolve error:`, err);
		}
	}
}
