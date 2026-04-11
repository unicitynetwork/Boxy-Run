/**
 * Tournament server — MVP lobby only.
 *
 * Currently implemented:
 *   - Accept WebSocket connections
 *   - Handle `join` (stub chain verification — anything goes for now)
 *   - Track connected players in a single hardcoded tournament
 *   - Broadcast `lobby-state` on roster changes
 *   - Report errors back via the `error` frame
 *
 * Not yet implemented (coming in subsequent commits):
 *   - Real entry-fee verification against the Unicity chain
 *   - Bracket generation and seeding
 *   - Match lifecycle (ready window, match-start, input relay)
 *   - Result hash agreement
 *   - Prize pool payouts
 *   - Reconnection / resume
 */

import { WebSocketServer, WebSocket } from 'ws';

import {
	PROTOCOL_VERSION,
	type ClientMessage,
	type ErrorMessage,
	type JoinMessage,
	type LobbyStateMessage,
	type PublicIdentity,
} from '../protocol/messages';

const PORT = parseInt(process.env.PORT || '7101', 10);
const LOBBY_CAPACITY = 32;

/**
 * For v0 MVP we run a single hardcoded tournament. Real deployment
 * would create tournaments dynamically (from the operator dashboard
 * or an on-chain trigger) and route connections to them by tournament
 * id.
 */
const TOURNAMENT_ID = 'boxyrun-alpha-1';

interface PlayerSession {
	readonly ws: WebSocket;
	readonly identity: PublicIdentity;
	readonly joinedAt: number;
	readonly tournamentId: string;
}

const sessions = new Map<WebSocket, PlayerSession>();

const wss = new WebSocketServer({ port: PORT });

console.log(`[server] listening on ws://localhost:${PORT}`);
console.log(`[server] tournament id: ${TOURNAMENT_ID}, capacity: ${LOBBY_CAPACITY}`);

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
		const session = sessions.get(ws);
		if (session) {
			console.log(`[server] ${session.identity.nametag} disconnected`);
			sessions.delete(ws);
			broadcastLobbyState();
		} else {
			console.log(`[server] connection from ${addr} closed (pre-join)`);
		}
	});

	ws.on('error', (err) => {
		console.error(`[server] socket error from ${addr}:`, err.message);
	});
});

function handleJoin(ws: WebSocket, msg: JoinMessage): void {
	// TODO: verify signature over (tournamentId|entry.txHash) using identity.pubkey
	// TODO: verify entry.txHash against the Unicity chain (amount, recipient, not replayed)
	// For MVP we accept any well-formed join.

	if (msg.tournamentId !== TOURNAMENT_ID) {
		sendError(
			ws,
			'unknown_tournament',
			`no such tournament: ${msg.tournamentId}`,
		);
		return;
	}

	if (sessions.has(ws)) {
		sendError(ws, 'already_joined', 'this connection has already joined');
		return;
	}

	if (sessions.size >= LOBBY_CAPACITY) {
		sendError(ws, 'lobby_full', 'tournament is full');
		return;
	}

	for (const existing of sessions.values()) {
		if (existing.identity.nametag === msg.identity.nametag) {
			sendError(
				ws,
				'duplicate_nametag',
				`${msg.identity.nametag} is already in the lobby`,
			);
			return;
		}
	}

	const session: PlayerSession = {
		ws,
		identity: msg.identity,
		joinedAt: Date.now(),
		tournamentId: msg.tournamentId,
	};
	sessions.set(ws, session);
	console.log(
		`[server] ${msg.identity.nametag} joined (${sessions.size}/${LOBBY_CAPACITY})`,
	);

	broadcastLobbyState();
}

function broadcastLobbyState(): void {
	const state: LobbyStateMessage = {
		type: 'lobby-state',
		v: PROTOCOL_VERSION,
		tournamentId: TOURNAMENT_ID,
		players: Array.from(sessions.values()).map((s) => ({
			nametag: s.identity.nametag,
			joinedAt: s.joinedAt,
		})),
		capacity: LOBBY_CAPACITY,
		startsAt: null,
	};
	const encoded = JSON.stringify(state);
	for (const session of sessions.values()) {
		if (session.ws.readyState === WebSocket.OPEN) {
			session.ws.send(encoded);
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

// Graceful shutdown on SIGINT so Ctrl+C doesn't leave the port occupied.
process.on('SIGINT', () => {
	console.log('\n[server] shutting down');
	for (const session of sessions.values()) {
		session.ws.close(1001, 'server shutting down');
	}
	wss.close(() => process.exit(0));
});
