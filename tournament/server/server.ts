/**
 * Server V2 — clean rewrite for the tournament redesign.
 * HTTP: static files + leaderboard API + tournament API
 * WebSocket: live match ready/input/done only
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync, copyFileSync, readdirSync, unlinkSync } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

// Polyfill global WebSocket — Node 20 lacks it (added in Node 22). The
// Sphere SDK's L1 module references the global at runtime, so without
// this the address-discovery scan throws on boot. Setting it here, before
// any SDK code loads, lets both the SDK and our own ws server use the
// same `ws` package.
if (typeof (globalThis as any).WebSocket === 'undefined') {
	(globalThis as any).WebSocket = WebSocket;
}

import { handleApi } from './leaderboard';
import { handleTournamentApi } from './tournament-api';
import { getDb, ensureSchema } from './db';
import { ensureTournamentSchema } from './tournament-db';
import {
	broadcastToAll,
	getNametag,
	getOnlinePlayers,
	handleDone,
	handleRematch,
	handleInput,
	handleReady,
	reconcileMatch,
	registerSocket,
	sendTo,
	unregisterSocket,
} from './tournament-ws';
import {
	createTournament,
	getMatchesForRound,
	getRegistrationCount,
	registerPlayer,
	listTournaments,
} from './tournament-db';
import { startMatch, startTournament } from './tournament-logic';
import { checkForfeits, checkRoundAdvance } from './tournament-logic';
import { now, advanceClock, resetClock, getClockOffset } from './clock';
import {
	applyChallenge,
	applyChallengeAccept,
	applyChallengeDecline,
	reconcileChallenges,
} from './challenge';

const PORT = parseInt(process.env.PORT || '7101', 10);
const STATIC_DIR = resolve(process.env.STATIC_DIR || join(__dirname, '..'));

const MIME: Record<string, string> = {
	'.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
	'.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
	'.svg': 'image/svg+xml', '.ico': 'image/x-icon',
	'.woff': 'font/woff', '.woff2': 'font/woff2',
};

// ── HTTP server ──────────────────────────────────────────────────
const TEST_MODE = process.env.TEST_MODE === '1';

// ── Traffic counters ─────────────────────────────────────────────
let httpReqs = 0;
let wsMessages = 0;
let httpBytes = 0;
setInterval(() => {
	if (httpReqs > 0 || wsMessages > 0) {
		console.log(`[traffic] http=${httpReqs} req/min ws=${wsMessages} msg/min bytes=${(httpBytes/1024).toFixed(1)}KB/min`);
		httpReqs = 0;
		wsMessages = 0;
		httpBytes = 0;
	}
}, 60_000);

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
	httpReqs++;
	// Test-only endpoints: fake-clock controls. Available only when TEST_MODE=1.
	if (TEST_MODE && req.url?.startsWith('/__test/')) {
		const urlPath = new URL(req.url, `http://${req.headers.host}`).pathname;
		if (urlPath === '/__test/advance-clock' && req.method === 'POST') {
			try {
				let body = '';
				for await (const chunk of req) body += chunk;
				const { ms } = JSON.parse(body || '{}');
				advanceClock(Number(ms) || 0);
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ ok: true, offset: getClockOffset() }));
			} catch (e: any) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: e.message }));
			}
			return;
		}
		if (urlPath === '/__test/reset-clock' && req.method === 'POST') {
			resetClock();
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: true, offset: getClockOffset() }));
			return;
		}
	}

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
	const ext = extname(filePath);
	const headers: Record<string, string> = {
		'Content-Type': MIME[ext] || 'application/octet-stream',
	};
	// HTML and JS bundles must always revalidate on deploy — otherwise users
	// keep running yesterday's client against today's server (stale-bundle
	// bugs are nightmare to diagnose: server logs show one thing, the user
	// sees another, and there's no obvious signal). `no-cache` still allows
	// the browser to serve from cache on a 304, so we don't pay bandwidth
	// for unchanged files — we just guarantee freshness.
	if (ext === '.html' || ext === '.js') {
		headers['Cache-Control'] = 'no-cache, must-revalidate';
	}
	// Let Fly.io's proxy handle gzip — manual gzip can cause
	// double-compression or partial content issues.
	// HTML files get a small inline config script injected so the client
	// knows which arena wallet (and any other env-specific setting) to use.
	// Avoids per-environment client builds.
	if (ext === '.html') {
		const { readFileSync } = require('node:fs');
		const html = readFileSync(filePath, 'utf8') as string;
		const arena = process.env.ARENA_WALLET_NAMETAG || '@boxyrunarena';
		const inject = `<script>window.__BOXY_ARENA_WALLET = ${JSON.stringify(arena)};</script>`;
		const out = html.includes('</head>')
			? html.replace('</head>', `${inject}</head>`)
			: inject + html;
		res.writeHead(200, headers);
		res.end(out);
		return;
	}
	res.writeHead(200, headers);
	createReadStream(filePath).pipe(res);
});

// ── WebSocket server ─────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });
const allSockets = new Set<WebSocket>();

// Every 10s: WebSocket protocol ping (keeps Fly's ~60s idle proxy alive + Node
// clients can use it as a heartbeat) + app-level heartbeat message (browser
// clients can't observe protocol-level pings, so we need an app-layer signal).
setInterval(() => {
	const hb = JSON.stringify({ type: 'heartbeat', v: 0, ts: Date.now() });
	for (const ws of allSockets) {
		if (ws.readyState === WebSocket.OPEN) {
			ws.ping();
			try { ws.send(hb); } catch {}
		}
	}
}, 10_000);

wss.on('connection', (ws) => {
	allSockets.add(ws);

	ws.on('message', async (raw) => {
		wsMessages++;
		let msg: any;
		try {
			msg = JSON.parse(raw.toString());
		} catch { return; }

		const nametag = getNametag(ws);

		switch (msg.type) {
			case 'register':
				// Body-trusted nametag for routing. The server's match-level
				// handlers (applyReady/applyDone/etc.) check match membership
				// independently — an impersonator claiming someone else's
				// nametag here can receive their pushes but can't act as
				// them, because every action funnels back through server-
				// authoritative handlers that verify the WS owner is in the
				// match. Real value-moving operations (entry fees, wagers)
				// go through the on-chain transfer path in arena-watcher.ts,
				// where the wallet's signature is the auth.
				if (msg.identity?.nametag) {
					const tag = msg.identity.nametag;
					registerSocket(ws, tag);
					const others = getOnlinePlayers().filter(n => n !== tag);
					sendTo(tag, {
						type: 'registered', v: 0, nametag: tag, onlinePlayers: others,
						protocolVersion: 0,
					});
					broadcastToAll({ type: 'player-online', v: 0, nametag: tag, online: true });
					console.log(`[ws] ${tag} registered (${getOnlinePlayers().length} online)`);
				}
				break;

			case 'challenge':
				if (nametag && msg.opponent) {
					await handleChallenge(nametag, msg.opponent, msg.wager || 0, msg.bestOf || 1);
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

			case 'chat':
				if (nametag && msg.message && typeof msg.message === 'string') {
					const text = msg.message.slice(0, 200);
					if (msg.to) {
						console.log(`[chat] ${nametag} → ${msg.to}: ${text}`);
						sendTo(msg.to, { type: 'chat', v: 0, from: nametag, message: text });
					} else {
						console.log(`[chat] ${nametag} (lobby): ${text}`);
						broadcastToAll({ type: 'chat', v: 0, from: nametag, message: text });
					}
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
			case 'rematch':
				if (nametag && msg.matchId) {
					await handleRematch(nametag, msg.matchId);
				}
				break;
		}
	});

	ws.on('close', () => {
		allSockets.delete(ws);
		// Get nametag BEFORE unregister deletes the mapping
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

// ── Challenge WS wrappers ─────────────────────────────────────────
// Core logic lives in ./challenge.ts so REST and WS share the same path.

async function handleChallenge(from: string, opponent: string, wager: number, bestOf: number = 1) {
	const r = await applyChallenge(from, opponent, wager, bestOf);
	if (!r.ok) {
		sendTo(from, { type: 'error', v: 0, code: r.code, message: r.message });
	}
}

async function handleChallengeAccept(acceptor: string, challengeId: string) {
	const r = await applyChallengeAccept(acceptor, challengeId);
	if (!r.ok) {
		sendTo(acceptor, { type: 'error', v: 0, code: r.code, message: r.message });
	}
}

function handleChallengeDecline(decliner: string, challengeId: string) {
	applyChallengeDecline(decliner, challengeId);
}

// ── Notify when players go offline ──────────────────────────────
// (handled in ws.on('close') via unregisterSocket + broadcast)

// ── Periodic reconciliation (every 1s) ──────────────────────────
setInterval(async () => {
	try {
		// Expire stale challenge invitations
		reconcileChallenges();
		const tournaments = await listTournaments();
		for (const t of tournaments) {
			// Auto-start tournaments whose starts_at has passed
			if (t.status === 'registration') {
				const startsAt = new Date(t.starts_at as string).getTime();
				if (now() >= startsAt) {
					const count = await getRegistrationCount(t.id as string);
					if (count >= 2) {
						console.log(`[auto-start] starting tournament ${t.id} with ${count} players`);
						await startTournament(t.id as string);
					}
				}
			}
			if (t.status === 'active') {
				await checkForfeits(t.id as string);
				await checkRoundAdvance(t.id as string);
				// Reconcile in-memory match state — includes force-resolve of
				// both-offline matches (previously a separate forceResolveStuck).
				const { getMatchesForTournament } = await import('./tournament-db');
				const matches = await getMatchesForTournament(t.id as string);
				for (const m of matches) {
					if (m.status === 'ready_wait' || m.status === 'active') {
						await reconcileMatch(m.id as string);
					}
				}
			}
		}
	} catch (err) {
		console.error('[tick] error:', err);
	}
}, 1_000);


// ── Periodic DB backup ──────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || './boxyrun.db';
const BACKUP_INTERVAL_MS = 6 * 60 * 60_000; // every 6 hours
const MAX_BACKUPS = 8; // keep ~2 days of backups

function backupDb(): void {
	if (!existsSync(DB_PATH)) return;
	const dir = dirname(DB_PATH);
	const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const dest = join(dir, `boxyrun-backup-${ts}.db`);
	try {
		copyFileSync(DB_PATH, dest);
		console.log(`[backup] saved ${dest}`);
		// Prune old backups
		const backups = readdirSync(dir)
			.filter(f => f.startsWith('boxyrun-backup-') && f.endsWith('.db'))
			.sort()
			.reverse();
		for (const old of backups.slice(MAX_BACKUPS)) {
			try { unlinkSync(join(dir, old)); console.log(`[backup] pruned ${old}`); } catch {}
		}
	} catch (err) {
		console.error('[backup] failed:', err);
	}
}

async function boot() {
	await ensureTournamentSchema();
	// Initial backup on boot, then every 6 hours
	backupDb();
	setInterval(backupDb, BACKUP_INTERVAL_MS);
	httpServer.listen(PORT, '::', () => {
		console.log(`[server] listening on http://0.0.0.0:${PORT}`);
		console.log(`[server] static files: ${STATIC_DIR}`);
		// Spawn bots after server is listening
		import('./bots').then(({ spawnBots }) => spawnBots(PORT)).catch(err => {
			console.error('[bots] failed to spawn:', err);
		});
		// Boot the arena watcher — credits player_transactions whenever a
		// real on-chain transfer arrives at the arena wallet. Non-fatal if
		// it fails (server keeps running; deposits just won't auto-credit).
		if (process.env.ARENA_WALLET_FILE) {
			import('./arena-watcher').then(({ startArenaWatcher }) =>
				startArenaWatcher(),
			).catch(err => {
				console.error('[arena-watcher] failed to boot:', err);
			});
		} else {
			console.log('[arena-watcher] ARENA_WALLET_FILE not set — watcher disabled');
		}
	});
}

boot().catch((err) => {
	console.error('[server] boot failed:', err);
	process.exit(1);
});

process.on('SIGINT', () => {
	console.log('\n[server] shutting down');
	for (const ws of allSockets) ws.close(1001);
	wss.close(() => httpServer.close(() => process.exit(0)));
});
