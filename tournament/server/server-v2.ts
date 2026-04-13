/**
 * Server V2 — clean rewrite for the tournament redesign.
 * HTTP: static files + leaderboard API + tournament API
 * WebSocket: live match ready/input/done only
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

import { handleApi } from './leaderboard';
import { handleTournamentApi } from './tournament-api';
import { ensureTournamentSchema } from './tournament-db';
import {
	getNametag,
	handleDone,
	handleInput,
	handleReady,
	registerSocket,
	sendTo,
	unregisterSocket,
} from './tournament-ws';
import { checkForfeits, checkRoundAdvance } from './tournament-logic';
import { listTournaments } from './tournament-db';

const PORT = parseInt(process.env.PORT || '7101', 10);
const STATIC_DIR = resolve(process.env.STATIC_DIR || join(__dirname, '..'));

const MIME: Record<string, string> = {
	'.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
	'.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
	'.svg': 'image/svg+xml', '.ico': 'image/x-icon',
	'.woff': 'font/woff', '.woff2': 'font/woff2',
};

// ── HTTP server ──────────────────────────────────────────────────
const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
	// Tournament API
	if (await handleTournamentApi(req, res)) return;
	// Leaderboard API
	if (await handleApi(req, res)) return;

	// Static files
	const urlPath = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname;
	let filePath = join(STATIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
	if (!resolve(filePath).startsWith(STATIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
	if (existsSync(filePath) && statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html');
	if (!existsSync(filePath) || !statSync(filePath).isFile()) { res.writeHead(404); res.end('Not found'); return; }
	res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
	createReadStream(filePath).pipe(res);
});

// ── WebSocket server ─────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });
const allSockets = new Set<WebSocket>();

// Ping every 20s to keep Fly.io proxy alive
setInterval(() => {
	for (const ws of allSockets) {
		if (ws.readyState === WebSocket.OPEN) ws.ping();
	}
}, 20_000);

wss.on('connection', (ws) => {
	allSockets.add(ws);

	ws.on('message', async (raw) => {
		let msg: any;
		try {
			msg = JSON.parse(raw.toString());
		} catch { return; }

		const nametag = getNametag(ws);

		switch (msg.type) {
			case 'register':
				if (msg.identity?.nametag) {
					registerSocket(ws, msg.identity.nametag);
					const tag = msg.identity.nametag;
					sendTo(tag, { type: 'registered', v: 0, nametag: tag });
					console.log(`[ws] ${tag} registered`);
				}
				break;

			case 'match-ready':
				if (nametag && msg.matchId) {
					await handleReady(nametag, msg.matchId);
				}
				break;

			case 'input':
				if (nametag && msg.matchId) {
					await handleInput(nametag, msg.matchId, msg.tick, msg.payload);
				}
				break;

			case 'match-done':
				if (nametag && msg.matchId) {
					await handleDone(nametag, msg.matchId);
				}
				break;
		}
	});

	ws.on('close', () => {
		allSockets.delete(ws);
		unregisterSocket(ws);
	});

	ws.on('error', (err) => {
		console.error('[ws] error:', err.message);
	});
});

// ── Periodic checks (every 60s) ─────────────────────────────────
setInterval(async () => {
	try {
		const tournaments = await listTournaments();
		for (const t of tournaments) {
			if (t.status === 'active') {
				await checkForfeits(t.id as string);
				await checkRoundAdvance(t.id as string);
			}
		}
	} catch (err) {
		console.error('[tick] error:', err);
	}
}, 60_000);

// ── Start ────────────────────────────────────────────────────────
async function boot() {
	await ensureTournamentSchema();
	httpServer.listen(PORT, '::', () => {
		console.log(`[server-v2] listening on http://0.0.0.0:${PORT}`);
		console.log(`[server-v2] static files: ${STATIC_DIR}`);
	});
}

boot().catch((err) => {
	console.error('[server-v2] boot failed:', err);
	process.exit(1);
});

process.on('SIGINT', () => {
	console.log('\n[server-v2] shutting down');
	for (const ws of allSockets) ws.close(1001);
	wss.close(() => httpServer.close(() => process.exit(0)));
});
