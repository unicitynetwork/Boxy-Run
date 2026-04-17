/**
 * Rematch flow — after a Bo1 match ends, clicking REMATCH sends a new
 * challenge to the opponent. They see ACCEPT/DECLINE; accept redirects
 * both sides to a fresh match with a new matchId.
 *
 * This exercises the post-match client state (WS stays open, URL
 * changes, new sim boots from new seed) which is easy to break when
 * the overlay rendering code evolves.
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

test('rematch: Bo3 → REMATCH preserves bestOf (regression for "rematch reset to Bo1" prod bug)', async ({ browser }) => {
	test.setTimeout(120_000);
	const server = await startServer();
	try {
		const base = `http://127.0.0.1:${server.port}`;
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const pageA = await ctxA.newPage();
		const pageB = await ctxB.newPage();
		pageA.on('pageerror', (e) => { throw new Error(`pageA JS error: ${e.message}`); });
		pageB.on('pageerror', (e) => { throw new Error(`pageB JS error: ${e.message}`); });

		await giveNametag(pageB, base, 'bo3r_bob');
		await pageB.goto(`${base}/challenge.html`);
		await expect(pageB.locator('#ws-dot.on')).toBeVisible({ timeout: 5000 });
		await pageB.waitForTimeout(300);

		await giveNametag(pageA, base, 'bo3r_alice');
		await pageA.goto(`${base}/challenge.html`);
		await expect(pageA.locator('#ws-dot.on')).toBeVisible({ timeout: 5000 });

		// Default is Bo3 — no need to set, but be explicit as documentation.
		await expect(pageA.locator('#bestof-input')).toHaveValue('3');

		await expect(pageA.locator('#online-count')).not.toHaveText('0 online', { timeout: 10_000 });
		await pageA.locator('.player-btn', { hasText: 'bo3r_bob' }).click();

		const navA = pageA.waitForURL(/dev\.html/, { timeout: 10_000 });
		const navB = pageB.waitForURL(/dev\.html/, { timeout: 10_000 });
		await pageB.locator('.challenge-incoming button', { hasText: 'Accept' }).click();
		await Promise.all([navA, navB]);

		// The initial redirect MUST already carry bestOf=3 — otherwise the
		// game bundle's `bestOf` parse defaults to 1 and rematch sends Bo1.
		expect(new URL(pageA.url()).searchParams.get('bestOf')).toBe('3');

		const origMatchId = new URL(pageA.url()).searchParams.get('matchId');

		await pageA.locator('button', { hasText: /^READY$/ }).click();
		await pageB.locator('button', { hasText: /^READY$/ }).click();

		// Play out the Bo3 (auto-die each game). Wait for the final SERIES overlay.
		await expect(pageA.getByText(/SERIES WIN!|SERIES LOSS/).first()).toBeVisible({ timeout: 80_000 });
		await expect(pageB.getByText(/SERIES WIN!|SERIES LOSS/).first()).toBeVisible({ timeout: 5_000 });

		// Click REMATCH and accept
		await pageA.locator('button', { hasText: 'REMATCH' }).click();
		await expect(pageB.locator('button', { hasText: /^ACCEPT$/ })).toBeVisible({ timeout: 10_000 });

		const newNavA = pageA.waitForURL((url) => {
			const m = new URL(url.toString()).searchParams.get('matchId');
			return !!m && m !== origMatchId;
		}, { timeout: 15_000 });
		const newNavB = pageB.waitForURL((url) => {
			const m = new URL(url.toString()).searchParams.get('matchId');
			return !!m && m !== origMatchId;
		}, { timeout: 15_000 });
		await pageB.locator('button', { hasText: /^ACCEPT$/ }).click();
		await Promise.all([newNavA, newNavB]);

		// The REAL assertion: the rematch must still be Bo3, not Bo1.
		expect(new URL(pageA.url()).searchParams.get('bestOf')).toBe('3');
		expect(new URL(pageB.url()).searchParams.get('bestOf')).toBe('3');

		await ctxA.close();
		await ctxB.close();
	} finally {
		await stopServer(server.proc);
	}
});

test('rematch: REMATCH → opponent sees ACCEPT → both go to new matchId', async ({ browser }) => {
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

		await giveNametag(pageB, base, 'rematch_bob');
		await pageB.goto(`${base}/challenge.html`);
		await expect(pageB.locator('#ws-dot.on')).toBeVisible({ timeout: 5000 });
		await pageB.waitForTimeout(300);

		await giveNametag(pageA, base, 'rematch_alice');
		await pageA.goto(`${base}/challenge.html`);
		await expect(pageA.locator('#ws-dot.on')).toBeVisible({ timeout: 5000 });

		// Force Bo1 so the match ends after a single game
		await pageA.locator('#bestof-input').selectOption('1');

		await expect(pageA.locator('#online-count')).not.toHaveText('0 online', { timeout: 10_000 });
		await pageA.locator('.player-btn', { hasText: 'rematch_bob' }).click();

		const navA = pageA.waitForURL(/dev\.html/, { timeout: 10_000 });
		const navB = pageB.waitForURL(/dev\.html/, { timeout: 10_000 });
		await pageB.locator('.challenge-incoming button', { hasText: 'Accept' }).click();
		await Promise.all([navA, navB]);

		const origMatchId = new URL(pageA.url()).searchParams.get('matchId');
		expect(origMatchId).toBeTruthy();

		await pageA.locator('button', { hasText: /^READY$/ }).click();
		await pageB.locator('button', { hasText: /^READY$/ }).click();

		// Game ends → both see result + REMATCH button
		await expect(pageA.getByText(/YOU WIN!|YOU LOSE/).first()).toBeVisible({ timeout: 45_000 });
		await expect(pageB.getByText(/YOU WIN!|YOU LOSE/).first()).toBeVisible({ timeout: 5_000 });
		await expect(pageA.locator('button', { hasText: 'REMATCH' })).toBeVisible();

		// Alice clicks REMATCH → sends a new challenge to bob
		await pageA.locator('button', { hasText: 'REMATCH' }).click();

		// Bob's overlay should flip from result-screen to "challenges you" +
		// ACCEPT button. The overlay text contains alice's nametag.
		await expect(pageB.locator('button', { hasText: /^ACCEPT$/ })).toBeVisible({ timeout: 10_000 });

		// Bob clicks ACCEPT → both pages navigate to a new matchId
		const newNavA = pageA.waitForURL((url) => {
			const m = new URL(url.toString()).searchParams.get('matchId');
			return !!m && m !== origMatchId;
		}, { timeout: 15_000 });
		const newNavB = pageB.waitForURL((url) => {
			const m = new URL(url.toString()).searchParams.get('matchId');
			return !!m && m !== origMatchId;
		}, { timeout: 15_000 });
		await pageB.locator('button', { hasText: /^ACCEPT$/ }).click();
		await Promise.all([newNavA, newNavB]);

		const newMatchId = new URL(pageA.url()).searchParams.get('matchId');
		expect(newMatchId).toBeTruthy();
		expect(newMatchId).not.toBe(origMatchId);

		// Fresh READY button on the new match
		await expect(pageA.locator('button', { hasText: /^READY$/ })).toBeVisible({ timeout: 15_000 });

		await ctxA.close();
		await ctxB.close();
	} finally {
		await stopServer(server.proc);
	}
});
