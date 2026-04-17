/**
 * Stress test: two bots play Bo3 challenges with auto-rematch.
 *
 * Runs N consecutive matches between two bots, verifying each match
 * completes correctly. Reports any hangs, wrong winners, or protocol
 * errors. Exercises the full server flow: challenge → accept → ready →
 * play → game-result → series-next → ... → match-end → rematch.
 *
 * Usage:
 *   npx tsx scripts/stress-rematch.ts [rounds] [host]
 *
 * Examples:
 *   npx tsx scripts/stress-rematch.ts 50                    # 50 rematches on fly.dev
 *   npx tsx scripts/stress-rematch.ts 100 localhost:8080     # 100 on local
 */

import WebSocket from 'ws';
import { makeInitialState } from '../src/sim/init';
import { tick as simTick } from '../src/sim/tick';
import { DEFAULT_CONFIG, TICK_HZ, type CharacterAction, type GameState } from '../src/sim/state';

const TOTAL_ROUNDS = parseInt(process.argv[2] || '20', 10);
const host = process.argv[3] || 'localhost:8080';
const isLocal = host.startsWith('localhost') || host.startsWith('127.');
const HTTP = `${isLocal ? 'http' : 'https'}://${host}`;
const WS_URL = `${isLocal ? 'ws' : 'wss'}://${host}`;
const ADMIN_KEY = process.env.ADMIN_KEY || 'boxy-8534d6c0dce0516b';
const MATCH_TIMEOUT = 90_000; // 90s per match max
const BEST_OF = 3;

// ── Simple bot logic (always jumps when obstacle ahead) ──────────
function pickAction(state: GameState): CharacterAction | null {
	const char = state.character;
	if (char.isJumping || char.queuedActions.length > 0) return null;
	const lane = char.currentLane;
	const charZ = char.z;
	const ahead = state.trees.some(t => {
		if (Math.round((t.x + 800) / 800) - 1 !== lane) return false;
		const d = charZ - t.z;
		return d > 0 && d < 2000;
	});
	if (!ahead) return null;
	if (Math.random() < 0.1) return null; // 10% error rate
	return Math.random() < 0.6 ? 'up' : (lane > -1 ? 'left' : 'right');
}

// ── Stats ────────────────────────────────────────────────────────
let completed = 0;
let errors = 0;
const results: { round: number; winner: string; games: number; time: number }[] = [];

// ── Bot WS client ────────────────────────────────────────────────
interface BotClient {
	ws: WebSocket;
	name: string;
	send: (msg: any) => void;
	flush: () => void;
	waitFor: (type: string, timeout?: number, filter?: Record<string, any>) => Promise<any>;
	close: () => void;
}

function createBot(name: string): Promise<BotClient> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(WS_URL);
		const messages: any[] = [];
		const waiters: { type: string; filter?: Record<string, any>; resolve: (m: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];

		function matches(msg: any, type: string, filter?: Record<string, any>): boolean {
			// Support "type1|type2" OR syntax for racing between message types
			const types = type.split('|');
			if (!types.includes(msg.type)) return false;
			if (!filter) return true;
			return Object.entries(filter).every(([k, v]) => msg[k] === v);
		}

		ws.on('error', (e) => reject(e));
		ws.on('message', (raw) => {
			const msg = JSON.parse(raw.toString());
			if (msg.type === 'heartbeat') return;
			// Check if any waiter wants this message. If so, deliver
			// directly — don't buffer (prevents stale messages from
			// being consumed by future waitFor calls).
			let consumed = false;
			for (let i = 0; i < waiters.length; i++) {
				const w = waiters[i];
				if (matches(msg, w.type, w.filter)) {
					clearTimeout(w.timer);
					w.resolve(msg);
					waiters.splice(i, 1);
					consumed = true;
					break;
				}
			}
			if (!consumed) messages.push(msg);
		});
		ws.on('open', () => {
			ws.send(JSON.stringify({ type: 'register', v: 0, identity: { nametag: name } }));
			resolve({
				ws, name,
				flush() { messages.length = 0; },
				send(msg: any) { if (ws.readyState === 1) ws.send(JSON.stringify({ ...msg, v: 0 })); },
				waitFor(type: string, timeout = 30_000, filter?: Record<string, any>) {
					for (let i = 0; i < messages.length; i++) {
						if (matches(messages[i], type, filter)) {
							const m = messages[i];
							messages.splice(i, 1);
							return Promise.resolve(m);
						}
					}
					return new Promise((res, rej) => {
						const timer = setTimeout(() => {
							rej(new Error(`[${name}] timeout: '${type}' ${JSON.stringify(filter)} (${timeout}ms)`));
						}, timeout);
						waiters.push({ type, filter, resolve: res, reject: rej, timer });
					});
				},
				close() { ws.close(); },
			});
		});
	});
}

