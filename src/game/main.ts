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
import {
	addOpponentMesh,
	createRenderState,
	removeOpponentMesh,
	syncOpponent,
	syncRender,
	type RenderState,
} from '../render/sync';
import { makeInitialState } from '../sim/init';
import {
	DEFAULT_CONFIG,
	TICK_SECONDS,
	type CharacterAction,
	type GameConfig,
	type GameState,
} from '../sim/state';
import { tick } from '../sim/tick';
import { getSkin, SKINS, type CharacterSkin } from '../render/skins';
import { TournamentClient } from '../../tournament/client/client';

// ── Sphere wallet bridge ─────────────────────────────────────────
// sphere-connect.ts (loaded before this script) exposes
// window.SphereWallet. These helpers wrap it so the rest of the code
// doesn't need to null-check repeatedly.
interface SphereWallet {
	isConnected: boolean;
	isDepositPaid: boolean;
	identity: { nametag?: string } | null;
	coinId: string;
	entryFee: number;
	updateUI(phase: string): void;
	requestPayout(coins: number): void;
	resetDeposit(): void;
	depositAndRestart(): void;
}

function getWallet(): SphereWallet | null {
	return (window as any).SphereWallet ?? null;
}

function walletNametag(): string | null {
	return getWallet()?.identity?.nametag ?? null;
}

function walletCanPlay(): boolean {
	const w = getWallet();
	if (!w) return true; // no wallet = dev mode, allow playing
	return w.isDepositPaid;
}

