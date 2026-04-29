/**
 * Bot players for tournament testing — simulates real play.
 *
 * Each bot:
 *   1. Connects WebSocket, registers nametag
 *   2. Registers for tournament via REST
 *   3. On match-ready handshake, sends match-ready (once per game)
 *   4. On match-start / series-next:
 *      - Boots a local sim with the server's seed
 *      - Runs tick() in real time (60Hz), deciding actions by skill profile
 *      - Streams input events to the server with tick numbers
 *      - When local sim hits gameOver → sends match-done
 *   5. Reconnects WebSocket automatically on disconnect
 *
 * Skill profile (per bot index, see SKILL_TIERS below) controls:
 *   reactionZ — how far ahead (in world units) the bot notices trees
 *   errorRate — chance of skipping a needed reaction (freeze)
 *   switchPreference — prefer lane-switching over jumping (safer play)
 *
 * Usage:
 *   npx tsx scripts/bot-players.ts <tournament-id> <num-bots> [host]
 */

import WebSocket from 'ws';
import { makeInitialState } from '../src/sim/init';
import { tick as simTick } from '../src/sim/tick';
import { DEFAULT_CONFIG, TICK_HZ, TICK_SECONDS, type CharacterAction, type GameState } from '../src/sim/state';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage, type DistributiveOmit } from '../tournament/protocol/messages';

const tournamentId = process.argv[2];
const numBots = parseInt(process.argv[3] || '4', 10);
const host = process.argv[4] || 'boxy-run.fly.dev';

if (!tournamentId) {
	console.error('Usage: npx tsx scripts/bot-players.ts <tournament-id> <num-bots> [host]');
	process.exit(1);
}

const isLocal = host.startsWith('localhost') || host.startsWith('127.');
const httpProto = isLocal ? 'http:' : 'https:';
const wsProto = isLocal ? 'ws:' : 'wss:';
const HTTP_BASE = `${httpProto}//${host}`;
const WS_BASE = `${wsProto}//${host}`;

// ── Skill tiers ──────────────────────────────────────────────────
interface SkillTier {
	label: string;
	reactionZ: number;      // distance to imminent tree before evading (larger = better)
	errorRate: number;      // per-reaction chance of freezing (fail to act)
	switchPreference: number; // 0..1 chance to prefer lane-switch over jump
}

// Tiers calibrated to: beginner ~13k, medium ~43k, expert ~59k avg score.
// 'smart' bots count trees per lane and pick the safest; 'simple' just jump.
const SKILL_TIERS: SkillTier[] = [
	{ label: 'expert',   reactionZ: 4000, errorRate: 0.01, switchPreference: 1 },  // ~59k, smart
	{ label: 'medium',   reactionZ: 3200, errorRate: 0.04, switchPreference: 1 },  // ~43k, smart
	{ label: 'beginner', reactionZ: 900,  errorRate: 0.30, switchPreference: 0 },  // ~13k, simple (jump only)
];

function skillForIdx(idx: number): SkillTier {
	// Round-robin: 0→expert, 1→skilled, 2→casual, 3→beginner, 4→expert, ...
	return SKILL_TIERS[idx % SKILL_TIERS.length];
}

// ── Action decision ──────────────────────────────────────────────
const LANE_X = [-800, 0, 800];

function laneOfX(x: number): number {
	// Return -1, 0, 1 for nearest lane
	if (x < -400) return -1;
	if (x > 400) return 1;
	return 0;
}

function pickAction(state: GameState, skill: SkillTier): CharacterAction | null {
	const char = state.character;
	if (char.isJumping || char.isSwitchingLeft || char.isSwitchingRight) return null;
	if (char.queuedActions.length > 0) return null;

	const myLane = char.currentLane;
	const charZ = char.z;

	// Count trees ahead in my lane
	const myCount = state.trees.filter(t => {
		if (laneOfX(t.x) !== myLane) return false;
		const d = charZ - t.z;
		return d > 0 && d < skill.reactionZ;
	}).length;

	if (myCount === 0) return null; // no threat
	if (Math.random() < skill.errorRate) return null; // error (freeze)

	// Simple mode (switchPreference === 0): just jump
	if (skill.switchPreference === 0) return 'up';

	// Smart mode: count trees in all lanes, pick safest
	function treesInLane(lane: number, range: number): number {
		return state.trees.filter(t => {
			if (laneOfX(t.x) !== lane) return false;
			const d = charZ - t.z;
			return d > -400 && d < range;
		}).length;
	}

	const lanes = ([-1, 0, 1] as const).map(l => ({
		lane: l,
		count: treesInLane(l, skill.reactionZ * 1.5),
	})).sort((a, b) => a.count - b.count);

	const best = lanes[0];
	if (best.lane === myLane) return 'up'; // current lane is safest
	if (best.count < myCount) {
		return best.lane < myLane ? 'left' : 'right';
	}
	return 'up'; // all lanes bad, jump
}

