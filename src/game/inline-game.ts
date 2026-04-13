/**
 * Inline game module — renders Boxy Run inside any container element.
 * Used by the tournament page to play matches without page redirects.
 *
 * Usage:
 *   const game = InlineGame.create(containerEl, {
 *     seed: 0x4dc33fde,
 *     mySide: 'A',
 *     onInput: (tick, payload) => wsSend({type:'input', ...}),
 *     onDone: () => wsSend({type:'match-done', ...}),
 *   });
 *   // Feed opponent inputs from WebSocket:
 *   game.opponentInput(tick, payload);
 *   // Clean up when match ends:
 *   game.destroy();
 */

import { createScene, renderFrame, type SceneHandle } from '../render/scene';
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
import { SKINS } from '../render/skins';

export interface InlineGameOptions {
	seed: number;
	mySide: 'A' | 'B';
	onInput: (tick: number, payload: string) => void;
	onDone: () => void;
	onScore?: (myScore: number, oppScore: number) => void;
}

export interface InlineGameHandle {
	opponentInput(tick: number, payload: string): void;
	destroy(): void;
}

export function createInlineGame(
	container: HTMLElement,
	opts: InlineGameOptions,
): InlineGameHandle {
	const config = DEFAULT_CONFIG;
	const scene = createScene(container);
	const render = createRenderState(scene, SKINS[0], true);
	addOpponentMesh(render, scene);

	const myState = makeInitialState(opts.seed, config);
	const opponentState = makeInitialState(opts.seed, config);
	const opponentBuffer = new Map<number, CharacterAction[]>();

	let running = true;
	let done = false;
	let oppDone = false;
	let lastFrameTime = performance.now();
	let tickAccumulator = 0;

	// Keyboard input
	const keysAllowed: Record<number, boolean> = {};

	function keyToAction(key: number): CharacterAction | null {
		if (key === 38 || key === 87) return 'up';
		if (key === 37 || key === 65) return 'left';
		if (key === 39 || key === 68) return 'right';
		return null;
	}

	function onKeyDown(e: KeyboardEvent) {
		if (!running || done) return;
		const key = e.keyCode;
		if (keysAllowed[key] === false) return;
		keysAllowed[key] = false;
		const action = keyToAction(key);
		if (action) {
			myState.character.queuedActions.push(action);
			opts.onInput(myState.tick, btoa(action));
		}
	}

	function onKeyUp(e: KeyboardEvent) {
		keysAllowed[e.keyCode] = true;
	}

	document.addEventListener('keydown', onKeyDown);
	document.addEventListener('keyup', onKeyUp);

	// Touch input
	let touchStartX = 0, touchStartY = 0, touchStartTime = 0;
	function onTouchStart(e: TouchEvent) {
		if (!running || done) return;
		const t = e.touches[0];
		touchStartX = t.clientX;
		touchStartY = t.clientY;
		touchStartTime = Date.now();
	}
	function onTouchEnd(e: TouchEvent) {
		if (!running || done) return;
		const t = e.changedTouches[0];
		const dx = t.clientX - touchStartX;
		const dy = t.clientY - touchStartY;
		const elapsed = Date.now() - touchStartTime;
		const ax = Math.abs(dx), ay = Math.abs(dy);
		let action: CharacterAction | null = null;
		if (ax < 30 && ay < 30 && elapsed < 200) action = 'up';
		else if (ay > ax && dy < -30) action = 'up';
		else if (ax > ay && dx < -30) action = 'left';
		else if (ax > ay && dx > 30) action = 'right';
		if (action) {
			myState.character.queuedActions.push(action);
			opts.onInput(myState.tick, btoa(action));
		}
	}
	function onTouchMove(e: TouchEvent) {
		if (running && !done) e.preventDefault();
	}
	document.addEventListener('touchstart', onTouchStart, { passive: true });
	document.addEventListener('touchend', onTouchEnd, { passive: true });
	document.addEventListener('touchmove', onTouchMove, { passive: false });

	// Game loop
	let animId = 0;

	function loop() {
		if (!running) return;
		const now = performance.now();
		let delta = (now - lastFrameTime) / 1000;
		lastFrameTime = now;
		delta = Math.min(delta, 0.1);

		if (!done) {
			tickAccumulator += delta;
			while (tickAccumulator >= TICK_SECONDS && !done) {
				// Apply buffered opponent inputs
				const oppTick = opponentState.tick;
				for (const [t, actions] of opponentBuffer) {
					if (t <= oppTick) {
						for (const a of actions) opponentState.character.queuedActions.push(a);
						opponentBuffer.delete(t);
					}
				}

				tick(myState, config);
				tick(opponentState, config);

				// Check if both dead
				if (myState.gameOver && opponentState.gameOver) {
					done = true;
					opts.onDone();
					break;
				}
				// Check if just my character died (opponent may still run)
				if (myState.gameOver && !oppDone) {
					oppDone = true;
					// Keep ticking opponent sim but signal we're done
				}

				tickAccumulator -= TICK_SECONDS;
			}
		}

		// Update score display
		const scoreEl = document.getElementById('game-score');
		const coinsEl = document.getElementById('game-coins');
		if (scoreEl) scoreEl.textContent = String(myState.score);
		if (coinsEl) coinsEl.textContent = String(myState.coinCount);
		if (opts.onScore) opts.onScore(myState.score, opponentState.score);

		syncRender(myState, render, scene, config);
		syncOpponent(opponentState, render, config);

		// Hide dead opponent
		if (opponentState.gameOver && render.opponent) {
			render.opponent.root.visible = false;
		}

		renderFrame(scene);
		animId = requestAnimationFrame(loop);
	}

	// Start rendering
	syncRender(myState, render, scene, config);
	syncOpponent(opponentState, render, config);
	renderFrame(scene);
	animId = requestAnimationFrame(loop);

	return {
		opponentInput(tick: number, payload: string) {
			try {
				const action = atob(payload) as CharacterAction;
				if (action === 'up' || action === 'left' || action === 'right') {
					if (!opponentBuffer.has(tick)) opponentBuffer.set(tick, []);
					opponentBuffer.get(tick)!.push(action);
				}
			} catch {}
		},
		destroy() {
			running = false;
			cancelAnimationFrame(animId);
			document.removeEventListener('keydown', onKeyDown);
			document.removeEventListener('keyup', onKeyUp);
			document.removeEventListener('touchstart', onTouchStart);
			document.removeEventListener('touchend', onTouchEnd);
			document.removeEventListener('touchmove', onTouchMove);
			// Remove Three.js canvas
			while (container.firstChild) container.removeChild(container.firstChild);
		},
	};
}

// Export globally so the tournament page can call it
(window as any).InlineGame = { create: createInlineGame };
