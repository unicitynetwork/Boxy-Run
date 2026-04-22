/**
 * Server-side bot players. Run inside the server process — no external
 * WS connections needed. Bots register on the internal WS, auto-accept
 * challenges, and play matches using the same sim as real players.
 *
 * Spawned on server boot. Always online, always available for challenges.
 */

import WebSocket from 'ws';
import { makeInitialState } from '../../src/sim/init';
import { tick as simTick } from '../../src/sim/tick';
import { DEFAULT_CONFIG, TICK_HZ, type CharacterAction, type GameState } from '../../src/sim/state';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage, type DistributiveOmit } from '../protocol/messages';

// ── Skill tiers ──────────────────────────────────────────────────

interface SkillTier {
	label: string;
	reactionZ: number;
	errorRate: number;
	switchPreference: number;
}

const SKILL_TIERS: SkillTier[] = [
	{ label: 'expert',   reactionZ: 4000, errorRate: 0.01, switchPreference: 1 },
	{ label: 'medium',   reactionZ: 3200, errorRate: 0.04, switchPreference: 1 },
	{ label: 'beginner', reactionZ: 900,  errorRate: 0.30, switchPreference: 0 },
];

// ── Bot names ────────────────────────────────────────────────────

const BOT_NAMES = [
	'satoshi_og', 'vitalik_fan', 'degen_ape', 'gm_wagmi',
	'ser_pumps', 'rug_survivor',
];

// ── Action decision ──────────────────────────────────────────────

function laneOfX(x: number): number {
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

	const myCount = state.trees.filter(t => {
		if (laneOfX(t.x) !== myLane) return false;
		const d = charZ - t.z;
		return d > 0 && d < skill.reactionZ;
	}).length;

	if (myCount === 0) return null;
	if (Math.random() < skill.errorRate) return null;

	if (skill.switchPreference === 0) return 'up';

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
	if (best.lane === myLane) return 'up';
	if (best.count < myCount) {
		return best.lane < myLane ? 'left' : 'right';
	}
	return 'up';
}

// ── Single bot ───────────────────────────────────────────────────

