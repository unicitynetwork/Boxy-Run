/**
 * Boxy Run entry point. Supports two modes:
 *
 * **Single-player** (default): keyboard controls, one seed per session.
 *   URL: /dev.html?seed=42
 *
 * **Tournament mode**: connects to a tournament server, joins a lobby,
 *   plays a live 1v1 match. Both sims (own + opponent) run locally
 *   from the shared match seed.
 *   URL: /dev.html?tournament=1&name=@alice&server=ws://localhost:7101
 *
 * In tournament mode, inputs are streamed over the wire. The opponent's
 * inputs are applied to a second local sim. When either character dies,
 * the match result is computed from both sims and submitted for hash
 * agreement.
 */

import {
	createScene,
	renderFrame,
	type SceneHandle,
} from '../render/scene';
import { createRenderState, syncRender, type RenderState } from '../render/sync';
import { makeInitialState } from '../sim/init';
import {
	DEFAULT_CONFIG,
	TICK_SECONDS,
	type CharacterAction,
	type GameConfig,
	type GameState,
} from '../sim/state';
import { tick } from '../sim/tick';
import { TournamentClient } from '../../tournament/client/client';

// Key codes
const KEY_LEFT = 37;
const KEY_UP = 38;
const KEY_RIGHT = 39;
const KEY_P = 80;
const KEY_A = 65;
const KEY_W = 87;
const KEY_D = 68;
const KEY_ENTER = 13;

