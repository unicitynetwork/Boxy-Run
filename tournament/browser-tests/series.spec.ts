/**
 * Bo3 series flow — game-result between games + auto-advance to game 2
 * + SERIES WIN/LOSS on final. Runs two games back-to-back without a
 * full navigation (game 2 resets in-place to keep AudioContext alive).
 *
 * This is the class of bug where "game 2 never starts" shipped
 * historically — the browser is the only layer that verifies the
 * series-next reset UX actually unhangs game 1 and enters game 2.
 */

import { test, expect } from '@playwright/test';
import { startServer, stopServer } from '../tests/harness';

test.describe.configure({ mode: 'serial' });

async function giveNametag(page: any, base: string, nametag: string) {
	await page.goto(base);
	await page.evaluate((n: string) => {
		localStorage.setItem('boxyrun-nametag', n);
		localStorage.setItem('boxyrun-skin', 'Classic');
	}, nametag);
}

test('series: Bo3 runs two games → SERIES WIN/LOSS overlay', async ({ browser }) => {
	test.setTimeout(90_000);
	const server = await startServer();
	try {
		const base = `http://127.0.0.1:${server.port}`;

		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const pageA = await ctxA.newPage();
		const pageB = await ctxB.newPage();

		pageA.on('pageerror', (e) => { throw new Error(`pageA JS error: ${e.message}`); });
		pageB.on('pageerror', (e) => { throw new Error(`pageB JS error: ${e.message}`); });

		await giveNametag(pageB, base, 'series_bob');
		await pageB.goto(`${base}/challenge.html`);
		await expect(pageB.locator('#ws-dot.on')).toBeVisible({ timeout: 5000 });
		await pageB.waitForTimeout(300);

		await giveNametag(pageA, base, 'series_alice');
		await pageA.goto(`${base}/challenge.html`);
		await expect(pageA.locator('#ws-dot.on')).toBeVisible({ timeout: 5000 });

		// Default is Bo3 — confirm to prevent future regressions if default changes
		await expect(pageA.locator('#bestof-input')).toHaveValue('3');

		await expect(pageA.locator('#online-count')).not.toHaveText('0 online', { timeout: 10_000 });
		await pageA.locator('.player-btn', { hasText: 'series_bob' }).click();

		const navA = pageA.waitForURL(/dev\.html/, { timeout: 10_000 });
		const navB = pageB.waitForURL(/dev\.html/, { timeout: 10_000 });
		await pageB.locator('.challenge-incoming button', { hasText: 'Accept' }).click();
		await Promise.all([navA, navB]);

		await expect(pageA.locator('button', { hasText: /^READY$/ })).toBeVisible({ timeout: 15_000 });
		await expect(pageB.locator('button', { hasText: /^READY$/ })).toBeVisible({ timeout: 15_000 });
		await pageA.locator('button', { hasText: /^READY$/ }).click();
		await pageB.locator('button', { hasText: /^READY$/ }).click();

		// Game 1 ends → either a "Game 1: WIN/LOSS" interim overlay or straight
		// into the next game. Wait for the game 2 start (either series-next
		// overlay or the in-game state for game 2). Simplest: wait for the
		// final SERIES overlay with a generous budget for two games.
		//
		// Sanity check: at some point a series-scoreboard should appear.
		// Game 1 ending shows "Game 1: WIN"/"LOSS" (isSeriesEnd=false, bestOf>1
		// → interim branch). Accept either form.
		await expect(pageA.getByText(/Game 1:|SERIES/).first()).toBeVisible({ timeout: 45_000 });

		// Eventually the series ends with SERIES WIN or SERIES LOSS on each side.
		await expect(pageA.getByText(/SERIES WIN!|SERIES LOSS/).first()).toBeVisible({ timeout: 60_000 });
		await expect(pageB.getByText(/SERIES WIN!|SERIES LOSS/).first()).toBeVisible({ timeout: 5000 });

		// Exactly one of (A wins, B wins) — never both the same label.
		const aWon = await pageA.getByText('SERIES WIN!').isVisible();
		const bWon = await pageB.getByText('SERIES WIN!').isVisible();
		expect(aWon !== bWon).toBeTruthy();

		await ctxA.close();
		await ctxB.close();
	} finally {
		await stopServer(server.proc);
	}
});
