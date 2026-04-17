/**
 * Match-end rendering — both sims run from the same seed with no input,
 * both die on an obstacle, server replays, client shows YOU WIN / YOU LOSE
 * and a REMATCH button (challenge flow).
 *
 * Relies on deterministic sim: same seed + no input → both die at the
 * same tick. Tiebreak is server-side; whichever side the server picks,
 * one client sees "YOU WIN!" and the other "YOU LOSE".
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

test('match-end: Bo1 single game → YOU WIN/LOSE overlay + REMATCH button', async ({ browser }) => {
	test.setTimeout(60_000);
	const server = await startServer();
	try {
		const base = `http://127.0.0.1:${server.port}`;

		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const pageA = await ctxA.newPage();
		const pageB = await ctxB.newPage();

		pageA.on('pageerror', (e) => { throw new Error(`pageA JS error: ${e.message}`); });
		pageB.on('pageerror', (e) => { throw new Error(`pageB JS error: ${e.message}`); });

		// Bring bob online first
		await giveNametag(pageB, base, 'end_bob');
		await pageB.goto(`${base}/challenge.html`);
		await expect(pageB.locator('#ws-dot.on')).toBeVisible({ timeout: 5000 });
		await pageB.waitForTimeout(300);

		await giveNametag(pageA, base, 'end_alice');
		await pageA.goto(`${base}/challenge.html`);
		await expect(pageA.locator('#ws-dot.on')).toBeVisible({ timeout: 5000 });

		// The default on challenge.html is Bo3 — force Bo1 so this test stays
		// focused on single-game match-end rendering.
		await pageA.locator('#bestof-input').selectOption('1');

		await expect(pageA.locator('#online-count')).not.toHaveText('0 online', { timeout: 10_000 });
		await pageA.locator('.player-btn', { hasText: 'end_bob' }).click();

		const navA = pageA.waitForURL(/dev\.html/, { timeout: 10_000 });
		const navB = pageB.waitForURL(/dev\.html/, { timeout: 10_000 });
		await pageB.locator('.challenge-incoming button', { hasText: 'Accept' }).click();
		await Promise.all([navA, navB]);

		// Both click READY
		await expect(pageA.locator('button', { hasText: /^READY$/ })).toBeVisible({ timeout: 15_000 });
		await expect(pageB.locator('button', { hasText: /^READY$/ })).toBeVisible({ timeout: 15_000 });
		await pageA.locator('button', { hasText: /^READY$/ }).click();
		await pageB.locator('button', { hasText: /^READY$/ }).click();

		// Countdown → game starts → both sims run with no input → both crash
		// into the first obstacle at the same deterministic tick. The server
		// then replays, determines the winner (tiebreak by rule), and pushes
		// match-end to both sides.
		//
		// Each client shows either "YOU WIN!" or "YOU LOSE" depending on the
		// server's tiebreak. Accept either outcome per side; the key invariant
		// is that BOTH see a terminal result (not a hung game).
		// Playwright's text= doesn't do regex alternation; use getByText with RegExp.
		await expect(pageA.getByText(/YOU WIN!|YOU LOSE/).first()).toBeVisible({ timeout: 45_000 });
		await expect(pageB.getByText(/YOU WIN!|YOU LOSE/).first()).toBeVisible({ timeout: 45_000 });

		// Challenge flow → REMATCH button should be present on the overlay.
		await expect(pageA.locator('button', { hasText: 'REMATCH' })).toBeVisible({ timeout: 2000 });
		await expect(pageB.locator('button', { hasText: 'REMATCH' })).toBeVisible({ timeout: 2000 });

		await ctxA.close();
		await ctxB.close();
	} finally {
		await stopServer(server.proc);
	}
});