// ── Crypto-style names ───────────────────────────────────────────
const CRYPTO_NAMES = [
	'satoshi_og', 'vitalik_fan', 'degen_ape', 'gm_wagmi',
	'ser_pumps', 'rug_survivor', 'diamond_hands', 'moon_boy',
	'anon_whale', 'chad_minter', 'ser_dumpoor', 'ngmi_larry',
	'wen_lambo', 'touch_grass', 'fren_zone', 'copium_max',
	'ser_yield', 'bag_holder', 'alpha_leak', 'floor_sweeper',
	'gwei_lord', 'rekt_andy', 'ape_strong', 'fomo_king',
	'hodl_queen', 'nft_flipper', 'defi_chad', 'gas_war_vet',
	'mint_sniper', 'airdrop_hunter', 'bridge_maxi', 'zk_believer',
];

/**
 * Mint a server-side session for `nametag` via the auth handshake. The
 * server requires AUTH_BYPASS=1 (which the test harness sets) for this
 * to work — verifyChallenge then accepts any signature.
 *
 * In production the bots would need real wallets; this script is a
 * load-test/dev-fixture tool, not a prod-facing client.
 */
async function mintSessionFor(nametag: string): Promise<string | null> {
	try {
		const ch = await fetch(`${HTTP_BASE}/api/auth/challenge`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ nametag }),
		}).then(r => r.json()) as any;
		if (!ch.challengeId) return null;
		const v = await fetch(`${HTTP_BASE}/api/auth/verify`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ challengeId: ch.challengeId, signature: 'BOT' }),
		}).then(r => r.json()) as any;
		return v.sessionId || null;
	} catch {
		return null;
	}
}

