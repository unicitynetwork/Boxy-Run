/**
 * Tournament server — thin WebSocket layer on top of the Tournament
 * state machine in state.ts. Handles connection lifecycle, parses
 * incoming JSON, forwards the logic to the Tournament class, and
 * routes its returned Delivery array back to the right WebSockets.
 *
 * State machine logic lives in state.ts. This file should stay small
 * and focused on networking concerns (message parsing, socket routing,
 * logging, graceful shutdown).
 */

import { WebSocketServer, WebSocket } from 'ws';

import {
	PROTOCOL_VERSION,
	type ClientMessage,
	type ErrorMessage,
} from '../protocol/messages';
import { Tournament, type Delivery } from './state';

const PORT = parseInt(process.env.PORT || '7101', 10);
const LOBBY_CAPACITY = parseInt(process.env.LOBBY_CAPACITY || '32', 10);
const MIN_PLAYERS = parseInt(
	process.env.MIN_PLAYERS || String(LOBBY_CAPACITY),
	10,
);
const ROUND_WINDOW_MS = parseInt(
	process.env.ROUND_WINDOW_MS || String(24 * 60 * 60 * 1000),
	10,
);
const TOURNAMENT_ID = process.env.TOURNAMENT_ID || 'boxyrun-alpha-1';

const tournament = new Tournament({
	id: TOURNAMENT_ID,
	capacity: LOBBY_CAPACITY,
	minPlayers: MIN_PLAYERS,
	roundWindowMs: ROUND_WINDOW_MS,
});

/**
 * Two-way map: WebSocket ↔ nametag. Used to deliver messages to
 * specific players by their in-game identity.
 */
const socketToNametag = new Map<WebSocket, string>();
const nametagToSocket = new Map<string, WebSocket>();

const wss = new WebSocketServer({ port: PORT });

console.log(`[server] listening on ws://localhost:${PORT}`);
console.log(
	`[server] tournament=${TOURNAMENT_ID} capacity=${LOBBY_CAPACITY} minPlayers=${MIN_PLAYERS}`,
);

wss.on('connection', (ws, req) => {
	const addr = req.socket.remoteAddress ?? 'unknown';
	console.log(`[server] new connection from ${addr}`);

	ws.on('message', (raw) => {
		let msg: ClientMessage;
		try {
			const parsed = JSON.parse(raw.toString());
			if (
				typeof parsed !== 'object' ||
				parsed === null ||
				typeof parsed.type !== 'string'
			) {
				sendError(ws, 'bad_message', 'missing or non-string `type` field');
				return;
			}
			msg = parsed as ClientMessage;
		} catch {
			sendError(ws, 'bad_json', 'malformed JSON');
			return;
		}

		switch (msg.type) {
			case 'join':
				handleJoin(ws, msg);
				break;
			case 'match-ready':
			case 'match-unready': {
				const nametag = socketToNametag.get(ws);
				if (!nametag) { sendError(ws, 'not_joined', 'join first'); break; }
				const deliveries = msg.type === 'match-ready'
					? tournament.setReady(nametag, msg.matchId)
					: tournament.setUnready(nametag, msg.matchId);
				deliver(deliveries);
				break;
			}
			case 'input': {
				const nametag = socketToNametag.get(ws);
				if (!nametag) { sendError(ws, 'not_joined', 'join first'); break; }
				deliver(tournament.relayInput(nametag, msg.matchId, msg.tick, msg.payload));
				break;
			}
			case 'leave':
				ws.close(1000, 'client leave');
				break;
			default:
				sendError(
					ws,
					'unhandled_type',
					`server does not yet handle '${msg.type}'`,
				);
		}
	});

	ws.on('close', () => {
		const nametag = socketToNametag.get(ws);
		if (nametag) {
			console.log(`[server] ${nametag} disconnected`);
			socketToNametag.delete(ws);
			nametagToSocket.delete(nametag);
			const deliveries = tournament.removePlayer(nametag);
			deliver(deliveries);
		} else {
			console.log(`[server] connection from ${addr} closed (pre-join)`);
		}
	});

	ws.on('error', (err) => {
		console.error(`[server] socket error from ${addr}:`, err.message);
	});
});

function handleJoin(ws: WebSocket, msg: ClientMessage & { type: 'join' }): void {
	// TODO: verify signature over (tournamentId|entry.txHash)
	// TODO: verify entry.txHash against the Unicity chain
	if (msg.tournamentId !== TOURNAMENT_ID) {
		sendError(ws, 'unknown_tournament', `no such tournament: ${msg.tournamentId}`);
		return;
	}
	if (socketToNametag.has(ws)) {
		sendError(ws, 'already_joined', 'this connection has already joined');
		return;
	}

	// Optimistically bind this socket to the nametag BEFORE calling
	// addPlayer so that if addPlayer's broadcasts go out before we
	// return from this function, the sender is already routable.
	const nametag = msg.identity.nametag;
	const deliveries = tournament.addPlayer(msg.identity);

	// If the first delivery is an error addressed to this player, the
	// join was rejected; don't register the socket mapping.
	const firstMsg = deliveries[0];
	if (
		firstMsg &&
		firstMsg.to === nametag &&
		firstMsg.message.type === 'error'
	) {
		ws.send(JSON.stringify(firstMsg.message));
		return;
	}

	socketToNametag.set(ws, nametag);
	nametagToSocket.set(nametag, ws);
	console.log(
		`[server] ${nametag} joined (${tournament.getPlayerCount()}/${LOBBY_CAPACITY})`,
	);

	deliver(deliveries);
}

/**
 * Route a batch of deliveries from the Tournament class to the right
 * WebSockets. A `to` of '*' broadcasts to every currently-connected
 * player. Unknown nametags are silently dropped (the player may have
 * disconnected between state computation and delivery).
 */
function deliver(deliveries: Delivery[]): void {
	for (const d of deliveries) {
		const encoded = JSON.stringify(d.message);
		if (d.to === '*') {
			for (const socket of nametagToSocket.values()) {
				if (socket.readyState === WebSocket.OPEN) {
					socket.send(encoded);
				}
			}
			continue;
		}
		const socket = nametagToSocket.get(d.to);
		if (!socket) continue;
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(encoded);
		}
	}
}

function sendError(ws: WebSocket, code: string, message: string): void {
	const err: ErrorMessage = {
		type: 'error',
		v: PROTOCOL_VERSION,
		code,
		message,
	};
	if (ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(err));
	}
}

process.on('SIGINT', () => {
	console.log('\n[server] shutting down');
	for (const socket of nametagToSocket.values()) {
		socket.close(1001, 'server shutting down');
	}
	wss.close(() => process.exit(0));
});
