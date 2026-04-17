/**
 * Challenge flow — end-to-end in two browser contexts.
 *
 * Opens challenge.html for player A and player B (separate contexts so
 * they don't share localStorage). A challenges B; B accepts; both
 * navigate to dev.html?matchId=...
 *
 * Relies on the Sphere-wallet-absent fallback: both pages pick up the
 * nametag from localStorage set before load.
 */

import { test, expect } from '@playwright/test';
import { startServer, stopServer, api } from '../tests/harness';

test.describe.configure({ mode: 'serial' });

async function giveNametag(page: any, base: string, nametag: string) {
	// Seed localStorage before any inline <script> executes.
	await page.goto(base);
	await page.evaluate((n: string) => localStorage.setItem('boxyrun-nametag', n), nametag);
}

test('challenge: A sends → B accepts → both redirected to game', async ({ browser }) => {
	const server = await startServer();
	try {
		const base = `http://127.0.0.1:${server.port}`;

		// Two independent browser contexts = independent localStorage
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const pageA = await ctxA.newPage();
		const pageB = await ctxB.newPage();

		// Surface any uncaught JS errors as test failures
		pageA.on('pageerror', (e) => { throw new Error(`pageA JS error: ${e.message}`); });
		pageB.on('pageerror', (e) => { throw new Error(`pageB JS error: ${e.message}`); });

		// Bring B online FIRST so A's `registered` push includes B in onlinePlayers
		await giveNametag(pageB, base, 'bob_e2e');
		await pageB.goto(`${base}/challenge.html`);
		await expect(pageB.locator('#ws-dot.on')).toBeVisible({ timeout: 5000 });
		// Small settle for register to reach the server
		await pageB.waitForTimeout(300);

		await giveNametag(pageA, base, 'alice_e2e');
		await pageA.goto(`${base}/challenge.html`);
		await expect(pageA.locator('#ws-dot.on')).toBeVisible({ timeout: 5000 });

		// Wait for the online-count to show at least 1 (bob is visible to alice)
		await expect(pageA.locator('#online-count')).not.toHaveText('0 online', { timeout: 10_000 });
		const bobBtn = pageA.locator('.player-btn', { hasText: 'bob_e2e' });
		await expect(bobBtn).toBeVisible({ timeout: 5000 });
		await bobBtn.click();

		// Page B should show an incoming challenge banner with an Accept button
		const acceptBtn = pageB.locator('.challenge-incoming button', { hasText: 'Accept' });
		await expect(acceptBtn).toBeVisible({ timeout: 5000 });

		// When bob accepts, both should be redirected to dev.html
		const navA = pageA.waitForURL(/dev\.html/, { timeout: 10_000 });
		const navB = pageB.waitForURL(/dev\.html/, { timeout: 10_000 });
		await acceptBtn.click();
		await Promise.all([navA, navB]);

		// Both URLs should have the same matchId
		const urlA = new URL(pageA.url());
		const urlB = new URL(pageB.url());
		expect(urlA.searchParams.get('matchId')).toBeTruthy();
		expect(urlA.searchParams.get('matchId')).toBe(urlB.searchParams.get('matchId'));

		// Sides should be complementary
		expect(new Set([urlA.searchParams.get('side'), urlB.searchParams.get('side')]))
			.toEqual(new Set(['A', 'B']));

		await ctxA.close();
		await ctxB.close();
	} finally {
		await stopServer(server.proc);
	}
});

test('challenge: decline removes the invitation UI', async ({ browser }) => {
	const server = await startServer();
	try {
		const base = `http://127.0.0.1:${server.port}`;
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const pageA = await ctxA.newPage();
		const pageB = await ctxB.newPage();

		await giveNametag(pageB, base, 'dave_e2e');
		await pageB.goto(`${base}/challenge.html`);
		await expect(pageB.locator('#ws-dot.on')).toBeVisible({ timeout: 5000 });

		await giveNametag(pageA, base, 'carol_e2e');
		await pageA.goto(`${base}/challenge.html`);
		await expect(pageA.locator('#ws-dot.on')).toBeVisible({ timeout: 5000 });

		await expect(pageA.locator('#online-count')).not.toHaveText('0 online', { timeout: 10_000 });
		const daveBtn = pageA.locator('.player-btn', { hasText: 'dave_e2e' });
		await expect(daveBtn).toBeVisible({ timeout: 5000 });
		await daveBtn.click();

		const declineBtn = pageB.locator('.challenge-incoming button', { hasText: 'Decline' });
		await expect(declineBtn).toBeVisible({ timeout: 5000 });
		await declineBtn.click();

		// Banner should disappear
		await expect(pageB.locator('.challenge-incoming')).toHaveCount(0);

		// Carol's status shows the decline
		await expect(pageA.locator('#challenge-status'))
			.toContainText(/declined/i, { timeout: 5000 });

		await ctxA.close();
		await ctxB.close();
	} finally {
		await stopServer(server.proc);
	}
});
