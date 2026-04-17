/**
 * Challenge → READY → countdown — end-to-end in two browser contexts.
 *
 * REGRESSION TEST. The state-machine refactor once shipped a bug where
 * `seedFromChallenge` set the new MatchState to phase='playing' with
 * both players pre-marked ready. Clients still need to click READY to
 * unlock audio, but that ready event was a no-op in 'playing' phase
 * (by reducer construction). No match-status broadcast → both clients
 * stuck on "Waiting for opponent…" until the 30s ready-TTL expired.
 *
 * The server-side test (`challenge.test.ts` "REGRESSION — accepted
 * challenge starts in awaiting_ready") proves the machine state is
 * correct. This test proves the full client/server loop produces the
 * countdown overlay — the symptom users actually see.
 */

import { test, expect } from '@playwright/test';
import { startServer, stopServer } from '../tests/harness';

test.describe.configure({ mode: 'serial' });

async function giveNametag(page: any, base: string, nametag: string) {
	await page.goto(base);
	await page.evaluate((n: string) => {
		localStorage.setItem('boxyrun-nametag', n);
		// Skip the skin selector overlay — fresh contexts have no skin saved
		localStorage.setItem('boxyrun-skin', 'Classic');
	}, nametag);
}

test('challenge: both click READY → GET READY countdown appears', async ({ browser }) => {
	const server = await startServer();
	try {
		const base = `http://127.0.0.1:${server.port}`;

		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const pageA = await ctxA.newPage();
		const pageB = await ctxB.newPage();

		// Surface uncaught JS errors from the game bundle as test failures
		pageA.on('pageerror', (e) => { throw new Error(`pageA JS error: ${e.message}`); });
		pageB.on('pageerror', (e) => { throw new Error(`pageB JS error: ${e.message}`); });

		// Bring B online first so A's player list includes B
		await giveNametag(pageB, base, 'ready_bob');
		await pageB.goto(`${base}/challenge.html`);
		await expect(pageB.locator('#ws-dot.on')).toBeVisible({ timeout: 5000 });
		await pageB.waitForTimeout(300);

		await giveNametag(pageA, base, 'ready_alice');
		await pageA.goto(`${base}/challenge.html`);
		await expect(pageA.locator('#ws-dot.on')).toBeVisible({ timeout: 5000 });

		await expect(pageA.locator('#online-count')).not.toHaveText('0 online', { timeout: 10_000 });
		await pageA.locator('.player-btn', { hasText: 'ready_bob' }).click();

		// Bob accepts
		const navA = pageA.waitForURL(/dev\.html/, { timeout: 10_000 });
		const navB = pageB.waitForURL(/dev\.html/, { timeout: 10_000 });
		await pageB.locator('.challenge-incoming button', { hasText: 'Accept' }).click();
		await Promise.all([navA, navB]);

		// dev.html loads game.js which renders the "vs <opponent> [READY]" overlay.
		// Wait for the READY button on each side.
		const readyA = pageA.locator('button', { hasText: /^READY$/ });
		const readyB = pageB.locator('button', { hasText: /^READY$/ });
		await expect(readyA).toBeVisible({ timeout: 15_000 });
		await expect(readyB).toBeVisible({ timeout: 15_000 });

		// Both click READY. With the bug, the second click never causes the
		// machine to emit `broadcast_status` with both ready — the overlay
		// stays on "Waiting for opponent…" until the 30s TTL.
		await readyA.click();
		await readyB.click();

		// The "GET READY" countdown is the proof the machine transitioned to
		// 'playing' and both clients observed match-status with both ready.
		// 5s window: the countdown is 3s and we want to catch it before it
		// turns into the in-game state.
		await expect(pageA.locator('text=GET READY')).toBeVisible({ timeout: 5000 });
		await expect(pageB.locator('text=GET READY')).toBeVisible({ timeout: 5000 });

		await ctxA.close();
		await ctxB.close();
	} finally {
		await stopServer(server.proc);
	}
});