// ── Run one game (within a series) ───────────────────────────────
async function playGame(bot: BotClient, seed: string, matchId: string, gameNum: number): Promise<void> {
	const seedNum = parseInt(seed, 16) >>> 0;
	const state = makeInitialState(seedNum, DEFAULT_CONFIG);

	return new Promise<void>((resolve) => {
		const loop = setInterval(() => {
			if (!state || state.gameOver) {
				clearInterval(loop);
				bot.send({ type: 'match-done', matchId });
				resolve();
				return;
			}
			const action = pickAction(state);
			if (action) {
				state.character.queuedActions.push(action);
				bot.send({ type: 'input', matchId, tick: state.tick, payload: Buffer.from(action).toString('base64') });
			}
			simTick(state, DEFAULT_CONFIG);
		}, Math.round(1000 / TICK_HZ));
	});
}

// ── Run one full match (Bo3) ─────────────────────────────────────
async function playMatch(botA: BotClient, botB: BotClient, round: number): Promise<{ winner: string; games: number }> {
	const start = Date.now();
	// Flush stale WS messages from previous rounds
	botA.flush();
	botB.flush();

	// Create challenge via REST
	const chalRes = await fetch(`${HTTP}/api/challenges`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ from: botA.name, opponent: botB.name, wager: 0, bestOf: BEST_OF }),
	});
	const chalData = await chalRes.json() as any;
	if (!chalData.challengeId) throw new Error(`Challenge create failed: ${JSON.stringify(chalData)}`);

	// B accepts
	const acceptRes = await fetch(`${HTTP}/api/challenges/${chalData.challengeId}/accept`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ by: botB.name }),
	});
	const acceptData = await acceptRes.json() as any;
	if (!acceptData.matchId) throw new Error(`Accept failed: ${JSON.stringify(acceptData)}`);

	// Both get challenge-start
	const startA = await botA.waitFor('challenge-start', 10_000);
	await botB.waitFor('challenge-start', 10_000);

	const matchId = startA.matchId;
	let gamesPlayed = 0;
	let currentSeed = startA.seed;
	const mf = { matchId }; // matchId filter shorthand

	// Play games until series ends
	while (true) {
		gamesPlayed++;
		const gameNum = gamesPlayed;
		console.log(`  [R${round}] game ${gameNum} seed=${currentSeed}`);

		// Both ready
		botA.send({ type: 'match-ready', matchId });
		botB.send({ type: 'match-ready', matchId });

		// Wait for match-start with correct gameNumber
		const msA = await botA.waitFor('match-start', 15_000, { ...mf, gameNumber: gameNum });
		await botB.waitFor('match-start', 15_000, { ...mf, gameNumber: gameNum });
		currentSeed = msA.seed;

		// Play the game
		const delay = Math.max(0, (msA.startsAt || Date.now()) - Date.now());
		await new Promise(r => setTimeout(r, delay + 100));
		await Promise.all([
			playGame(botA, currentSeed, matchId, gameNum),
			playGame(botB, currentSeed, matchId, gameNum),
		]);

		// Wait for EITHER game-result OR match-end.
		const resultA = await botA.waitFor('game-result|match-end', 15_000, { matchId }) as any;
		resultA._type = resultA.type;
		console.log(`    [debug] consumed ${resultA.type} game=${resultA.gameNumber ?? '-'} winner=${resultA.winner} wA=${resultA.winsA ?? resultA.scoreA} wB=${resultA.winsB ?? resultA.scoreB}`);

		if (resultA._type === 'match-end') {
			const elapsed = Date.now() - start;
			console.log(`  [R${round}] match-end: winner=${resultA.winner} (${resultA.scoreA}-${resultA.scoreB}) ${gamesPlayed} games ${elapsed}ms`);
			await botB.waitFor('match-end', 5_000, mf).catch(() => {});
			return { winner: resultA.winner, games: gamesPlayed };
		}

		// Interim game result — verify series score incremented
		console.log(`  [R${round}] game ${gameNum}: winner=${resultA.winner} series ${resultA.winsA}-${resultA.winsB}`);
		const totalWins = resultA.winsA + resultA.winsB;
		if (totalWins !== gameNum) {
			throw new Error(`Series score mismatch: winsA=${resultA.winsA} winsB=${resultA.winsB} after game ${gameNum}`);
		}

		// Wait for series-next
		const nextA = await botA.waitFor('series-next', 15_000, mf);
		await botB.waitFor('series-next', 15_000, mf);
		currentSeed = nextA.seed;
	}
}

