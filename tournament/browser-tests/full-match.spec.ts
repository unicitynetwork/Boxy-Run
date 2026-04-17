/**
 * Full Bo3 match — two real browser pages play through challenge →
 * ready → countdown → gameplay → result → series-next → repeat.
 *
 * Tests every phase transition in the client state machine:
 *   ready_prompt → waiting → countdown → playing → done_sent → game_result → ready_prompt → ... → series_end
 *
 * Uses keyboard automation to send real inputs (jump = ArrowUp). Both
 * players play until one dies, then the other keeps running. Server
 * replays and the result overlay should appear on both sides.
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { startServer, stopServer } from '../tests/harness';

test.describe.configure({ mode: 'serial' });

async function giveNametag(page: Page, base: string, nametag: string) {
	await page.goto(base);
	await page.evaluate((n: string) => localStorage.setItem('boxyrun-nametag', n), nametag);
}

/** Wait for a phase transition by watching the [phase] console log. */
function waitForPhase(page: Page, targetPhase: string, timeout = 15_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout waiting for phase ${targetPhase}`)), timeout);
		const handler = (msg: any) => {
			const text = msg.text();
			if (text.includes(`→ ${targetPhase}`)) {
				clearTimeout(timer);
				page.off('console', handler);
				resolve();
			}
		};
		// Also check if already in target phase
		page.evaluate((p: string) => (window as any).__currentPhase === p, targetPhase)
			.then((already) => { if (already) { clearTimeout(timer); page.off('console', handler); resolve(); } });
		page.on('console', handler);
	});
}

/** Press ArrowUp periodically to keep the character alive. */
function startAutoJump(page: Page): NodeJS.Timeout {
	return setInterval(async () => {
		try { await page.keyboard.press('ArrowUp'); } catch {}
	}, 800);
}

test('full Bo3 challenge: both players play through all games to series_end', async ({ browser }) => {
	const server = await startServer();
	try {
		const base = `http://127.0.0.1:${server.port}`;

		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const pageA = await ctxA.newPage();
		const pageB = await ctxB.newPage();

		// Log console for debugging
		const logsA: string[] = [];
		const logsB: string[] = [];
		pageA.on('console', (m) => logsA.push(m.text()));
		pageB.on('console', (m) => logsB.push(m.text()));

		// ── Setup: both on challenge page ───────────────────────────
		await giveNametag(pageB, base, 'p2_test');
		await pageB.goto(`${base}/challenge.html`);
		await expect(pageB.locator('#ws-dot.on')).toBeVisible({ timeout: 5000 });
		await pageB.waitForTimeout(300);

		await giveNametag(pageA, base, 'p1_test');
		await pageA.goto(`${base}/challenge.html`);
		await expect(pageA.locator('#ws-dot.on')).toBeVisible({ timeout: 5000 });

		// Set bestOf to 3
		await pageA.selectOption('#bestof-input', '3');

		// A challenges B
		await expect(pageA.locator('#online-count')).not.toHaveText('0 online', { timeout: 10_000 });
		const p2Btn = pageA.locator('.player-btn', { hasText: 'p2_test' });
		await expect(p2Btn).toBeVisible({ timeout: 5000 });
		await p2Btn.click();

		// B accepts
		const acceptBtn = pageB.locator('.challenge-incoming button', { hasText: 'Accept' });
		await expect(acceptBtn).toBeVisible({ timeout: 5000 });
		const navA = pageA.waitForURL(/dev\.html/, { timeout: 10_000 });
		const navB = pageB.waitForURL(/dev\.html/, { timeout: 10_000 });
		await acceptBtn.click();
		await Promise.all([navA, navB]);

		// ── Game page loaded — pick skin first ───────────────────────
		// Skin selector overlay (#skin-selector) shows before the match.
		const skinA = pageA.locator('#skin-selector button').first();
		const skinB = pageB.locator('#skin-selector button').first();
		await expect(skinA).toBeVisible({ timeout: 5000 });
		await expect(skinB).toBeVisible({ timeout: 5000 });
		await skinA.click();
		await skinB.click();

		// Now READY button should appear
		const readyA = pageA.locator('button', { hasText: 'READY' });
		const readyB = pageB.locator('button', { hasText: 'READY' });
		await expect(readyA).toBeVisible({ timeout: 5000 });
		await expect(readyB).toBeVisible({ timeout: 5000 });
		await readyA.click();
		await readyB.click();

		// Both should reach 'playing' phase (through countdown)
		await waitForPhase(pageA, 'playing', 10_000);
		await waitForPhase(pageB, 'playing', 10_000);

		// ── Game 1: auto-jump to play ──────────────────────────────
		const jumpA = startAutoJump(pageA);
		const jumpB = startAutoJump(pageB);

		// Wait for game 1 to end (one player dies → done_sent → server resolves)
		// Either game_result (interim) or series_end (if someone somehow wins 2-0 instantly)
		const g1A = waitForPhase(pageA, 'game_result', 60_000);
		const g1B = waitForPhase(pageB, 'game_result', 60_000);
		await Promise.all([g1A, g1B]);
		clearInterval(jumpA);
		clearInterval(jumpB);

		// Both should show game result overlay with "Game 1" text
		await expect(pageA.locator('#overlay')).toContainText('Game', { timeout: 3000 });
		await expect(pageB.locator('#overlay')).toContainText('Game', { timeout: 3000 });

		// ── Game 2: should auto-transition via series-next ──────────
		// Wait for ready_prompt (series-next resets)
		await waitForPhase(pageA, 'ready_prompt', 15_000);
		await waitForPhase(pageB, 'ready_prompt', 15_000);

		// Auto-ready should fire (beginGame(false)). Wait for playing.
		await waitForPhase(pageA, 'playing', 15_000);
		await waitForPhase(pageB, 'playing', 15_000);

		const jump2A = startAutoJump(pageA);
		const jump2B = startAutoJump(pageB);

		// Wait for game 2 result
		const g2A = waitForPhase(pageA, 'game_result', 60_000);
		const g2B = waitForPhase(pageB, 'game_result', 60_000);

		// Game 2 could end the series (2-0) or need game 3.
		// If series_end fires first, that's also fine.
		const result2A = await Promise.race([
			g2A.then(() => 'game_result' as const),
			waitForPhase(pageA, 'series_end', 60_000).then(() => 'series_end' as const),
		]);
		clearInterval(jump2A);
		clearInterval(jump2B);

		if (result2A === 'series_end') {
			// 2-0 sweep — series over after game 2
			await expect(pageA.locator('#overlay')).toContainText(/WIN|LOSS/, { timeout: 5000 });
			await expect(pageB.locator('#overlay')).toContainText(/WIN|LOSS/, { timeout: 5000 });
		} else {
			// 1-1, need game 3
			await waitForPhase(pageB, 'game_result', 15_000);

			// ── Game 3 ─────────────────────────────────────────────
			await waitForPhase(pageA, 'ready_prompt', 15_000);
			await waitForPhase(pageA, 'playing', 15_000);
			await waitForPhase(pageB, 'playing', 15_000);

			const jump3A = startAutoJump(pageA);
			const jump3B = startAutoJump(pageB);

			// Game 3 must end in series_end
			await waitForPhase(pageA, 'series_end', 60_000);
			await waitForPhase(pageB, 'series_end', 60_000);
			clearInterval(jump3A);
			clearInterval(jump3B);

			await expect(pageA.locator('#overlay')).toContainText(/WIN|LOSS/, { timeout: 5000 });
			await expect(pageB.locator('#overlay')).toContainText(/WIN|LOSS/, { timeout: 5000 });
		}

		// Verify one player won and the other lost
		const overlayA = await pageA.locator('#overlay').textContent();
		const overlayB = await pageB.locator('#overlay').textContent();
		const aWon = overlayA?.includes('WIN');
		const bWon = overlayB?.includes('WIN');
		expect(aWon !== bWon).toBe(true); // exactly one winner

		await ctxA.close();
		await ctxB.close();
	} finally {
		await stopServer(server.proc);
	}
});
