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
	broadcastToAll,
	getNametag,
	getOnlinePlayers,
	handleDone,
	handleInput,
	handleReady,
	matchSides,
	registerSocket,
	sendTo,
	unregisterSocket,
} from './tournament-ws';
import {
	createTournament,
	getMatchesForRound,
	registerPlayer,
} from './tournament-db';
import { startMatch, startTournament } from './tournament-logic';
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
					const others = getOnlinePlayers().filter(n => n !== tag);
					sendTo(tag, { type: 'registered', v: 0, nametag: tag, onlinePlayers: others });
					// Notify everyone that a new player came online
					broadcastToAll({ type: 'player-online', v: 0, nametag: tag, online: true });
					console.log(`[ws] ${tag} registered (${getOnlinePlayers().length} online)`);
				}
				break;

			case 'challenge':
				if (nametag && msg.opponent) {
					await handleChallenge(nametag, msg.opponent);
				}
				break;

			case 'challenge-accept':
				if (nametag && msg.challengeId) {
					await handleChallengeAccept(nametag, msg.challengeId);
				}
				break;

			case 'challenge-decline':
				if (nametag && msg.challengeId) {
					handleChallengeDecline(nametag, msg.challengeId);
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
		const closedTag = getNametag(ws);
		unregisterSocket(ws);
		if (closedTag) {
			broadcastToAll({ type: 'player-online', v: 0, nametag: closedTag, online: false });
		}
	});

	ws.on('error', (err) => {
		console.error('[ws] error:', err.message);
	});
});

// ── Challenge system ─────────────────────────────────────────────
const pendingChallenges = new Map<string, { from: string; to: string; createdAt: number }>();
let challengeCounter = 0;

async function handleChallenge(from: string, opponent: string) {
	if (!getOnlinePlayers().includes(opponent)) {
		sendTo(from, { type: 'error', v: 0, code: 'opponent_offline', message: `${opponent} is not online` });
		return;
	}
	if (from === opponent) {
		sendTo(from, { type: 'error', v: 0, code: 'self_challenge', message: 'Cannot challenge yourself' });
		return;
	}
	const id = `ch-${++challengeCounter}`;
	pendingChallenges.set(id, { from, to: opponent, createdAt: Date.now() });
	sendTo(from, { type: 'challenge-sent', v: 0, challengeId: id, opponent });
	sendTo(opponent, { type: 'challenge-received', v: 0, challengeId: id, from });
}

async function handleChallengeAccept(acceptor: string, challengeId: string) {
	const ch = pendingChallenges.get(challengeId);
	if (!ch || ch.to !== acceptor) {
		sendTo(acceptor, { type: 'error', v: 0, code: 'invalid_challenge', message: 'Challenge not found' });
		return;
	}
	pendingChallenges.delete(challengeId);

	try {
		// Create a 2-player tournament, start it, and start the match
		const tId = `challenge-${Date.now()}`;
		await createTournament({ id: tId, name: `${ch.from} vs ${ch.to}`, maxPlayers: 2, startsAt: new Date().toISOString() });
		await registerPlayer(tId, ch.from);
		await registerPlayer(tId, ch.to);
		await startTournament(tId);

		// Get the match and start it immediately (skip the ready phase)
		const matches = await getMatchesForRound(tId, 0);
		const match = matches.find(m => m.status === 'ready_wait');

		if (match) {
			const result = await startMatch(match.id as string);
			const startsAt = Date.now() + 3000;
			const matchId = match.id as string;

			// Register match sides for input relay
			matchSides.set(matchId, { A: result.playerA, B: result.playerB });

			// Send both players directly to the game
			sendTo(ch.from, {
				type: 'challenge-start', v: 0, challengeId, tournamentId: tId,
				matchId, seed: result.seed,
				opponent: ch.to, youAre: ch.from === result.playerA ? 'A' : 'B',
				startsAt,
			});
			sendTo(ch.to, {
				type: 'challenge-start', v: 0, challengeId, tournamentId: tId,
				matchId, seed: result.seed,
				opponent: ch.from, youAre: ch.to === result.playerA ? 'A' : 'B',
				startsAt,
			});
		}
	} catch (err: any) {
		console.error('[challenge] accept error:', err);
		sendTo(ch.from, { type: 'error', v: 0, code: 'challenge_failed', message: err.message });
		sendTo(acceptor, { type: 'error', v: 0, code: 'challenge_failed', message: err.message });
	}
}

function handleChallengeDecline(decliner: string, challengeId: string) {
	const ch = pendingChallenges.get(challengeId);
	if (!ch || ch.to !== decliner) return;
	pendingChallenges.delete(challengeId);
	sendTo(ch.from, { type: 'challenge-declined', v: 0, challengeId, by: decliner });
}

// ── Expire stale challenges every 30s ────────────────────────────
setInterval(() => {
	const now = Date.now();
	for (const [id, ch] of pendingChallenges) {
		if (now - ch.createdAt > 30000) {
			pendingChallenges.delete(id);
			sendTo(ch.from, { type: 'error', v: 0, code: 'challenge_expired', message: 'Challenge expired' });
		}
	}
}, 30000);

// ── Notify when players go offline ──────────────────────────────
// (handled in ws.on('close') via unregisterSocket + broadcast)

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