window.addEventListener('load', () => {
	const params = new URLSearchParams(location.search);
	const isTournament = params.get('tournament') === '1';

	if (isTournament) {
		startTournamentMode(params);
	} else {
		startSinglePlayer(params);
	}
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Single-player (unchanged from before)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function startSinglePlayer(params: URLSearchParams) {
	const seedParam = params.get('seed');
	const seed = seedParam
		? parseInt(seedParam, 10) >>> 0
		: (Math.random() * 0xffffffff) >>> 0;
	console.log('Boxy Run seed:', seed);

	const config = DEFAULT_CONFIG;
	const scene = createScene();
	const render = createRenderState(scene);
	const state = makeInitialState(seed, config);
	let paused = true;

	syncRender(state, render, scene, config);
	renderFrame(scene);

	let lastFrameTime = performance.now();
	let tickAccumulator = 0;
	const keysAllowed: Record<number, boolean> = {};

	document.addEventListener('keydown', (e) => {
		if (state.gameOver) return;
		const key = e.keyCode;
		if (keysAllowed[key] === false) return;
		keysAllowed[key] = false;

		if (paused && key > 18) {
			paused = false;
			lastFrameTime = performance.now();
			tickAccumulator = 0;
			hideOverlay();
			return;
		}
		if (key === KEY_P) {
			paused = !paused;
			if (!paused) lastFrameTime = performance.now();
			else showOverlay('Paused. Press any key to resume.');
			return;
		}
		if (paused) return;
		const action = keyToAction(key);
		if (action) state.character.queuedActions.push(action);
	});
	document.addEventListener('keyup', (e) => { keysAllowed[e.keyCode] = true; });

	function loop() {
		const now = performance.now();
		let delta = (now - lastFrameTime) / 1000;
		lastFrameTime = now;
		delta = Math.min(delta, 0.1);
		if (!paused && !state.gameOver) {
			tickAccumulator += delta;
			while (tickAccumulator >= TICK_SECONDS && !state.gameOver) {
				tick(state, config);
				tickAccumulator -= TICK_SECONDS;
			}
		}
		syncRender(state, render, scene, config);
		renderFrame(scene);
		if (state.gameOver && !paused) {
			paused = true;
			showOverlay(`Game over! Score: ${state.score}, Coins: ${state.coinCount}. Reload to try again.`);
		}
		requestAnimationFrame(loop);
	}

	(window as any).__boxyDebug = {
		get seed() { return state.seed; },
		get tick() { return state.tick; },
		get score() { return state.score; },
		get state() { return state; },
	};

	requestAnimationFrame(loop);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tournament mode
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function startTournamentMode(params: URLSearchParams) {
	const name = params.get('name') || '@player';
	const serverUrl = params.get('server') || 'ws://localhost:7101';
	const tournamentId = params.get('tid') || 'boxyrun-alpha-1';
	console.log(`Tournament mode: ${name} → ${serverUrl} (${tournamentId})`);

	const config = DEFAULT_CONFIG;
	const scene = createScene();
	const render = createRenderState(scene);

	// Start with a placeholder sim so the world renders while we wait
	let myState: GameState = makeInitialState(0, config);
	let opponentState: GameState | null = null;
	let matchId: string | null = null;
	let mySide: 'A' | 'B' = 'A';
	let matchActive = false;
	let matchOver = false;
	let resultSubmitted = false;

	let lastFrameTime = performance.now();
	let tickAccumulator = 0;
	const keysAllowed: Record<number, boolean> = {};

	showOverlay(`Connecting to ${serverUrl}...`);

	const client = new TournamentClient({
		url: serverUrl,
		nametag: name,
		pubkey: name.replace('@', '') + '00'.repeat(31),

		onLobbyState: (msg) => {
			showOverlay(
				`Lobby: ${msg.players.length}/${msg.capacity} players<br>` +
				msg.players.map((p) => p.nametag).join(', ') +
				'<br><br>Waiting for more players...',
			);
		},

		onBracket: (msg) => {
			console.log('Bracket received:', msg.rounds);
		},

		onRoundOpen: (msg) => {
			matchId = msg.matchId;
			showOverlay(
				`Match ready! vs ${msg.opponent}<br>` +
				`Press ENTER when ready`,
			);
		},

		onOpponentReady: (msg) => {
			if (msg.ready) {
				showOverlay(
					`Opponent is ready! Press ENTER to start`,
				);
			}
		},

		onMatchStart: (msg) => {
			console.log('Match start!', msg);
			matchId = msg.matchId;
			mySide = msg.youAre;
			const seed = parseInt(msg.seed, 16) >>> 0;

			// Create fresh sims from the match seed
			myState = makeInitialState(seed, config);
			opponentState = makeInitialState(seed, config);
			matchActive = true;
			matchOver = false;
			resultSubmitted = false;
			lastFrameTime = performance.now();
			tickAccumulator = 0;

			// Clear the old world meshes and recreate
			// (simple approach: just let syncRender handle it)
			hideOverlay();
		},

		onOpponentInput: (msg) => {
			if (!opponentState) return;
			try {
				const action = atob(msg.payload) as CharacterAction;
				if (action === 'up' || action === 'left' || action === 'right') {
					opponentState.character.queuedActions.push(action);
				}
			} catch {
				// ignore malformed payloads
			}
		},

		onMatchEnd: (msg) => {
			console.log('Match end:', msg);
			showOverlay(
				`Match over! Winner: ${msg.winner}<br>Reason: ${msg.reason}`,
			);
		},

		onTournamentEnd: (msg) => {
			console.log('Tournament end:', msg);
			const lines = msg.standings
				.map((s) => `#${s.place} ${s.nametag}`)
				.join('<br>');
			showOverlay(
				`Tournament complete!<br><br>${lines}<br><br>Reload to play again.`,
			);
		},

		onError: (msg) => {
			console.error('Tournament error:', msg);
		},
	});

	// Connect and join
	client
		.connect()
		.then(() => {
			console.log('Connected to tournament server');
			client.join(tournamentId);
		})
		.catch((err) => {
			showOverlay(`Failed to connect: ${err}`);
		});

	// Keyboard: ENTER to ready, gameplay keys during match
	document.addEventListener('keydown', (e) => {
		const key = e.keyCode;
		if (keysAllowed[key] === false) return;
		keysAllowed[key] = false;

		if (key === KEY_ENTER && matchId && !matchActive) {
			client.ready(matchId);
			showOverlay('Waiting for opponent...');
			return;
		}

		if (!matchActive || matchOver) return;

		const action = keyToAction(key);
		if (action) {
			myState.character.queuedActions.push(action);
			if (matchId) {
				client.sendInput(matchId, myState.tick, btoa(action));
			}
		}
	});
	document.addEventListener('keyup', (e) => { keysAllowed[e.keyCode] = true; });

	// Main loop
	function loop() {
		const now = performance.now();
		let delta = (now - lastFrameTime) / 1000;
		lastFrameTime = now;
		delta = Math.min(delta, 0.1);

		if (matchActive && !matchOver) {
			tickAccumulator += delta;
			while (tickAccumulator >= TICK_SECONDS && !matchOver) {
				tick(myState, config);
				if (opponentState) tick(opponentState, config);

				// Check if either sim ended
				if (myState.gameOver || opponentState?.gameOver) {
					matchOver = true;
					matchActive = false;

					if (!resultSubmitted && matchId) {
						resultSubmitted = true;
						const myDead = myState.gameOver;
						const oppDead = opponentState?.gameOver ?? false;

						let winner: 'A' | 'B';
						if (myDead && !oppDead) {
							winner = mySide === 'A' ? 'B' : 'A';
						} else if (!myDead && oppDead) {
							winner = mySide;
						} else {
							// Both died on same tick — higher score wins
							const myScore = myState.score;
							const oppScore = opponentState?.score ?? 0;
							winner = myScore >= oppScore ? mySide : (mySide === 'A' ? 'B' : 'A');
						}

						const scores = {
							A: mySide === 'A' ? myState.score : (opponentState?.score ?? 0),
							B: mySide === 'B' ? myState.score : (opponentState?.score ?? 0),
						};

						// Simple result hash: deterministic from shared data
						const resultHash = `${myState.seed}-${myState.tick}-${scores.A}-${scores.B}-${winner}`;

						client.submitResult(
							matchId,
							myState.tick,
							scores,
							winner,
							'inputs-hash-stub',
							resultHash,
						);

						const status = winner === mySide ? 'You win!' : 'You lose!';
						showOverlay(
							`${status}<br>Score: ${myState.score} vs ${opponentState?.score ?? 0}`,
						);
					}
					break;
				}

				tickAccumulator -= TICK_SECONDS;
			}
		}

		// Render my sim (my character + world from my perspective)
		syncRender(myState, render, scene, config);
		renderFrame(scene);

		requestAnimationFrame(loop);
	}

	// Expose debug state
	(window as any).__boxyDebug = {
		get myState() { return myState; },
		get opponentState() { return opponentState; },
		get matchId() { return matchId; },
		get mySide() { return mySide; },
		get matchActive() { return matchActive; },
	};

	syncRender(myState, render, scene, config);
	renderFrame(scene);
	requestAnimationFrame(loop);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Shared utilities
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function keyToAction(key: number): CharacterAction | null {
	if (key === KEY_UP || key === KEY_W) return 'up';
	if (key === KEY_LEFT || key === KEY_A) return 'left';
	if (key === KEY_RIGHT || key === KEY_D) return 'right';
	return null;
}

function showOverlay(text: string): void {
	const el = document.getElementById('variable-content');
	if (el) {
		el.style.visibility = 'visible';
		el.innerHTML = text;
	}
}

function hideOverlay(): void {
	const el = document.getElementById('variable-content');
	if (el) el.style.visibility = 'hidden';
	const controls = document.getElementById('controls');
	if (controls) controls.style.display = 'none';
}
