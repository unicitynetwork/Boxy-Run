/**
 * All-in-one game server: static files + leaderboard REST API +
 * multi-tournament WebSocket.
 *
 * Players register on connect, then use the lobby system to:
 *   - Challenge a specific player (1v1)
 *   - Join the rolling quick-match queue
 *   - (Future) Enter the weekly Grand Final
 *
 * Once assigned to a tournament, the existing bracket/match flow
 * takes over.
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
import { TournamentManager, type ManagerDelivery } from './manager';
import { Tournament, type Delivery } from './state';

const PORT = parseInt(process.env.PORT || '7101', 10);
const READY_RATE_LIMIT_MS = parseInt(process.env.READY_RATE_LIMIT_MS || '3000', 10);
const QUEUE_COUNTDOWN_MS = parseInt(process.env.QUEUE_COUNTDOWN_MS || '120000', 10);
const QUEUE_MIN = parseInt(process.env.QUEUE_MIN_PLAYERS || '4', 10);
const QUEUE_MAX = parseInt(process.env.QUEUE_MAX_PLAYERS || '8', 10);
const STATIC_DIR = resolve(process.env.STATIC_DIR || join(__dirname, '..'));

const manager = new TournamentManager({
	queueCountdownMs: QUEUE_COUNTDOWN_MS,
	queueMinPlayers: QUEUE_MIN,
	queueMaxPlayers: QUEUE_MAX,
	readyRateLimitMs: READY_RATE_LIMIT_MS,
});

/** Two-way nametag ↔ socket mapping. */
const socketToNametag = new Map<WebSocket, string>();
const nametagToSocket = new Map<string, WebSocket>();
/** All connected sockets including unregistered spectators. */
const allSockets = new Set<WebSocket>();

// ── MIME types ───────────────────────────────────────────────────
const MIME: Record<string, string> = {
	'.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
	'.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
	'.svg': 'image/svg+xml', '.ico': 'image/x-icon',
	'.woff': 'font/woff', '.woff2': 'font/woff2',
};

// ── HTTP server ──────────────────────────────────────────────────
const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
	if (await handleApi(req, res)) return;

	const urlPath = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname;
	let filePath = join(STATIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
	if (!resolve(filePath).startsWith(STATIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
	if (existsSync(filePath) && statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html');
	if (!existsSync(filePath) || !statSync(filePath).isFile()) { res.writeHead(404); res.end('Not found'); return; }

	const ext = extname(filePath);
	res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
	createReadStream(filePath).pipe(res);
});

// ── WebSocket server ─────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
	const addr = req.socket.remoteAddress ?? 'unknown';
	allSockets.add(ws);

	ws.on('message', (raw) => {
		let msg: ClientMessage;
		try {
			const parsed = JSON.parse(raw.toString());
			if (typeof parsed !== 'object' || parsed === null || typeof parsed.type !== 'string') {
				sendError(ws, 'bad_message', 'missing type field');
				return;
			}
			msg = parsed as ClientMessage;
		} catch {
			sendError(ws, 'bad_json', 'malformed JSON');
			return;
		}

		const nametag = socketToNametag.get(ws);

		switch (msg.type) {
			// ── Registration ──
			case 'register':
				handleRegister(ws, msg);
				break;

			// ── Legacy join (for tests) ──
			case 'join':
				handleLegacyJoin(ws, msg);
				break;

			// ── Lobby actions ──
			case 'challenge':
				if (!nametag) { sendError(ws, 'not_registered', 'register first'); break; }
				deliverManager(manager.sendChallenge(nametag, msg.opponent, msg.wager));
				break;
			case 'challenge-accept':
				if (!nametag) { sendError(ws, 'not_registered', 'register first'); break; }
				deliverManager(manager.acceptChallenge(nametag, msg.challengeId));
				break;
			case 'challenge-decline':
				if (!nametag) { sendError(ws, 'not_registered', 'register first'); break; }
				deliverManager(manager.declineChallenge(nametag, msg.challengeId));
				break;
			case 'queue-join':
				if (!nametag) { sendError(ws, 'not_registered', 'register first'); break; }
				deliverManager(manager.joinQueue(nametag));
				break;
			case 'queue-leave':
				if (!nametag) { sendError(ws, 'not_registered', 'register first'); break; }
				deliverManager(manager.leaveQueue(nametag));
				break;

			// ── Match actions (routed to the player's tournament) ──
			case 'match-ready':
			case 'match-unready': {
				if (!nametag) { sendError(ws, 'not_registered', 'register first'); break; }
				const t = manager.getTournament(nametag);
				if (!t) { sendError(ws, 'no_tournament', 'not in a tournament'); break; }
				const d = msg.type === 'match-ready'
					? t.setReady(nametag, msg.matchId)
					: t.setUnready(nametag, msg.matchId);
				deliverTournament(d);
				break;
			}
			case 'input': {
				if (!nametag) { sendError(ws, 'not_registered', 'register first'); break; }
				const t = manager.getTournament(nametag);
				if (!t) break; // silently drop
				deliverTournament(t.relayInput(nametag, msg.matchId, msg.tick, msg.payload));
				break;
			}
			case 'result': {
				if (!nametag) { sendError(ws, 'not_registered', 'register first'); break; }
				const t = manager.getTournament(nametag);
				if (!t) break;
				const d = t.submitResult(
					nametag, msg.matchId, msg.finalTick,
					msg.score as Record<string, number>,
					msg.winner, msg.inputsHash, msg.resultHash,
				);
				deliverTournament(d);
				// Clean up finished tournaments
				manager.cleanupDone();
				break;
			}
			case 'leave':
				ws.close(1000, 'client leave');
				break;
			default:
				// Ignore unknown types (forward compatibility)
				break;
		}
	});

	ws.on('close', () => {
		allSockets.delete(ws);
		const nametag = socketToNametag.get(ws);
		if (nametag) {
			socketToNametag.delete(ws);
			nametagToSocket.delete(nametag);
			deliverManager(manager.unregister(nametag));
		}
	});

	ws.on('error', (err) => {
		console.error(`[ws] error from ${addr}:`, err.message);
	});
});