// Shared state for rematch
let lastOpponentName = '';
let lastTournamentType = '';

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
	const skinParam = params.get('skin');
	const isTournament = params.get('tournament') === '1';

	// Tournament mode: skip skin selector (use param or default).
	// Showing a selector during a redirect/reload wastes time and
	// confuses the flow — the match is waiting.
	if (isTournament) {
		const skin = getSkin(skinParam);
		startTournamentMode(params, skin);
		return;
	}

	// Single-player: show skin selector if no param
	if (skinParam) {
		startSinglePlayer(params, getSkin(skinParam));
		return;
	}
	showSkinSelector((skin) => startSinglePlayer(params, skin));
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Single-player (unchanged from before)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function startSinglePlayer(params: URLSearchParams, skin: CharacterSkin) {
	const seedParam = params.get('seed');
	const seed = seedParam
		? parseInt(seedParam, 10) >>> 0
		: (Math.random() * 0xffffffff) >>> 0;
	console.log('Boxy Run seed:', seed, 'skin:', skin.name);

	const config = DEFAULT_CONFIG;
	const scene = createScene();
	const render = createRenderState(scene, skin);
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
			if (!walletCanPlay()) return; // deposit required
			paused = false;
			lastFrameTime = performance.now();
			tickAccumulator = 0;
			hideOverlay();
			getWallet()?.updateUI('playing');
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

	installTouchControls({
		onAction: (a) => {
			if (!paused && !state.gameOver) state.character.queuedActions.push(a);
		},
		onStart: () => {
			if (paused && !state.gameOver && walletCanPlay()) {
				paused = false;
				lastFrameTime = performance.now();
				tickAccumulator = 0;
				hideOverlay();
				getWallet()?.updateUI('playing');
			}
		},
		isPlaying: () => !paused && !state.gameOver,
	});

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
			const w = getWallet();
			if (w?.isConnected) {
				w.requestPayout(state.coinCount);
				w.resetDeposit();
				w.updateUI('gameover');
				showOverlay(
					`Game over! You earned <strong>${state.coinCount} ${w.coinId}</strong>`,
				);
			} else {
				showOverlay(
					`Game over! Score: ${state.score}, Coins: ${state.coinCount}. Reload to try again.`,
				);
			}
			// Submit score to leaderboard API
			const nickname = walletNametag() || 'anonymous';
			submitScore(nickname, state.score, state.coinCount);
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

function startTournamentMode(params: URLSearchParams, skin: CharacterSkin) {
	const name = params.get('name') || '@player';
	const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
	const serverUrl = params.get('server') || `${wsProto}//${location.host}`;
	const tournamentId = params.get('tid') || 'boxyrun-alpha-1';
	console.log(`Tournament mode: ${name} → ${serverUrl} (${tournamentId}) skin: ${skin.name}`);

	const config = DEFAULT_CONFIG;
	const scene = createScene();
	const render = createRenderState(scene, skin, true);

	// Start with a placeholder sim so the world renders while we wait
	let myState: GameState = makeInitialState(0, config);
	let opponentState: GameState | null = null;
	let matchId: string | null = null;
	let mySide: 'A' | 'B' = 'A';
	let matchActive = false;
	let matchOver = false;
	let resultSubmitted = false;
	let opponentDeathNotified = false;
	let myDeathNotified = false;
	/** Buffered opponent inputs keyed by tick number. */
	const opponentInputBuffer: Map<number, CharacterAction[]> = new Map();

	let lastFrameTime = performance.now();
	let tickAccumulator = 0;
	const keysAllowed: Record<number, boolean> = {};

	showOverlay(`Connecting to ${serverUrl}...`);

	const client = new TournamentClient({
		url: serverUrl,
		nametag: name,
		pubkey: name.replace('@', '') + '00'.repeat(31),

		onRegistered: (msg) => {
			console.log('Registered. Online players:', msg.onlinePlayers);
			showOverlay('Waiting for match...');
			// If no match arrives within 3 seconds, the tournament is
			// gone (page refresh after match ended). Show options.
			setTimeout(() => {
				if (!matchId && !matchActive) {
					showOverlay(
						'<div style="font-size:16px;margin-bottom:16px">No active match</div>' +
						rematchButton() + backToArenaLink(),
					);
				}
			}, 3000);
		},

		onChallengeReceived: (msg) => {
			console.log(`Challenge from ${msg.from}, wager: ${msg.wager}`);
			// Show accept/decline UI instead of auto-accepting.
			// This prevents the case where one player clicks REMATCH
			// while the other is navigating away.
			showOverlay(
				`<div style="font-size:18px;font-weight:bold;margin-bottom:12px">${msg.from} wants a rematch!</div>` +
				`<button onclick="window.__acceptChallenge('${msg.challengeId}')" style="${BTN_STYLE}font-size:14px;background:#2d6a4f;border-color:#2d6a4f">ACCEPT</button>` +
				`<button onclick="window.__declineChallenge('${msg.challengeId}')" style="${BTN_STYLE}font-size:13px;background:transparent;color:#1a1a2e;border-color:#1a1a2e">DECLINE</button>`,
			);
		},

		onTournamentAssigned: (msg) => {
			console.log(`Assigned to tournament ${msg.tournamentId} (${msg.tournamentType})`);
			lastTournamentType = msg.tournamentType;
			showOverlay('Tournament found! Waiting for bracket...');
		},

		onQueueState: (msg) => {
			const countdown = msg.startsAt
				? `<br>Starting in ${Math.ceil((msg.startsAt - Date.now()) / 1000)}s`
				: '';
			showOverlay(
				`In queue: position ${msg.position} of ${msg.total}${countdown}`,
			);
		},

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
			lastOpponentName = msg.opponent;
			showOverlay(
				`Match ready! vs ${msg.opponent}<br><br>` +
				readyButton(),
			);
		},

		onOpponentReady: (msg) => {
			if (msg.ready && matchId) {
				showOverlay(
					`Opponent is ready!<br><br>` +
					readyButton(),
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
			matchOver = false;
			resultSubmitted = false;
			opponentDeathNotified = false;
			myDeathNotified = false;

			// Clear opponent input buffer and add opponent to scene
			opponentInputBuffer.clear();
			removeOpponentMesh(render, scene);
			addOpponentMesh(render, scene);

			// Render the world once so both characters are visible during countdown
			syncRender(myState, render, scene, config);
			if (opponentState) syncOpponent(opponentState, render, config);
			renderFrame(scene);

			// Synchronized countdown using the server's startsAt timestamp.
			// Both clients compute the same wall-clock start time, so they
			// begin ticking within ~network-latency of each other.
			matchActive = false;
			const startTime = msg.startsAt;
			const updateCountdown = () => {
				const msLeft = startTime - Date.now();
				if (msLeft > 1000) {
					const secs = Math.ceil(msLeft / 1000);
					showOverlay(`<div style="font-size:64px;font-weight:bold">${secs}</div>`);
					setTimeout(updateCountdown, 200);
				} else if (msLeft > 0) {
					showOverlay(`<div style="font-size:64px;font-weight:bold">1</div>`);
					setTimeout(updateCountdown, msLeft);
				} else {
					showOverlay(`<div style="font-size:64px;font-weight:bold;color:#f97316">GO!</div>`);
					matchActive = true;
					lastFrameTime = performance.now();
					tickAccumulator = 0;
					setTimeout(hideOverlay, 500);
				}
			};
			updateCountdown();
		},

		onOpponentInput: (msg) => {
			if (!opponentState) return;
			try {
				const action = atob(msg.payload) as CharacterAction;
				if (action === 'up' || action === 'left' || action === 'right') {
					// Buffer by tick so we apply at the right moment
					const tick = msg.tick;
					if (!opponentInputBuffer.has(tick)) {
						opponentInputBuffer.set(tick, []);
					}
					opponentInputBuffer.get(tick)!.push(action);
				}
			} catch {
				// ignore malformed payloads
			}
		},

		onMatchEnd: (msg) => {
			console.log('Match end:', msg);
			removeOpponentHud();
			const iWon = msg.winner === name;
			const myScore = msg.scores?.[name] ?? myState.score;
			const oppScore = msg.scores?.[lastOpponentName] ?? 0;

			let statusHtml: string;
			if (msg.reason === 'dq') {
				statusHtml = iWon
					? '<div style="font-size:24px;font-weight:bold;color:#FFD700;margin-bottom:8px">OPPONENT DISQUALIFIED</div>'
					: '<div style="font-size:24px;font-weight:bold;color:#c1121f;margin-bottom:8px">YOU HAVE BEEN DISQUALIFIED</div>';
			} else {
				statusHtml = iWon
					? '<div style="font-size:24px;font-weight:bold;color:#2d6a4f;margin-bottom:8px">YOU WIN!</div>'
					: '<div style="font-size:24px;font-weight:bold;color:#c1121f;margin-bottom:8px">YOU LOSE</div>';
			}
			showOverlay(
				statusHtml +
				`<div style="font-size:16px;margin-bottom:16px">Your score: ${myScore} vs Opponent: ${oppScore}</div>` +
				rematchButton() + backToArenaLink(),
			);
		},

		onTournamentEnd: (msg) => {
			console.log('Tournament end:', msg);
			// Don't overwrite the both-dead result screen if it's already
			// showing — it has the actual scores. Only show tournament-end
			// if we don't already have a result displayed.
			if (resultSubmitted) return;

			let resultText = '';
			if (msg.standings && msg.standings.length > 0) {
				const champion = msg.standings[0]?.nametag || '?';
				const isMe = champion === name;
				resultText = isMe
					? '<div style="font-size:24px;font-weight:bold;color:#2d6a4f;margin-bottom:12px">YOU WIN!</div>'
					: `<div style="font-size:24px;font-weight:bold;color:#c1121f;margin-bottom:12px">Winner: ${champion}</div>`;
				resultText += msg.standings
					.map((s) => `<div style="margin:4px 0">#${s.place} ${s.nametag}</div>`)
					.join('');
			} else {
				resultText = '<div style="font-size:18px;margin-bottom:12px">Match complete</div>';
			}
			showOverlay(
				resultText + '<br>' +
				rematchButton() + backToArenaLink(),
			);
		},

		onError: (msg) => {
			console.error('Tournament error:', msg);
			// Suppress non-critical errors during gameplay (match_not_active
			// happens after match ends while inputs are still being sent)
			if (matchActive && (msg.code === 'match_not_active' || msg.code === 'match_not_active')) {
				return;
			}
			// Only show error in overlay if we're not in a match
			if (!matchActive) {
				showOverlay(
					`Error: ${msg.message}<br><br>` +
					rematchButton() + backToArenaLink(),
				);
			}
		},
	});

	// Connect and register. The server will re-send tournament state
	// if we're already assigned to one (e.g., redirected from the
	// tournament page after accepting a challenge).
	const mode = params.get('mode') || 'queue';
	const opponent = params.get('opponent') || '';

	client
		.connect()
		.then(() => {
			console.log('Connected to tournament server');
			client.register();

			if (mode === 'challenge' && opponent) {
				setTimeout(() => {
					client.challenge(opponent);
					showOverlay(`Challenge sent to ${opponent}...<br>Waiting for response`);
				}, 200);
			} else if (mode === 'queue') {
				setTimeout(() => {
					client.joinQueue();
					showOverlay('Joined queue...<br>Waiting for players');
				}, 200);
			}
			// For mode=legacy or any other mode: just register and wait.
			// The server re-sends tournament-assigned + bracket + round-open
			// if we're already in a tournament.
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
			if (matchId && !resultSubmitted) {
				client.sendInput(matchId, myState.tick, btoa(action));
			}
		}
	});
	document.addEventListener('keyup', (e) => { keysAllowed[e.keyCode] = true; });

	installTouchControls({
		onAction: (a) => {
			if (matchActive && !matchOver) {
				myState.character.queuedActions.push(a);
				if (matchId && !resultSubmitted) client.sendInput(matchId, myState.tick, btoa(a));
			}
		},
		onStart: () => {
			if (typeof (window as any).__ready === 'function') {
				(window as any).__ready();
			}
		},
		isPlaying: () => matchActive && !matchOver,
	});

	// Main loop
	function loop() {
		const now = performance.now();
		let delta = (now - lastFrameTime) / 1000;
		lastFrameTime = now;
		delta = Math.min(delta, 0.1);

		if (matchActive && !matchOver) {
			tickAccumulator += delta;
			while (tickAccumulator >= TICK_SECONDS && !matchOver) {
				// Apply any buffered opponent inputs for this tick
				// BEFORE advancing the opponent's sim, so the inputs
				// take effect at the same tick they were generated.
				if (opponentState) {
					const oppTick = opponentState.tick;
					const buffered = opponentInputBuffer.get(oppTick);
					if (buffered) {
						for (const action of buffered) {
							opponentState.character.queuedActions.push(action);
						}
						opponentInputBuffer.delete(oppTick);
					}
					// Also apply any inputs from earlier ticks that we
					// might have missed (arrived late). Better late than
					// never — apply them now so the sim doesn't diverge.
					for (const [t, actions] of opponentInputBuffer) {
						if (t <= oppTick) {
							for (const action of actions) {
								opponentState.character.queuedActions.push(action);
							}
							opponentInputBuffer.delete(t);
						}
					}
				}

				// Advance both sims. tick() no-ops on a dead sim, so
				// only the surviving player's sim keeps progressing.
				tick(myState, config);
				if (opponentState) tick(opponentState, config);

				// Notify when opponent dies (match continues — survivor keeps running)
				if (opponentState?.gameOver && !opponentDeathNotified) {
					opponentDeathNotified = true;
					// Hide opponent character from the scene
					if (render.opponent) render.opponent.root.visible = false;
					showDeathBanner(
						'OPPONENT DOWN',
						`Their final score: ${opponentState.score}. Keep running to beat it!`,
					);
				}

				// Notify when I die (match continues — I watch the opponent)
				if (myState.gameOver && !myDeathNotified) {
					myDeathNotified = true;
					if (!opponentState?.gameOver) {
						showDeathBanner(
							'YOU DIED',
							`Your score: ${myState.score}. Watching opponent...`,
						);
					}
				}

				// Match ends when BOTH are dead (or time cap)
				const bothDead = myState.gameOver && (opponentState?.gameOver ?? true);
				if (bothDead && !resultSubmitted && matchId) {
					matchOver = true;
					matchActive = false;
					resultSubmitted = true;
					removeDeathBanner();

					const myScore = myState.score;

					// Each player reports their OWN score. The server
					// compares both submissions to determine the winner.
					// We use a fixed resultHash so both sides always
					// "agree" — the server adjudicates from the scores.
					// (Proper hash agreement requires rollback netcode
					// to keep both sims in perfect sync, which is a
					// future improvement.)
					const scores = {
						A: mySide === 'A' ? myScore : 0,
						B: mySide === 'B' ? myScore : 0,
					};

					const resultHash = 'server-adjudicated';

					client.submitResult(
						matchId,
						myState.tick,
						scores,
						mySide, // report self as winner; server decides
						'inputs-stub',
						resultHash,
					);

					// Show "waiting for result" until match-end arrives
					// with the server's winner determination
					showOverlay(
						`<div style="font-size:16px;margin-bottom:8px">Your score: ${myScore}</div>` +
						`<div style="font-size:14px;color:#666">Waiting for final result...</div>`,
					);
					break;
				}

				tickAccumulator -= TICK_SECONDS;
			}
		}

		// Update opponent HUD if in tournament
		if (opponentState && matchActive) {
			updateOpponentHud(opponentState);
		}

		// Render my sim (my character + world from my perspective)
		syncRender(myState, render, scene, config);
		// Render opponent character from their sim state
		if (opponentState) syncOpponent(opponentState, render, config);
		renderFrame(scene);

		requestAnimationFrame(loop);
	}

	// Accept/decline rematch challenges
	(window as any).__acceptChallenge = (challengeId: string) => {
		client.acceptChallenge(challengeId);
		showOverlay('Challenge accepted! Starting match...');
	};
	(window as any).__declineChallenge = (challengeId: string) => {
		client.declineChallenge(challengeId);
		showOverlay(
			`Challenge declined.<br><br>` + backToArenaLink(),
		);
	};

	// Ready up for a match
	(window as any).__ready = () => {
		console.log('[game] __ready called, matchId=', matchId, 'matchActive=', matchActive);
		if (matchId && !matchActive) {
			client.ready(matchId);
			showOverlay('Waiting for opponent...');
		}
	};

	// Rematch: send a new challenge to the same opponent
	(window as any).__rematch = () => {
		console.log('[game] __rematch called, opponent=', lastOpponentName, 'connected=', client.isConnected());
		if (!lastOpponentName) {
			showOverlay('No opponent to rematch.<br><br>' + backToArenaLink());
			return;
		}
		if (!client.isConnected()) {
			showOverlay('Disconnected from server.<br><br>' + backToArenaLink());
			return;
		}
		showOverlay(`Sending rematch to ${lastOpponentName}...`);
		// Reset match state so we can accept a new tournament
		matchId = null;
		matchActive = false;
		matchOver = false;
		resultSubmitted = false;
		opponentDeathNotified = false;
		myDeathNotified = false;
		removeOpponentHud();
		removeDeathBanner();
		if (render.opponent) render.opponent.root.visible = false;
		client.challenge(lastOpponentName);
	};

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

/** Floating opponent HUD — created once, updated per frame. */
let opponentHudEl: HTMLElement | null = null;

function updateOpponentHud(oppState: GameState): void {
	if (!opponentHudEl) {
		opponentHudEl = document.createElement('div');
		opponentHudEl.id = 'opponent-hud';
		opponentHudEl.style.cssText =
			'position:fixed;top:16px;right:16px;z-index:100;' +
			'background:rgba(0,0,0,0.7);color:#e35d6a;' +
			'padding:10px 16px;border-radius:6px;' +
			'font-family:monospace;font-size:14px;' +
			'border:1px solid rgba(227,93,106,0.3);' +
			'pointer-events:none;';
		document.body.appendChild(opponentHudEl);
	}
	const status = oppState.gameOver ? ' [DEAD]' : '';
	opponentHudEl.innerHTML =
		`<span style="font-size:11px;opacity:0.6">OPPONENT</span><br>` +
		`Score: ${oppState.score}${status}`;
}

function removeOpponentHud(): void {
	if (opponentHudEl) {
		opponentHudEl.remove();
		opponentHudEl = null;
	}
}

/** Mid-match death banner — shown when one player dies but the match continues. */
let deathBannerEl: HTMLElement | null = null;

function showDeathBanner(title: string, subtitle: string): void {
	removeDeathBanner();
	deathBannerEl = document.createElement('div');
	deathBannerEl.style.cssText =
		'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:150;' +
		'background:rgba(0,0,0,0.5);color:#fff;opacity:0.8;' +
		'padding:12px 24px;border-radius:8px;text-align:center;' +
		'font-family:monospace;pointer-events:none;' +
		'border:1px solid rgba(255,255,255,0.1);' +
		'animation:fadeInBanner 0.3s ease;backdrop-filter:blur(4px);';
	deathBannerEl.innerHTML =
		`<span style="font-size:14px;font-weight:bold;letter-spacing:0.1em">${title}</span>` +
		`<span style="font-size:12px;color:#94a3b8;margin-left:12px">${subtitle}</span>`;

	if (!document.getElementById('death-banner-style')) {
		const style = document.createElement('style');
		style.id = 'death-banner-style';
		style.textContent = '@keyframes fadeInBanner{from{opacity:0;transform:translateX(-50%) translateY(-10px)}to{opacity:0.8;transform:translateX(-50%) translateY(0)}}';
		document.head.appendChild(style);
	}

	document.body.appendChild(deathBannerEl);

	// Fade further after 2 seconds
	setTimeout(() => {
		if (deathBannerEl) {
			deathBannerEl.style.transition = 'opacity 0.5s';
			deathBannerEl.style.opacity = '0.3';
		}
	}, 2000);
}

function removeDeathBanner(): void {
	if (deathBannerEl) {
		deathBannerEl.remove();
		deathBannerEl = null;
	}
}

// ── Touch controls ───────────────────────────────────────────────
const SWIPE_THRESHOLD = 30;
const TAP_THRESHOLD_MS = 200;

/**
 * Install touch handlers for mobile. `onAction` is called with
 * the character action; `onStart` is called on tap when the game
 * hasn't started yet. Prevents scroll/zoom during gameplay.
 */
function installTouchControls(opts: {
	onAction: (a: CharacterAction) => void;
	onStart: () => void;
	isPlaying: () => boolean;
}): void {
	let startX = 0;
	let startY = 0;
	let startTime = 0;

	document.addEventListener(
		'touchmove',
		(e) => { if (opts.isPlaying()) e.preventDefault(); },
		{ passive: false },
	);

	document.addEventListener(
		'touchstart',
		(e) => {
			if (!opts.isPlaying()) {
				// Tap to start
				opts.onStart();
				return;
			}
			const touch = e.touches[0];
			startX = touch.clientX;
			startY = touch.clientY;
			startTime = Date.now();
		},
		{ passive: true },
	);

	document.addEventListener(
		'touchend',
		(e) => {
			if (!opts.isPlaying()) return;
			const touch = e.changedTouches[0];
			const dx = touch.clientX - startX;
			const dy = touch.clientY - startY;
			const elapsed = Date.now() - startTime;
			const absDx = Math.abs(dx);
			const absDy = Math.abs(dy);

			if (absDx < SWIPE_THRESHOLD && absDy < SWIPE_THRESHOLD && elapsed < TAP_THRESHOLD_MS) {
				opts.onAction('up'); // tap = jump
			} else if (absDy > absDx && dy < -SWIPE_THRESHOLD) {
				opts.onAction('up'); // swipe up = jump
			} else if (absDx > absDy) {
				if (dx < -SWIPE_THRESHOLD) opts.onAction('left');
				else if (dx > SWIPE_THRESHOLD) opts.onAction('right');
			}
		},
		{ passive: true },
	);
}

const BTN_STYLE = 'padding:12px 32px;background:#1a1a2e;color:#fff;border:2px solid #1a1a2e;border-radius:6px;font-family:monospace;font-weight:bold;cursor:pointer;letter-spacing:0.1em;text-decoration:none;display:inline-block;margin:6px;';

function readyButton(): string {
	return `<button onclick="window.__ready()" style="${BTN_STYLE}font-size:18px;background:#f97316;border-color:#f97316;color:#fff">READY</button>`;
}

function rematchButton(): string {
	if (!lastOpponentName) return '';
	// Only show rematch for 1v1 challenges, not quick match
	if (lastTournamentType === 'rolling') return '';
	return `<button onclick="window.__rematch()" style="${BTN_STYLE}font-size:14px">REMATCH</button>`;
}

function backToArenaLink(): string {
	const tab = lastTournamentType === 'rolling' ? '#quickmatch' : '';
	return `<a href="tournament.html${tab}" style="${BTN_STYLE}font-size:13px;background:transparent;color:#1a1a2e;border-color:#1a1a2e">BACK TO ARENA</a>`;
}

/** Submit a score to the leaderboard API. Fire-and-forget. */
function submitScore(nickname: string, score: number, coins: number): void {
	fetch('/api/scores', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ nickname, score, coins }),
	}).then((r) => r.json())
		.then((d) => console.log('Score submitted:', d))
		.catch((e) => console.log('Score submission failed (API may be offline):', e));
}

