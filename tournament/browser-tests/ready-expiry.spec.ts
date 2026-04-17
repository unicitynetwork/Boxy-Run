/**
 * Ready expiry UX — alice readies, bob never does, 30s TTL elapses.
 *
 * Alice's page should transition from "Waiting for opponent…" to the
 * "Ready expired" overlay with a fresh READY button. Uses the fake
 * clock to skip the real 30s wait.
 */

import { test, expect } from '@playwright/test';
import { startServer, stopServer, advanceClock } from '../tests/harness';

test.describe.configure({ mode: 'serial' });

async function giveNametag(page: any, base: string, nametag: string) {
	await page.goto(base);
	await page.evaluate((n: string) => {
		localStorage.setItem('boxyrun-nametag', n);
		localStorage.setItem('boxyrun-skin', 'Classic');
	}, nametag);
}

test('ready expiry: one-sided ready → 30s → "Ready expired" overlay + re-READY button', async ({ browser }) => {
	const server = await startServer();
	try {
		const base = `http://127.0.0.1:${server.port}`;

		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const pageA = await ctxA.newPage();
		const pageB = await ctxB.newPage();

		pageA.on('pageerror', (e) => { throw new Error(`pageA JS error: ${e.message}`); });
		pageB.on('pageerror', (e) => { throw new Error(`pageB JS error: ${e.message}`); });

		// Bring bob online first so alice can challenge him
		await giveNametag(pageB, base, 'expiry_bob');
		await pageB.goto(`${base}/challenge.html`);
		await expect(pageB.locator('#ws-dot.on')).toBeVisible({ timeout: 5000 });
		await pageB.waitForTimeout(300);

		await giveNametag(pageA, base, 'expiry_alice');
		await pageA.goto(`${base}/challenge.html`);
		await expect(pageA.locator('#ws-dot.on')).toBeVisible({ timeout: 5000 });

		await expect(pageA.locator('#online-count')).not.toHaveText('0 online', { timeout: 10_000 });
		await pageA.locator('.player-btn', { hasText: 'expiry_bob' }).click();

		const navA = pageA.waitForURL(/dev\.html/, { timeout: 10_000 });
		const navB = pageB.waitForURL(/dev\.html/, { timeout: 10_000 });
		await pageB.locator('.challenge-incoming button', { hasText: 'Accept' }).click();
		await Promise.all([navA, navB]);

		// Only alice clicks READY — bob stays on the READY screen.
		const readyA = pageA.locator('button', { hasText: /^READY$/ });
		await expect(readyA).toBeVisible({ timeout: 15_000 });
		await readyA.click();

		// Alice should now show the "Waiting for opponent" overlay.
		await expect(pageA.locator('text=Waiting for opponent')).toBeVisible({ timeout: 5000 });

		// Jump past the 30s ready TTL. The 1s reconciler tick should then
		// emit match-status with both flags false on the next real-time tick.
		await advanceClock(server, 35_000);
		await pageA.waitForTimeout(1500);

		// Alice sees "Ready expired" and a fresh READY button.
		await expect(pageA.locator('text=Ready expired')).toBeVisible({ timeout: 5000 });
		await expect(pageA.locator('button', { hasText: /^READY$/ })).toBeVisible({ timeout: 2000 });

		await ctxA.close();
		await ctxB.close();
	} finally {
		await stopServer(server.proc);
	}
});