function handleRegister(ws: WebSocket, msg: ClientMessage & { type: 'register' }): void {
	const nametag = msg.identity.nametag;
	if (socketToNametag.has(ws)) {
		sendError(ws, 'already_registered', 'already registered on this connection');
		return;
	}

	socketToNametag.set(ws, nametag);
	nametagToSocket.set(nametag, ws);
	console.log(`[ws] ${nametag} registered (${manager.getOnlineCount() + 1} online)`);
	deliverManager(manager.register(msg.identity));
}

/**
 * Legacy `join` handler for backward compatibility with existing tests.
 * Creates a standalone tournament and adds the player directly.
 */
function handleLegacyJoin(ws: WebSocket, msg: ClientMessage & { type: 'join' }): void {
	const nametag = msg.identity.nametag;

	// Register if not already
	if (!socketToNametag.has(ws)) {
		socketToNametag.set(ws, nametag);
		nametagToSocket.set(nametag, ws);
		manager.register(msg.identity); // ignore deliveries for legacy path
	}

	// Find or create the legacy tournament
	let t = manager.getTournamentById(msg.tournamentId);
	if (!t) {
		const capacity = parseInt(process.env.LOBBY_CAPACITY || '32', 10);
		const minPlayers = parseInt(process.env.MIN_PLAYERS || String(capacity), 10);
		t = new Tournament({
			id: msg.tournamentId,
			capacity,
			minPlayers,
			readyRateLimitMs: READY_RATE_LIMIT_MS,
		});
		// Store it so subsequent joins find it
		(manager as any).tournaments.set(msg.tournamentId, t);
		(manager as any).playerToTournament.set(nametag, msg.tournamentId);
		const player = (manager as any).registered.get(nametag);
		if (player) player.tournamentId = msg.tournamentId;
	} else {
		(manager as any).playerToTournament.set(nametag, msg.tournamentId);
		const player = (manager as any).registered.get(nametag);
		if (player) player.tournamentId = msg.tournamentId;
	}

	const deliveries = t!.addPlayer(msg.identity);
	const firstMsg = deliveries[0];
	if (firstMsg && firstMsg.to === nametag && firstMsg.message.type === 'error') {
		ws.send(JSON.stringify(firstMsg.message));
		return;
	}

	console.log(`[ws] ${nametag} joined ${msg.tournamentId} (legacy)`);
	deliverTournament(deliveries);
}

// ── Delivery routing ─────────────────────────────────────────────

function deliverManager(deliveries: ManagerDelivery[]): void {
	for (const d of deliveries) {
		const encoded = JSON.stringify(d.message);
		if (d.to === '*') {
			for (const socket of allSockets) {
				if (socket.readyState === WebSocket.OPEN) socket.send(encoded);
			}
			continue;
		}
		const socket = nametagToSocket.get(d.to);
		if (socket?.readyState === WebSocket.OPEN) socket.send(encoded);
	}
}

function deliverTournament(deliveries: Delivery[]): void {
	for (const d of deliveries) {
		const encoded = JSON.stringify(d.message);
		if (d.to === '*') {
			for (const socket of allSockets) {
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

// ── Queue tick (checks countdown timer) ──────────────────────────
setInterval(() => {
	const deliveries = manager.tick();
	if (deliveries.length > 0) deliverManager(deliveries);
}, 1000);

// ── Start ────────────────────────────────────────────────────────
httpServer.listen(PORT, '::', () => {
	console.log(`[server] listening on http://0.0.0.0:${PORT}`);
	console.log(`[server] static files: ${STATIC_DIR}`);
	console.log(`[server] queue: ${QUEUE_MIN}-${QUEUE_MAX} players, ${QUEUE_COUNTDOWN_MS / 1000}s countdown`);
});

process.on('SIGINT', () => {
	console.log('\n[server] shutting down');
	for (const socket of allSockets) socket.close(1001, 'server shutting down');
	wss.close(() => httpServer.close(() => process.exit(0)));
});