// ── Bot logic ────────────────────────────────────────────────────
async function runBot(idx: number): Promise<void> {
	const nametag = CRYPTO_NAMES[idx] || `anon_${idx}`;
	const skill = skillForIdx(idx);
	const log = (msg: string) => console.log(`[${nametag} ${skill.label}] ${msg}`);

	// Auth handshake — required before anything mutating works.
	const sessionId = await mintSessionFor(nametag);
	if (!sessionId) {
		log('auth handshake failed — aborting (need AUTH_BYPASS=1 server)');
		return;
	}

	// Register for tournament via REST
	try {
		const regRes = await fetch(`${HTTP_BASE}/api/tournaments/${tournamentId}/register`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${sessionId}`,
			},
			body: JSON.stringify({ nametag }),
		});
		const regData: any = await regRes.json();
		if (regData.error) log(`register: ${regData.error} (continuing)`);
		else log(`registered (${regData.playerCount} players)`);
	} catch (err) {
		log(`register failed: ${err}`);
	}

	let ws: WebSocket;
	let intentionalClose = false;

	// Per-match state
	let currentMatchId: string | null = null;
	let currentGameNum = 1;
	let simLoop: NodeJS.Timeout | null = null;
	let simState: GameState | null = null;
	const readied = new Set<string>();   // (matchId#game) dedupe for match-ready
	const started = new Set<string>();   // (matchId#game) dedupe for sim-start

	/**
	 * Send a typed ClientMessage. Automatically injects the `v` field so
	 * callers don't have to remember, but the shape is still enforced.
	 */
	function safeSend(payload: DistributiveOmit<ClientMessage, 'v'>): void {
		if (ws && ws.readyState === WebSocket.OPEN) {
			try {
				const wire = { ...payload, v: PROTOCOL_VERSION };
				ws.send(JSON.stringify(wire));
			} catch (err) { log(`send err: ${err}`); }
		}
	}

	function stopSim(): void {
		if (simLoop) { clearInterval(simLoop); simLoop = null; }
		simState = null;
	}

	function startGame(matchId: string, seedHex: string, gameNum: number): void {
		const key = `${matchId}#${gameNum}`;
		if (started.has(key)) return;
		started.add(key);
		stopSim(); // drop any previous sim

		const seedNum = parseInt(seedHex, 16) >>> 0;
		simState = makeInitialState(seedNum, DEFAULT_CONFIG);
		const startTs = Date.now();
		log(`sim-start game ${gameNum} seed=0x${seedHex} react=${skill.reactionZ} err=${skill.errorRate}`);

		simLoop = setInterval(() => {
			if (!simState) return;
			// Decision before tick
			const action = pickAction(simState, skill);
			if (action) {
				simState.character.queuedActions.push(action);
				safeSend({
					type: 'input',
					matchId,
					tick: simState.tick,
					payload: Buffer.from(action).toString('base64'),
				});
			}
			simTick(simState, DEFAULT_CONFIG);

			if (simState.gameOver) {
				const finalTick = simState.tick;
				const finalScore = simState.score;
				stopSim();
				const wallTime = ((Date.now() - startTs) / 1000).toFixed(1);
				log(`sim-end game ${gameNum}: crashed tick=${finalTick} score=${finalScore} (wall ${wallTime}s)`);
				safeSend({ type: 'match-done', matchId });
			}
		}, Math.round(1000 / TICK_HZ)); // ~16.67ms per tick
	}

	let lastHeartbeat = Date.now();
	let heartbeatTimer: NodeJS.Timeout | null = null;

	function connect(): void {
		ws = new WebSocket(WS_BASE);
		lastHeartbeat = Date.now();

		ws.on('open', () => {
			lastHeartbeat = Date.now();
			// Use the session minted up-front for REST registration —
			// reusable across reconnects until it expires (24h).
			safeSend({ type: 'register', identity: { nametag }, sessionId });
		});

		// Server pings every 10s. If we miss two pings (≥25s silence) the
		// connection is a zombie — terminate and reconnect.
		ws.on('ping', () => { lastHeartbeat = Date.now(); });
		ws.on('pong', () => { lastHeartbeat = Date.now(); });

		ws.on('message', (raw) => {
			lastHeartbeat = Date.now();
			let msg: ServerMessage;
			try { msg = JSON.parse(raw.toString()) as ServerMessage; } catch { return; }

			switch (msg.type) {
				case 'registered':
					if (msg.protocolVersion !== PROTOCOL_VERSION) {
						log(`WARN protocol mismatch: server=${msg.protocolVersion} bot=${PROTOCOL_VERSION}`);
					}
					break;

				case 'ready-expired': {
					// Server's TTL fired (30s w/o both readied). Clear BOTH
					// dedup sets so the bot will re-ready AND replay the sim
					// when the rematched match-start arrives. Without
					// clearing `started`, a fresh match-start (e.g. after a
					// server restart that wiped in-memory state) is silently
					// dropped because the bot thinks it already played that
					// game.
					const rk = `${msg.matchId}#${currentGameNum}`;
					const cleared = readied.delete(rk) || started.delete(rk);
					if (cleared) {
						log(`ready-expired ${msg.matchId} — cleared dedup, will re-ready+replay`);
					}
					stopSim();
					break;
				}

				case 'match-start': {
					currentMatchId = msg.matchId;
					// Prefer server-supplied gameNumber (added so game 2+ of a
					// series doesn't get mistakenly rescheduled as game 1).
					const gameNum = msg.gameNumber || 1;
					currentGameNum = gameNum;
					log(`match-start vs ${msg.opponent} seed=0x${msg.seed} game=${gameNum}`);
					const delay = Math.max(0, (msg.startsAt || Date.now()) - Date.now());
					setTimeout(() => startGame(msg.matchId, msg.seed, gameNum), delay + 100);
					break;
				}

				case 'match-status': {
					// Ack ready ONCE per (matchId, gameNum) — server echoes status on every ready,
					// and naive re-ack is an infinite loop.
					const rk = `${msg.matchId}#${currentGameNum}`;
					if (readied.has(rk)) break;
					readied.add(rk);
					safeSend({ type: 'match-ready', matchId: msg.matchId });
					break;
				}

				case 'match-end':
					log(`match-end: winner=${msg.winner} ${msg.scoreA}-${msg.scoreB}`);
					stopSim();
					currentMatchId = null;
					break;

				case 'game-result':
					log(`game ${msg.gameNumber} result: winner=${msg.winner} (${msg.scoreA}-${msg.scoreB}) series ${msg.winsA}-${msg.winsB}`);
					stopSim();
					break;

				case 'series-next': {
					currentMatchId = msg.matchId;
					const gameNum = msg.gameNumber || (currentGameNum + 1);
					currentGameNum = gameNum;
					log(`series game ${gameNum}/${msg.bestOf} seed=0x${msg.seed}`);
					// The state machine resets to awaiting_ready per game, so we
					// must send match-ready before game 2+ will start. The real
					// browser client does the same (sendReady() in beginGame).
					safeSend({ type: 'match-ready', matchId: msg.matchId });
					const delay = Math.max(0, (msg.startsAt || Date.now()) - Date.now());
					// Capture gameNum in the closure — match-start may race in
					// and reset currentGameNum to 1, which would make us re-run
					// game 1 (dedup rejects, tournament stalls).
					setTimeout(() => startGame(msg.matchId, msg.seed, gameNum), delay + 100);
					break;
				}

				case 'challenge-received':
					// Auto-accept challenges — lets humans practice vs bots
					log(`challenge from ${msg.from} (Bo${msg.bestOf}) — auto-accepting`);
					fetch(`${HTTP_BASE}/api/challenges/${msg.challengeId}/accept`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ by: nametag }),
					}).catch(err => log(`accept failed: ${err}`));
					break;

				case 'challenge-start': {
					// Redirect equivalent for bots — start playing the challenge match
					currentMatchId = msg.matchId;
					const gameNum = msg.gameNumber || 1;
					currentGameNum = gameNum;
					readied.clear();
					started.clear();
					log(`challenge-start vs ${msg.opponent} seed=0x${msg.seed} game=${gameNum}`);
					safeSend({ type: 'match-ready', matchId: msg.matchId });
					const delay = Math.max(0, (msg.startsAt || Date.now()) - Date.now());
					setTimeout(() => startGame(msg.matchId, msg.seed, gameNum), delay + 100);
					break;
				}

				case 'bracket-update':
					break;

				case 'error':
					log(`error: ${msg.code} ${msg.message}`);
					break;
			}
		});

		ws.on('close', () => {
			if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
			if (!intentionalClose) setTimeout(connect, 2000);
		});

		ws.on('error', (err) => {
			log(`ws error: ${err.message}`);
		});

		// Watchdog: terminate zombie connections (no ping/msg from server in 25s)
		heartbeatTimer = setInterval(() => {
			if (!ws) return;
			if (Date.now() - lastHeartbeat > 25_000) {
				log(`ws idle >25s (state=${ws.readyState}) — forcing reconnect`);
				try { ws.terminate(); } catch {}
			}
		}, 5_000);
	}

	connect();

	// Slow fallback poll: ready up if a match is waiting and we missed the push.
	setInterval(async () => {
		try {
			const r = await fetch(`${HTTP_BASE}/api/tournaments/${tournamentId}/bracket`);
			const d: any = await r.json();
			const match = (d.matches || []).find((m: any) =>
				(m.playerA === nametag || m.playerB === nametag) && m.status === 'ready_wait',
			);
			if (match) {
				const rk = `${match.id}#${currentGameNum}`;
				if (!readied.has(rk)) {
					readied.add(rk);
					safeSend({ type: 'match-ready', matchId: match.id });
				}
			}
		} catch {}
	}, 10_000);
}

// ── Spawn bots ──────────────────────────────────────────────────
async function main() {
	console.log(`Spawning ${numBots} bots for tournament ${tournamentId} on ${host}`);
	console.log(`Skill distribution (round-robin): ${SKILL_TIERS.map(t => t.label).join(', ')}`);
	const bots: Promise<void>[] = [];
	for (let i = 0; i < numBots; i++) {
		bots.push(runBot(i));
		await new Promise((r) => setTimeout(r, 100)); // stagger
	}
	console.log('All bots spawned. Press Ctrl+C to stop.');
	await Promise.all(bots);
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
