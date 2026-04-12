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

	// If skin is already set via URL param, skip the selector
	if (skinParam) {
		const skin = getSkin(skinParam);
		if (isTournament) startTournamentMode(params, skin);
		else startSinglePlayer(params, skin);
		return;
	}

	// Show character selector, then start the game
	showSkinSelector((skin) => {
		if (isTournament) startTournamentMode(params, skin);
		else startSinglePlayer(params, skin);
	});
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
	const serverUrl = params.get('server') || 'ws://localhost:7101';
	const tournamentId = params.get('tid') || 'boxyrun-alpha-1';
	console.log(`Tournament mode: ${name} → ${serverUrl} (${tournamentId}) skin: ${skin.name}`);

	const config = DEFAULT_CONFIG;
	const scene = createScene();
	const render = createRenderState(scene, skin);

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
			opponentDeathNotified = false;
			myDeathNotified = false;
			lastFrameTime = performance.now();
			tickAccumulator = 0;

			// Add opponent character to the scene (cherry red shirt)
			removeOpponentMesh(render, scene);
			addOpponentMesh(render, scene);

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
			removeOpponentHud();
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
				// Advance both sims. tick() no-ops on a dead sim, so
				// only the surviving player's sim keeps progressing.
				tick(myState, config);
				if (opponentState) tick(opponentState, config);

				// Notify when opponent dies (match continues — survivor keeps running)
				if (opponentState?.gameOver && !opponentDeathNotified) {
					opponentDeathNotified = true;
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
					const oppScore = opponentState?.score ?? 0;
					const oppSide: 'A' | 'B' = mySide === 'A' ? 'B' : 'A';
					const winner: 'A' | 'B' = myScore >= oppScore ? mySide : oppSide;

					const scores = {
						A: mySide === 'A' ? myScore : oppScore,
						B: mySide === 'B' ? myScore : oppScore,
					};

					// Use the higher tick as the finalTick (survivor ran longer)
					const finalTick = Math.max(
						myState.tick,
						opponentState?.tick ?? 0,
					);

					const resultHash = `${myState.seed}-${finalTick}-${scores.A}-${scores.B}-${winner}`;

					client.submitResult(
						matchId,
						finalTick,
						scores,
						winner,
						'inputs-hash-stub',
						resultHash,
					);

					const status = winner === mySide ? 'You win!' : 'You lose!';
					showOverlay(
						`${status}<br>Your score: ${myScore} vs Opponent: ${oppScore}`,
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
		'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:150;' +
		'background:rgba(0,0,0,0.8);color:#fff;' +
		'padding:24px 40px;border-radius:8px;text-align:center;' +
		'font-family:monospace;pointer-events:none;' +
		'border:1px solid rgba(255,255,255,0.15);' +
		'animation:fadeInBanner 0.3s ease;';
	deathBannerEl.innerHTML =
		`<div style="font-size:20px;font-weight:bold;margin-bottom:8px;letter-spacing:0.1em">${title}</div>` +
		`<div style="font-size:13px;color:#94a3b8">${subtitle}</div>`;

	// Add the animation keyframe if not already present
	if (!document.getElementById('death-banner-style')) {
		const style = document.createElement('style');
		style.id = 'death-banner-style';
		style.textContent = '@keyframes fadeInBanner{from{opacity:0;transform:translate(-50%,-50%) scale(0.95)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}';
		document.head.appendChild(style);
	}

	document.body.appendChild(deathBannerEl);

	// Auto-fade after 3 seconds so it doesn't block the view permanently
	setTimeout(() => {
		if (deathBannerEl) {
			deathBannerEl.style.transition = 'opacity 0.5s';
			deathBannerEl.style.opacity = '0.4';
		}
	}, 3000);
}

function removeDeathBanner(): void {
	if (deathBannerEl) {
		deathBannerEl.remove();
		deathBannerEl = null;
	}
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
