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
}
