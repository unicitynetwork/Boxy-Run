/**
 * Challenge error UX — status toasts for the rejection paths.
 *
 * Covers the client rendering for server-enforced rules:
 *  - wager exceeds balance → red status toast
 *  - challenge times out after 30s → "declined" status on challenger
 *
 * These are rarer paths that don't affect the happy path but must still
 * communicate clearly. If a client silently eats the error the user is
 * left wondering why nothing happened.
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

test('challenge error: wager > balance → red "Insufficient balance" status', async ({ browser }) => {
	const server = await startServer();
	try {
		const base = `http://127.0.0.1:${server.port}`;

		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const pageA = await ctxA.newPage();
		const pageB = await ctxB.newPage();

		pageA.on('pageerror', (e) => { throw new Error(`pageA JS error: ${e.message}`); });

		await giveNametag(pageB, base, 'err_bob');
		await pageB.goto(`${base}/challenge.html`);
		await expect(pageB.locator('#ws-dot.on')).toBeVisible({ timeout: 5000 });
		await pageB.waitForTimeout(300);

		await giveNametag(pageA, base, 'err_alice');
		await pageA.goto(`${base}/challenge.html`);
		await expect(pageA.locator('#ws-dot.on')).toBeVisible({ timeout: 5000 });

		// Set a wager way above alice's (0) balance
		await pageA.locator('#wager-input').fill('500');

		await expect(pageA.locator('#online-count')).not.toHaveText('0 online', { timeout: 10_000 });
		await pageA.locator('.player-btn', { hasText: 'err_bob' }).click();

		// The page must show a visible error in #challenge-status, not navigate away
		const status = pageA.locator('#challenge-status');
		await expect(status).toBeVisible({ timeout: 5000 });
		await expect(status).toContainText(/insufficient|balance/i);

		// Confirm we did NOT redirect to dev.html
		expect(pageA.url()).toContain('challenge.html');

		await ctxA.close();
		await ctxB.close();
	} finally {
		await stopServer(server.proc);
	}
});

test('challenge expired: 30s without accept → challenger notified via "declined" status', async ({ browser }) => {
	const server = await startServer();
	try {
		const base = `http://127.0.0.1:${server.port}`;

		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const pageA = await ctxA.newPage();
		const pageB = await ctxB.newPage();

		pageA.on('pageerror', (e) => { throw new Error(`pageA JS error: ${e.message}`); });
		pageB.on('pageerror', (e) => { throw new Error(`pageB JS error: ${e.message}`); });

		await giveNametag(pageB, base, 'exp_bob');
		await pageB.goto(`${base}/challenge.html`);
		await expect(pageB.locator('#ws-dot.on')).toBeVisible({ timeout: 5000 });
		await pageB.waitForTimeout(300);

		await giveNametag(pageA, base, 'exp_alice');
		await pageA.goto(`${base}/challenge.html`);
		await expect(pageA.locator('#ws-dot.on')).toBeVisible({ timeout: 5000 });

		await expect(pageA.locator('#online-count')).not.toHaveText('0 online', { timeout: 10_000 });
		await pageA.locator('.player-btn', { hasText: 'exp_bob' }).click();

		// Bob sees the incoming invite
		await expect(pageB.locator('.challenge-incoming')).toBeVisible({ timeout: 5000 });

		// Advance clock past the 30s challenge TTL. Server's reconcile tick
		// (1s) will fire reconcileChallenges and send challenge-declined to
		// alice. Give it a beat to land.
		await advanceClock(server, 35_000);
		await pageA.waitForTimeout(1500);

		// Alice's status toast should show the expiry notice
		const status = pageA.locator('#challenge-status');
		await expect(status).toBeVisible({ timeout: 5000 });
		await expect(status).toContainText(/expired|declined/i);

		// Bob's incoming banner should disappear too
		await expect(pageB.locator('.challenge-incoming')).toHaveCount(0, { timeout: 5000 });

		await ctxA.close();
		await ctxB.close();
	} finally {
		await stopServer(server.proc);
	}
});