function runBot(port: number, idx: number): void {
	const nametag = BOT_NAMES[idx] || `bot_${idx}`;
	const skill = SKILL_TIERS[idx % SKILL_TIERS.length];
	const log = (msg: string) => console.log(`[bot:${nametag}] ${msg}`);

	let ws: WebSocket;
	let currentMatchId: string | null = null;
	let currentGameNum = 1;
	let simLoop: NodeJS.Timeout | null = null;
	let simState: GameState | null = null;
	const readied = new Set<string>();
	const started = new Set<string>();

	let matchStartedAt = 0;
	const MATCH_TIMEOUT_MS = 120_000; // 2 min safety — clear stuck matches

	/** True if the bot is actively in a game. Auto-clears after 2 min. */
	function isInMatch(): boolean {
		if (!currentMatchId) return false;
		if (Date.now() - matchStartedAt > MATCH_TIMEOUT_MS) {
			log(`match ${currentMatchId} timed out after 2min — clearing`);
			stopSim();
			currentMatchId = null;
			readied.clear();
			started.clear();
			return false;
		}
		return true;
	}

	function safeSend(payload: DistributiveOmit<ClientMessage, 'v'>): void {
		if (ws && ws.readyState === WebSocket.OPEN) {
			try {
				ws.send(JSON.stringify({ ...payload, v: PROTOCOL_VERSION }));
			} catch {}
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
		stopSim();

		const seedNum = parseInt(seedHex, 16) >>> 0;
		simState = makeInitialState(seedNum, DEFAULT_CONFIG);
		log(`game ${gameNum} seed=0x${seedHex} skill=${skill.label}`);

		simLoop = setInterval(() => {
			if (!simState) return;
			const action = pickAction(simState, skill);
			if (action) {
				simState.character.queuedActions.push(action);
				safeSend({
					type: 'input', matchId,
					tick: simState.tick,
					payload: Buffer.from(action).toString('base64'),
				});
			}
			simTick(simState, DEFAULT_CONFIG);

			if (simState.gameOver) {
				log(`game ${gameNum} died: score=${simState.score}`);
				stopSim();
				safeSend({ type: 'match-done', matchId });
			}
		}, Math.round(1000 / TICK_HZ));
	}

	// Poll for pending matches — covers the case where the bot missed
	// the initial match-status WS message (reconnect, server restart).
	async function checkForPendingMatch(port: number, name: string): Promise<void> {
		if (isInMatch()) return;
		try {
			const r = await fetch(`http://127.0.0.1:${port}/api/tournaments`);
			if (!r.ok) return;
			const { tournaments } = await r.json() as any;
			for (const t of tournaments) {
				if (t.status !== 'active') continue;
				const br = await fetch(`http://127.0.0.1:${port}/api/tournaments/${encodeURIComponent(t.id)}/bracket`);
				if (!br.ok) continue;
				const { matches } = await br.json() as any;
				for (const m of matches) {
					if (m.status !== 'ready_wait' && m.status !== 'active') continue;
					if (m.playerA !== name && m.playerB !== name) continue;
					const rk = `${m.id}#1`;
					if (readied.has(rk)) continue;
					readied.add(rk);
					log(`found pending match ${m.id} — readying`);
					safeSend({ type: 'match-ready', matchId: m.id });
					return;
				}
			}
		} catch {}
	}

	// Periodic check every 10s for pending matches
	setInterval(() => checkForPendingMatch(port, nametag), 10_000);

	function connect(): void {
		ws = new WebSocket(`ws://127.0.0.1:${port}`);

		ws.on('open', () => {
			safeSend({ type: 'register', identity: { nametag } });
		});

		ws.on('ping', () => {});
		ws.on('pong', () => {});

		ws.on('message', (raw) => {
			let msg: ServerMessage;
			try { msg = JSON.parse(raw.toString()) as ServerMessage; } catch { return; }

			switch (msg.type) {
				case 'registered':
					log('online');
					break;

				case 'ready-expired': {
					const rk = `${msg.matchId}#${currentGameNum}`;
					readied.delete(rk);
					started.delete(rk);
					stopSim();
					currentMatchId = null;
					break;
				}

				case 'match-start': {
					currentMatchId = msg.matchId; matchStartedAt = Date.now();
					const gameNum = msg.gameNumber || 1;
					currentGameNum = gameNum;
					const delay = Math.max(0, (msg.startsAt || Date.now()) - Date.now());
					setTimeout(() => startGame(msg.matchId, msg.seed, gameNum), delay + 100);
					break;
				}

				case 'match-status': {
					const rk = `${msg.matchId}#${currentGameNum}`;
					if (readied.has(rk)) break;
					readied.add(rk);
					safeSend({ type: 'match-ready', matchId: msg.matchId });
					break;
				}

				case 'match-end':
					log(`match-end: winner=${msg.winner} ${msg.scoreA}-${msg.scoreB}`);
					stopSim();
					// Auto-request rematch for challenge matches (not tournaments)
					if (currentMatchId?.startsWith('challenge-')) {
						safeSend({ type: 'rematch', matchId: currentMatchId });
						log('rematch requested');
					}
					currentMatchId = null;
					break;

				case 'game-result':
					stopSim();
					break;

				case 'series-next': {
					currentMatchId = msg.matchId; matchStartedAt = Date.now();
					const gameNum = msg.gameNumber || (currentGameNum + 1);
					currentGameNum = gameNum;
					safeSend({ type: 'match-ready', matchId: msg.matchId });
					const delay = Math.max(0, (msg.startsAt || Date.now()) - Date.now());
					setTimeout(() => startGame(msg.matchId, msg.seed, gameNum), delay + 100);
					break;
				}

				case 'challenge-received':
					if (isInMatch()) {
						log(`challenge from ${msg.from} — in match, declining`);
						fetch(`http://127.0.0.1:${port}/api/challenges/${msg.challengeId}/decline`, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ by: nametag }),
						}).catch(() => {});
						break;
					}
					if (msg.wager > 0) {
						log(`challenge from ${msg.from} — wager ${msg.wager}, declining`);
						fetch(`http://127.0.0.1:${port}/api/challenges/${msg.challengeId}/decline`, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ by: nametag }),
						}).catch(() => {});
						break;
					}
					log(`challenge from ${msg.from} — accepting`);
					fetch(`http://127.0.0.1:${port}/api/challenges/${msg.challengeId}/accept`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ by: nametag }),
					}).catch(() => {});
					break;

				case 'challenge-start': {
					currentMatchId = msg.matchId; matchStartedAt = Date.now();
					const gameNum = msg.gameNumber || 1;
					currentGameNum = gameNum;
					readied.clear();
					started.clear();
					safeSend({ type: 'match-ready', matchId: msg.matchId });
					const delay = Math.max(0, (msg.startsAt || Date.now()) - Date.now());
					setTimeout(() => startGame(msg.matchId, msg.seed, gameNum), delay + 100);
					break;
				}

				case 'bracket-update':
					// Check if we have a pending match that needs readying
					checkForPendingMatch(port, nametag);
					break;
				case 'error':
					break;
			}
		});

		ws.on('close', () => {
			// Reconnect after 3s
			setTimeout(connect, 3000);
		});

		ws.on('error', () => {
			// Will trigger close → reconnect
		});
	}

	connect();
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Spawn all bots. Call once after the HTTP server is listening.
 * Bots connect to localhost via WS and stay online permanently.
 */
export function spawnBots(port: number): void {
	const count = BOT_NAMES.length;
	console.log(`[bots] spawning ${count} bots on localhost:${port}`);
	// Stagger connections to avoid thundering herd
	for (let i = 0; i < count; i++) {
		setTimeout(() => runBot(port, i), i * 500);
	}
}

/** Get the list of bot nametags (for UI display). */
export function getBotNames(): string[] {
	return [...BOT_NAMES];
}