/**
 * Full-screen character selector overlay. Shows a grid of skin
 * options; clicking one invokes the callback and removes the overlay.
 */
function showSkinSelector(onSelect: (skin: CharacterSkin) => void): void {
	const overlay = document.createElement('div');
	overlay.id = 'skin-selector';
	overlay.style.cssText =
		'position:fixed;inset:0;z-index:200;' +
		'background:rgba(0,0,0,0.85);' +
		'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
		'font-family:monospace;color:#e2e8f0;';

	const title = document.createElement('div');
	title.style.cssText =
		'font-size:24px;font-weight:bold;margin-bottom:8px;letter-spacing:0.1em;';
	title.textContent = 'CHOOSE YOUR RUNNER';
	overlay.appendChild(title);

	const sub = document.createElement('div');
	sub.style.cssText = 'font-size:13px;color:#64748b;margin-bottom:32px;';
	sub.textContent = 'Each coin collected adds 250 to your score';
	overlay.appendChild(sub);

	const grid = document.createElement('div');
	grid.style.cssText =
		'display:grid;grid-template-columns:repeat(4,1fr);gap:16px;' +
		'max-width:560px;width:90%;';

	for (const skin of SKINS) {
		const card = document.createElement('button');
		const hex = '#' + skin.preview.toString(16).padStart(6, '0');
		card.style.cssText =
			'background:rgba(255,255,255,0.05);border:2px solid rgba(255,255,255,0.1);' +
			'border-radius:8px;padding:16px 8px;cursor:pointer;' +
			'display:flex;flex-direction:column;align-items:center;gap:10px;' +
			'transition:all 0.2s;color:#e2e8f0;font-family:monospace;';

		// Character preview — a simple figure with colored shirt
		const figure = document.createElement('div');
		figure.style.cssText =
			'width:40px;height:60px;position:relative;';

		// Head
		const head = document.createElement('div');
		const skinHex = '#' + skin.colors.skin.toString(16).padStart(6, '0');
		const hairHex = '#' + skin.colors.hair.toString(16).padStart(6, '0');
		head.style.cssText =
			`width:20px;height:20px;background:${skinHex};` +
			`border-radius:4px;margin:0 auto;position:relative;` +
			`border-top:4px solid ${hairHex};`;
		figure.appendChild(head);

		// Torso (shirt)
		const torso = document.createElement('div');
		torso.style.cssText =
			`width:28px;height:22px;background:${hex};` +
			'border-radius:3px;margin:2px auto 0;';
		figure.appendChild(torso);

		// Shorts
		const shortsHex = '#' + skin.colors.shorts.toString(16).padStart(6, '0');
		const shorts = document.createElement('div');
		shorts.style.cssText =
			`width:28px;height:10px;background:${shortsHex};` +
			'border-radius:0 0 3px 3px;margin:1px auto 0;';
		figure.appendChild(shorts);

		// Legs
		const legs = document.createElement('div');
		legs.style.cssText =
			`width:20px;height:12px;margin:1px auto 0;` +
			`display:flex;gap:4px;justify-content:center;`;
		const legL = document.createElement('div');
		legL.style.cssText = `width:6px;height:12px;background:${skinHex};border-radius:2px;`;
		const legR = legL.cloneNode(true) as HTMLElement;
		legs.appendChild(legL);
		legs.appendChild(legR);
		figure.appendChild(legs);

		card.appendChild(figure);

		const label = document.createElement('div');
		label.style.cssText = 'font-size:11px;font-weight:600;letter-spacing:0.1em;';
		label.textContent = skin.name.toUpperCase();
		card.appendChild(label);

		card.addEventListener('mouseenter', () => {
			card.style.borderColor = hex;
			card.style.background = 'rgba(255,255,255,0.1)';
			card.style.transform = 'translateY(-2px)';
		});
		card.addEventListener('mouseleave', () => {
			card.style.borderColor = 'rgba(255,255,255,0.1)';
			card.style.background = 'rgba(255,255,255,0.05)';
			card.style.transform = 'translateY(0)';
		});
		card.addEventListener('click', () => {
			overlay.remove();
			onSelect(skin);
		});

		grid.appendChild(card);
	}

	overlay.appendChild(grid);
	document.body.appendChild(overlay);
}
