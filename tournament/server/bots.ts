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

// Tuned via local simulation to hit target score ranges.
// reactD = distance at which bot dodges (sweet spot ~5000).
// errorRate = chance of ignoring a tree (adds variance + human-like mistakes).
// canSwitch = lane switching (much more effective than jumping).
// useFlame = flamethrower usage (clears tree walls).
const SKILL_TIERS: SkillTier[] = [
	{ label: 'beginner', reactionZ: 4000, errorRate: 0.10, switchPreference: 0 },  // ~20K avg, jump only
	{ label: 'medium',   reactionZ: 5000, errorRate: 0.15, switchPreference: 1 },  // ~40K avg, switch
	{ label: 'expert',   reactionZ: 5000, errorRate: 0.03, switchPreference: 1 },  // ~60K avg, switch+flame
	{ label: 'god',      reactionZ: 4800, errorRate: 0.00, switchPreference: 1 },  // ~70K avg, switch+flame
];

// ── Bot names ────────────────────────────────────────────────────
// Each bot is assigned a skill tier by index (mod SKILL_TIERS.length).

const BOT_NAMES = [
	'noob_cube',       // beginner
	'ser_pumps',       // medium
	'degen_ape',       // expert
	'satoshi_og',      // god
	'gm_wagmi',        // beginner
	'vitalik_fan',     // medium
	'rug_survivor',    // expert
	'boxy_supreme',    // god
];

// ── Action decision ──────────────────────────────────────────────

function laneOfX(x: number): number {
	if (x < -400) return -1;
	if (x > 400) return 1;
	return 0;
}

/**
 * Bot decision per tick. The key insight from simulation tuning:
 *
 *   1. ONE action at a time. Never over-queue. Wait until idle to decide.
 *   2. Prefer lane switching over jumping — switching moves you OUT of
 *      danger entirely, jumping risks landing into the next tree.
 *   3. React at ~5000 units (sweet spot). Too early = jumps waste time.
 *      Too late = no time to switch lanes.
 *   4. Use flamethrower whenever available (clears impossible walls).
 */
function pickAction(state: GameState, skill: SkillTier): CharacterAction | null {
	const char = state.character;
	const charZ = char.z;
	const reactD = skill.reactionZ;
	const useFlame = skill.reactionZ >= 5000; // expert + god

	// Fire flamethrower when any tree is ahead and we have charges
	if (useFlame && state.flamethrowerCharges > 0) {
		for (const t of state.trees) {
			const d = charZ - t.z;
			if (d > 0 && d < 5000) return 'fire';
		}
	}

	// ONE non-fire action at a time. Wait until fully idle.
	const nonFire = char.queuedActions.filter(a => a !== 'fire').length;
	if (nonFire >= 1) return null;
	if (char.isJumping || char.isSwitchingLeft || char.isSwitchingRight) return null;

	const effLane = char.currentLane;

	// Distance to first tree in each lane
	function firstTreeDist(lane: number): number {
		let best = Infinity;
		for (const t of state.trees) {
			if (laneOfX(t.x) !== lane) continue;
			const d = charZ - t.z;
			if (d > 0 && d < best) best = d;
		}
		return best;
	}

	const myD = firstTreeDist(effLane);

	// Nothing ahead within scan range — look for powerups to collect
	if (myD > reactD * 2 || myD === Infinity) {
		for (const p of state.powerups) {
			if (p.collected) continue;
			const d = charZ - p.z;
			const pLane = laneOfX(p.x);
			if (d > 0 && d < 6000 && pLane !== effLane && Math.abs(pLane - effLane) === 1) {
				if (firstTreeDist(pLane) > 3000) {
					return pLane < effLane ? 'left' : 'right';
				}
			}
		}
		return null;
	}

	// Error: randomly ignore the threat (makes beginner/medium worse)
	if (Math.random() < skill.errorRate) return null;

	// Beginner: jump only
	if (skill.switchPreference === 0) {
		return myD < reactD ? 'up' : null;
	}

	// Adjacent lanes sorted by first tree distance (safest first)
	const adjLanes = ([-1, 0, 1] as const)
		.filter(l => l !== effLane && Math.abs(l - effLane) === 1)
		.map(l => ({ lane: l, d: firstTreeDist(l) }))
		.sort((a, b) => b.d - a.d);

	if (myD < reactD) {
		// Must dodge — prefer switching to a safe lane
		if (adjLanes.length > 0 && adjLanes[0].d > reactD) {
			return adjLanes[0].lane < effLane ? 'left' : 'right';
		}
		return 'up';
	}

	// Preemptive: move to a much clearer lane
	if (adjLanes.length > 0 && adjLanes[0].d > myD * 1.5) {
		return adjLanes[0].lane < effLane ? 'left' : 'right';
	}

	return null;
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
	const MATCH_TIMEOUT_MS = 120_000;

	function setMatchId(id: string | null) {
		currentMatchId = id;
		if (id) matchStartedAt = Date.now();
		botMatchState.set(nametag, id);
	}

	/** True if the bot is actively in a game. Auto-clears after 2 min. */
	function isInMatch(): boolean {
		if (!currentMatchId) return false;
		if (Date.now() - matchStartedAt > MATCH_TIMEOUT_MS) {
			log(`match ${currentMatchId} timed out after 2min — clearing`);
			stopSim();
			setMatchId(null);
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
					setMatchId(null);
					break;
				}

				case 'match-start': {
					setMatchId(msg.matchId);
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
					setMatchId(null);
					break;

				case 'game-result':
					stopSim();
					break;

				case 'series-next': {
					setMatchId(msg.matchId);
					const gameNum = msg.gameNumber || (currentGameNum + 1);
					currentGameNum = gameNum;
					safeSend({ type: 'match-ready', matchId: msg.matchId });
					const delay = Math.max(0, (msg.startsAt || Date.now()) - Date.now());
					setTimeout(() => startGame(msg.matchId, msg.seed, gameNum), delay + 100);
					break;
				}

				case 'challenge-received': {
					const headers = { 'Content-Type': 'application/json' };
					if (isInMatch()) {
						log(`challenge from ${msg.from} — in match, declining`);
						fetch(`http://127.0.0.1:${port}/api/challenges/${msg.challengeId}/decline`, {
							method: 'POST', headers, body: JSON.stringify({ by: nametag }),
						}).catch(() => {});
						break;
					}
					if (msg.wager > 0) {
						log(`challenge from ${msg.from} — wager ${msg.wager}, declining`);
						fetch(`http://127.0.0.1:${port}/api/challenges/${msg.challengeId}/decline`, {
							method: 'POST', headers, body: JSON.stringify({ by: nametag }),
						}).catch(() => {});
						break;
					}
					log(`challenge from ${msg.from} — accepting`);
					fetch(`http://127.0.0.1:${port}/api/challenges/${msg.challengeId}/accept`, {
						method: 'POST', headers, body: JSON.stringify({ by: nametag }),
					}).catch(() => {});
					break;
				}

				case 'challenge-start': {
					setMatchId(msg.matchId);
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

// ── Shared state for API queries ─────────────────────────────────
const botMatchState = new Map<string, string | null>(); // nametag → currentMatchId

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

/** Get bot info with skill levels. */
export function getBotInfo(): { name: string; skill: string }[] {
	return BOT_NAMES.map((name, idx) => ({
		name,
		skill: SKILL_TIERS[idx % SKILL_TIERS.length].label,
	}));
}

/** Get bots currently in a match (for filtering the online list). */
export function getBusyBots(): string[] {
	return BOT_NAMES.filter(name => !!botMatchState.get(name));
}
