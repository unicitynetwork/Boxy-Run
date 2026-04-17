/**
 * Wallet/cache desync regression test.
 *
 * Production bug: index.html showed `mike_agent1 [Disconnect]` in the
 * header (because localStorage had a cached nametag) while the wallet
 * panel said "Wallet not connected. Click Connect first." — clicking
 * Transfer silently failed because `SphereWallet.isConnected` was
 * actually false.
 *
 * Two truths drifted: header read localStorage, transfer read wallet
 * state. The fix ties the header to the live wallet, falling back to
 * a "disconnected" UI after a short grace if the wallet never connects.
 *
 * This test pre-seeds localStorage with a cached nametag, loads
 * index.html with NO wallet SDK present, and asserts the page lands in
 * the "disconnected" state instead of the misleading "connected" UI.
 */

import { test, expect } from '@playwright/test';
import { startServer, stopServer } from '../tests/harness';

test.describe.configure({ mode: 'serial' });

test('index.html: cached nametag without wallet → disconnected after grace', async ({ browser }) => {
	const server = await startServer();
	try {
		const base = `http://127.0.0.1:${server.port}`;
		const ctx = await browser.newContext();
		const page = await ctx.newPage();

		// Pre-seed: cached nametag from a previous session, but the page
		// will load WITHOUT the wallet SDK actually connecting (the SDK
		// loads but Sphere is unavailable in headless chromium → never
		// reaches isConnected=true).
		await page.goto(base);
		await page.evaluate(() => {
			localStorage.setItem('boxyrun-nametag', 'stale_alice');
		});

		await page.goto(base);

		// Initially the page may show "connected" (cached) or "detecting".
		// After the 4s grace window the desync should be detected and the
		// header should flip to disconnected.
		const idDisconnected = page.locator('#id-disconnected');
		await expect(idDisconnected).toBeVisible({ timeout: 8_000 });

		// The "connected" header bar should be hidden — no misleading
		// `[Disconnect]` button next to a cached nametag.
		const idConnected = page.locator('#id-connected');
		await expect(idConnected).toBeHidden();

		// And the balance card with the broken Transfer button should be
		// hidden too — preventing the user from clicking Transfer and
		// seeing "Wallet not connected. Click Connect first."
		await expect(page.locator('#balance-card')).toBeHidden();

		await ctx.close();
	} finally {
		await stopServer(server.proc);
	}
});
