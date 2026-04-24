/**
 * In-game UI helpers: overlay text, opponent HUD, mid-match death
 * banner, and touch-control handlers. Zero dependencies on game
 * state — pure DOM/browser interactions.
 */

import type { CharacterAction, GameState } from '../sim/state';

// ─── Overlay ─────────────────────────────────────────────────────

export function showOverlay(text: string): void {
	// Log first 80 chars of overlay content for debugging
	const preview = text.replace(/<[^>]*>/g, '').trim().slice(0, 80);
	console.log('[overlay]', preview);
	const el = document.getElementById('variable-content');
	if (el) {
		el.style.visibility = 'visible';
		el.style.animation = 'none';
		el.innerHTML = text;
	}
}

export function hideOverlay(): void {
	const el = document.getElementById('variable-content');
	if (el) { el.style.visibility = 'hidden'; el.style.animation = ''; }
	const controls = document.getElementById('controls');
	if (controls) controls.style.display = 'none';
}

// ─── Opponent score HUD ──────────────────────────────────────────

let opponentHudEl: HTMLElement | null = null;

export function updateOpponentHud(oppState: GameState): void {
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

export function removeOpponentHud(): void {
	if (opponentHudEl) {
		opponentHudEl.remove();
		opponentHudEl = null;
	}
}

// ─── Mid-match death banner ──────────────────────────────────────

let deathBannerEl: HTMLElement | null = null;

export function showDeathBanner(title: string, subtitle: string): void {
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

export function removeDeathBanner(): void {
	if (deathBannerEl) {
		deathBannerEl.remove();
		deathBannerEl = null;
	}
}

// ─── Touch controls (mobile) ─────────────────────────────────────

const SWIPE_THRESHOLD = 30;
const TAP_THRESHOLD_MS = 200;

/**
 * Install touch handlers for mobile. `onAction` is called with
 * the character action; `onStart` is called on tap when the game
 * hasn't started yet. Prevents scroll/zoom during gameplay.
 */
export function installTouchControls(opts: {
	onAction: (a: CharacterAction) => void;
	onStart: () => void;
	isPlaying: () => boolean;
}): void {
	let startX = 0;
	let startY = 0;
	let startTime = 0;

	// Prevent ALL touch scrolling/pull-to-refresh on the game page.
	// Without this, swiping near screen edges triggers browser navigation.
	document.addEventListener(
		'touchmove',
		(e) => { e.preventDefault(); },
		{ passive: false },
	);

	document.addEventListener(
		'touchstart',
		(e) => {
			if (!opts.isPlaying()) {
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
			} else if (absDy > absDx && dy > SWIPE_THRESHOLD) {
				opts.onAction('fire'); // swipe down = flamethrower
			} else if (absDx > absDy) {
				if (dx < -SWIPE_THRESHOLD) opts.onAction('left');
				else if (dx > SWIPE_THRESHOLD) opts.onAction('right');
			}
		},
		{ passive: true },
	);
}