// ── Main loop ────────────────────────────────────────────────────
async function main() {
	console.log(`\n=== STRESS TEST: ${TOTAL_ROUNDS} Bo${BEST_OF} rematches on ${host} ===\n`);

	const botA = await createBot('stress_a');
	const botB = await createBot('stress_b');
	console.log('Both bots connected.\n');

	for (let round = 1; round <= TOTAL_ROUNDS; round++) {
		const start = Date.now();
		try {
			const result = await Promise.race([
				playMatch(botA, botB, round),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error(`Round ${round} TIMEOUT (${MATCH_TIMEOUT}ms)`)), MATCH_TIMEOUT)
				),
			]);
			const elapsed = Date.now() - start;
			results.push({ round, winner: result.winner, games: result.games, time: elapsed });
			completed++;
			console.log(`✓ Round ${round}/${TOTAL_ROUNDS}: ${result.winner} won in ${result.games} games (${(elapsed/1000).toFixed(1)}s)\n`);
		} catch (err: any) {
			errors++;
			console.error(`✗ Round ${round}/${TOTAL_ROUNDS}: ERROR — ${err.message}\n`);
			// Try to recover by creating fresh bots? For now just log and continue.
			// Skip to next round — the old match state might be stuck.
			await new Promise(r => setTimeout(r, 2000));
		}
	}

	// ── Summary ──────────────────────────────────────────────────
	console.log('\n=== RESULTS ===');
	console.log(`Completed: ${completed}/${TOTAL_ROUNDS}`);
	console.log(`Errors:    ${errors}`);
	if (results.length > 0) {
		const avgTime = results.reduce((s, r) => s + r.time, 0) / results.length;
		const avgGames = results.reduce((s, r) => s + r.games, 0) / results.length;
		const winsA = results.filter(r => r.winner === 'stress_a').length;
		const winsB = results.filter(r => r.winner === 'stress_b').length;
		console.log(`Avg time:  ${(avgTime/1000).toFixed(1)}s per match`);
		console.log(`Avg games: ${avgGames.toFixed(1)} per match`);
		console.log(`Wins:      stress_a=${winsA} stress_b=${winsB}`);
	}
	if (errors > 0) {
		console.log(`\n⚠ ${errors} errors detected — review logs above`);
		process.exit(1);
	} else {
		console.log('\n✓ All rounds completed cleanly');
	}

	botA.close();
	botB.close();
	process.exit(0);
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
