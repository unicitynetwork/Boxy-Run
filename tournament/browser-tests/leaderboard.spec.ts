/**
 * Leaderboard page — loads without JS errors and both tables render.
 *
 * The page fetches /api/leaderboard/alltime + /api/leaderboard/daily.
 * If a backend change breaks the shape the page expects, this test
 * will catch it at render time.
 */

import { test, expect } from '@playwright/test';
import { startServer, stopServer } from '../tests/harness';

test.describe.configure({ mode: 'serial' });

test('leaderboard: loads with empty DB → "No scores yet" placeholders', async ({ page }) => {
	const server = await startServer();
	try {
		const base = `http://127.0.0.1:${server.port}`;
		const jsErrors: string[] = [];
		page.on('pageerror', (err) => jsErrors.push(err.message));

		await page.goto(`${base}/leaderboard.html`);

		// Both sections should replace their "Loading..." spinner with a
		// terminal state (either table rows or "No scores yet").
		const alltime = page.locator('#alltime-content');
		const daily = page.locator('#daily-content');
		await expect(alltime).not.toContainText('Loading...', { timeout: 10_000 });
		await expect(daily).not.toContainText('Loading...', { timeout: 10_000 });

		// Empty DB → "No scores yet" placeholder on both.
		await expect(alltime).toContainText(/No scores yet/i);
		await expect(daily).toContainText(/No scores/i);

		expect(jsErrors, `unexpected JS errors: ${jsErrors.join(', ')}`).toHaveLength(0);
	} finally {
		await stopServer(server.proc);
	}
});
