/**
 * DOM HUD updates. Writes sim state values to the score/coins display
 * elements defined in index.html. No sim logic here — just a thin
 * translator from GameState to innerHTML.
 *
 * The same text values are written to both desktop (#score, #coins)
 * and mobile (#mobile-score, #mobile-coins) elements to keep the HUD
 * in sync across layouts.
 */

import type { GameState } from '../sim/state';

let cachedElements: {
	score: HTMLElement | null;
	coins: HTMLElement | null;
	mobileScoreStrong: HTMLElement | null;
	mobileCoinsStrong: HTMLElement | null;
} | null = null;

function elements() {
	if (cachedElements === null) {
		cachedElements = {
			score: document.getElementById('score'),
			coins: document.getElementById('coins'),
			mobileScoreStrong: document
				.getElementById('mobile-score')
				?.querySelector('strong') as HTMLElement | null,
			mobileCoinsStrong: document
				.getElementById('mobile-coins')
				?.querySelector('strong') as HTMLElement | null,
		};
	}
	return cachedElements;
}

/** Push the current score and coin count from sim state to the DOM. */
export function updateHud(state: GameState): void {
	const els = elements();
	const scoreText = String(state.score);
	const coinsText = String(state.coinCount);
	if (els.score) els.score.innerHTML = scoreText;
	if (els.coins) els.coins.innerHTML = coinsText;
	if (els.mobileScoreStrong) els.mobileScoreStrong.innerHTML = scoreText;
	if (els.mobileCoinsStrong) els.mobileCoinsStrong.innerHTML = coinsText;

	// Flamethrower indicator
	let flameEl = document.getElementById('flame-indicator');
	if (state.flamethrowerCharges > 0) {
		if (!flameEl) {
			flameEl = document.createElement('div');
			flameEl.id = 'flame-indicator';
			flameEl.style.cssText =
				'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:100;' +
				'font-family:monospace;font-size:16px;font-weight:bold;padding:8px 20px;' +
				'border-radius:6px;text-align:center;pointer-events:none;';
			document.body.appendChild(flameEl);
		}
		flameEl.style.background = 'rgba(255,102,0,0.2)';
		flameEl.style.color = '#ff6600';
		flameEl.style.border = '1px solid #ff6600';
		const charges = state.flamethrowerCharges;
		flameEl.textContent = `🔥 FLAME x${charges} (F / Down)`;
	} else if (flameEl) {
		flameEl.remove();
	}
}
