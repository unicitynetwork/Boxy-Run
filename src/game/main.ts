/**
 * Boxy Run entry point — wires the pure sim to the renderer and to
 * DOM input, then drives a fixed-step tick accumulator from rAF.
 *
 * This file intentionally does NOT include Sphere wallet integration,
 * mobile touch, or the full game-over UI. Those are separate concerns
 * that will be layered on top once the core sim+renderer pipeline is
 * proven to work end-to-end. For now, this is the minimum-viable
 * entry point: keyboard controls, one seed per session, start-on-
 * keypress, a simple game-over message.
 */

import {
	createScene,
	renderFrame,
	type SceneHandle,
} from '../render/scene';
import { createRenderState, syncRender } from '../render/sync';
import { makeInitialState } from '../sim/init';
import {
	DEFAULT_CONFIG,
	TICK_SECONDS,
	type CharacterAction,
	type GameState,
} from '../sim/state';
import { tick } from '../sim/tick';

// Key codes
const KEY_LEFT = 37;
const KEY_UP = 38;
const KEY_RIGHT = 39;
const KEY_P = 80;
const KEY_A = 65;
const KEY_W = 87;
const KEY_D = 68;

interface GameHandles {
	state: GameState;
	scene: SceneHandle;
	paused: boolean;
}

window.addEventListener('load', () => {
	// Resolve seed from URL parameter or generate a random one.
	const params = new URLSearchParams(location.search);
	const seedParam = params.get('seed');
	const seed = seedParam
		? parseInt(seedParam, 10) >>> 0
		: (Math.random() * 0xffffffff) >>> 0;
	console.log('Boxy Run seed:', seed);

	const config = DEFAULT_CONFIG;
	const sceneHandle = createScene();
	const renderState = createRenderState(sceneHandle);

	const game: GameHandles = {
		state: makeInitialState(seed, config),
		scene: sceneHandle,
		paused: true,
	};

	// Prime the renderer so the world is visible before the player
	// presses a key.
	syncRender(game.state, renderState, sceneHandle, config);
	renderFrame(sceneHandle);

	let lastFrameTime = performance.now();
	let tickAccumulator = 0;
	const keysAllowed: Record<number, boolean> = {};

	document.addEventListener('keydown', (e) => {
		if (game.state.gameOver) return;
		const key = e.keyCode;
		if (keysAllowed[key] === false) return;
		keysAllowed[key] = false;

		// First keypress from a paused state starts the run.
		if (game.paused && key > 18) {
			game.paused = false;
			lastFrameTime = performance.now();
			tickAccumulator = 0;
			hideOverlay();
			return;
		}

		if (key === KEY_P) {
			game.paused = !game.paused;
			if (!game.paused) {
				lastFrameTime = performance.now();
			} else {
				showOverlay('Paused. Press any key to resume.');
			}
			return;
		}

		if (game.paused) return;

		const action = keyToAction(key);
		if (action) game.state.character.queuedActions.push(action);
	});

	document.addEventListener('keyup', (e) => {
		keysAllowed[e.keyCode] = true;
	});

	window.addEventListener('focus', () => {
		// Clear any stuck-held keys if the window loses focus mid-press.
		for (const k of Object.keys(keysAllowed)) {
			keysAllowed[k as unknown as number] = true;
		}
	});

	function loop() {
		const now = performance.now();
		let delta = (now - lastFrameTime) / 1000;
		lastFrameTime = now;
		delta = Math.min(delta, 0.1);

		if (!game.paused && !game.state.gameOver) {
			tickAccumulator += delta;
			while (tickAccumulator >= TICK_SECONDS && !game.state.gameOver) {
				tick(game.state, config);
				tickAccumulator -= TICK_SECONDS;
			}
		}

		syncRender(game.state, renderState, sceneHandle, config);
		renderFrame(sceneHandle);

		if (game.state.gameOver && !game.paused) {
			game.paused = true;
			showOverlay(
				`Game over! Score: ${game.state.score}, Coins: ${game.state.coinCount}. Reload to try again.`,
			);
		}

		requestAnimationFrame(loop);
	}

	// Debug handle for manual inspection of live sim state.
	(window as unknown as Record<string, unknown>).__boxyDebug = {
		get seed() {
			return game.state.seed;
		},
		get tick() {
			return game.state.tick;
		},
		get score() {
			return game.state.score;
		},
		get coinCount() {
			return game.state.coinCount;
		},
		get gameOver() {
			return game.state.gameOver;
		},
		get state() {
			return game.state;
		},
	};

	requestAnimationFrame(loop);
});

/** Map a keycode to a character action, or null if it's not a gameplay key. */
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
