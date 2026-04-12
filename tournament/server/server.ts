/**
 * All-in-one game server: static files + leaderboard REST API +
 * tournament WebSocket — all on a single port.
 *
 * HTTP requests:
 *   /api/*        → leaderboard handlers (leaderboard.ts)
 *   everything    → static files from STATIC_DIR
 *
 * WebSocket upgrade:
 *   ws://host/    → tournament protocol (state.ts)
 *
 * SQLite database at DB_PATH for leaderboard persistence.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

import { WebSocketServer, WebSocket } from 'ws';

import {
	PROTOCOL_VERSION,
	type ClientMessage,
	type ErrorMessage,
} from '../protocol/messages';
import { handleApi } from './leaderboard';
import { Tournament, type Delivery } from './state';

const PORT = parseInt(process.env.PORT || '7101', 10);
const LOBBY_CAPACITY = parseInt(process.env.LOBBY_CAPACITY || '32', 10);
const MIN_PLAYERS = parseInt(process.env.MIN_PLAYERS || String(LOBBY_CAPACITY), 10);
const ROUND_WINDOW_MS = parseInt(process.env.ROUND_WINDOW_MS || String(24 * 60 * 60 * 1000), 10);
const TOURNAMENT_ID = process.env.TOURNAMENT_ID || 'boxyrun-alpha-1';
const READY_RATE_LIMIT_MS = parseInt(process.env.READY_RATE_LIMIT_MS || '3000', 10);
const STATIC_DIR = resolve(process.env.STATIC_DIR || join(__dirname, '..'));

const tournament = new Tournament({
	id: TOURNAMENT_ID,
	capacity: LOBBY_CAPACITY,
	minPlayers: MIN_PLAYERS,
	roundWindowMs: ROUND_WINDOW_MS,
	readyRateLimitMs: READY_RATE_LIMIT_MS,
});

const socketToNametag = new Map<WebSocket, string>();
const nametagToSocket = new Map<string, WebSocket>();

// ── MIME types for static serving ────────────────────────────────
const MIME: Record<string, string> = {
	'.html': 'text/html',
	'.css': 'text/css',
	'.js': 'application/javascript',
	'.json': 'application/json',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
};

// ── HTTP server ──────────────────────────────────────────────────
const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
	// Try API routes first
	if (await handleApi(req, res)) return;

	// Static file serving
	const urlPath = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname;
	let filePath = join(STATIC_DIR, urlPath === '/' ? 'index.html' : urlPath);

	// Prevent directory traversal
	if (!resolve(filePath).startsWith(STATIC_DIR)) {
		res.writeHead(403);
		res.end('Forbidden');
		return;
	}

	// If it's a directory, try index.html
	if (existsSync(filePath) && statSync(filePath).isDirectory()) {
		filePath = join(filePath, 'index.html');
	}

	if (!existsSync(filePath) || !statSync(filePath).isFile()) {
		res.writeHead(404);
		res.end('Not found');
		return;
	}

	const ext = extname(filePath);
	const contentType = MIME[ext] || 'application/octet-stream';
	res.writeHead(200, { 'Content-Type': contentType });
	createReadStream(filePath).pipe(res);
});

// ── WebSocket server (attached to the HTTP server) ───────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
	const addr = req.socket.remoteAddress ?? 'unknown';

	ws.on('message', (raw) => {
		let msg: ClientMessage;
		try {
			const parsed = JSON.parse(raw.toString());
			if (typeof parsed !== 'object' || parsed === null || typeof parsed.type !== 'string') {
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
			case 'result': {
				const nametag = socketToNametag.get(ws);
				if (!nametag) { sendError(ws, 'not_joined', 'join first'); break; }
				deliver(tournament.submitResult(
					nametag, msg.matchId, msg.finalTick,
					msg.score as Record<string, number>,
					msg.winner, msg.inputsHash, msg.resultHash,
				));
				break;
			}
			case 'leave':
				ws.close(1000, 'client leave');
				break;
			default:
				sendError(ws, 'unhandled_type', `unhandled: ${msg.type}`);
		}
	});

	ws.on('close', () => {
		const nametag = socketToNametag.get(ws);
		if (nametag) {
			socketToNametag.delete(ws);
			nametagToSocket.delete(nametag);
			deliver(tournament.removePlayer(nametag));
		}
	});

	ws.on('error', (err) => {
		console.error(`[ws] error from ${addr}:`, err.message);
	});
});

function handleJoin(ws: WebSocket, msg: ClientMessage & { type: 'join' }): void {
	if (msg.tournamentId !== TOURNAMENT_ID) {
		sendError(ws, 'unknown_tournament', `no such tournament: ${msg.tournamentId}`);
		return;
	}
	if (socketToNametag.has(ws)) {
		sendError(ws, 'already_joined', 'this connection has already joined');
		return;
	}

	const nametag = msg.identity.nametag;
	const deliveries = tournament.addPlayer(msg.identity);

	const firstMsg = deliveries[0];
	if (firstMsg && firstMsg.to === nametag && firstMsg.message.type === 'error') {
		ws.send(JSON.stringify(firstMsg.message));
		return;
	}

	socketToNametag.set(ws, nametag);
	nametagToSocket.set(nametag, ws);
	console.log(`[ws] ${nametag} joined (${tournament.getPlayerCount()}/${LOBBY_CAPACITY})`);
	deliver(deliveries);
}

function deliver(deliveries: Delivery[]): void {
	for (const d of deliveries) {
		const encoded = JSON.stringify(d.message);
		if (d.to === '*') {
			for (const socket of nametagToSocket.values()) {
				if (socket.readyState === WebSocket.OPEN) socket.send(encoded);
			}
			continue;
		}
		const socket = nametagToSocket.get(d.to);
		if (socket?.readyState === WebSocket.OPEN) socket.send(encoded);
	}
}

function sendError(ws: WebSocket, code: string, message: string): void {
	const err: ErrorMessage = { type: 'error', v: PROTOCOL_VERSION, code, message };
	if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(err));
}

// ── Start ────────────────────────────────────────────────────────
httpServer.listen(PORT, '0.0.0.0', () => {
	console.log(`[server] listening on http://0.0.0.0:${PORT}`);
	console.log(`[server] static files: ${STATIC_DIR}`);
	console.log(`[server] tournament=${TOURNAMENT_ID} capacity=${LOBBY_CAPACITY} minPlayers=${MIN_PLAYERS}`);
});

process.on('SIGINT', () => {
	console.log('\n[server] shutting down');
	for (const socket of nametagToSocket.values()) socket.close(1001, 'server shutting down');
	wss.close(() => httpServer.close(() => process.exit(0)));
});
