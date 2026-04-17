/**
 * Smoke test — confirms the local test server starts, static files are
 * served, and tournament-v2.html renders its list without JS errors.
 *
 * If this test fails, something fundamental is wrong. Fix it before
 * investigating any other browser test.
 */

import { test, expect } from '@playwright/test';
import { startServer, stopServer, api } from '../tests/harness';

test.describe.configure({ mode: 'serial' });

test('tournament-v2.html loads the list view', async ({ page }) => {
	const server = await startServer();
	try {
		// Seed at least one tournament so the list has content to render
		await api(server, '/api/tournaments', {
			method: 'POST',
			asAdmin: true,
			body: {
				id: 'smoke-1',
				name: 'Smoke Test Tournament',
				maxPlayers: 8,
				startsAt: new Date(Date.now() + 3600000).toISOString(),
			},
		});

		const base = `http://127.0.0.1:${server.port}`;

		// Capture JS errors — any uncaught exception fails the test
		const jsErrors: string[] = [];
		page.on('pageerror', (err) => jsErrors.push(err.message));

		await page.goto(`${base}/tournament-v2.html`);

		// The "Loading..." placeholder should be replaced by the tournament card
		const card = page.locator('.tourney-card').first();
		await expect(card).toBeVisible({ timeout: 5000 });
		await expect(card).toContainText('Smoke Test Tournament');

		expect(jsErrors, `unexpected JS errors: ${jsErrors.join(', ')}`).toHaveLength(0);
	} finally {
		await stopServer(server.proc);
	}
});

test('index.html loads without JS errors', async ({ page }) => {
	const server = await startServer();
	try {
		const base = `http://127.0.0.1:${server.port}`;
		const jsErrors: string[] = [];
		page.on('pageerror', (err) => jsErrors.push(err.message));
		await page.goto(base);
		// Settle a moment for any lazy bundles
		await page.waitForLoadState('networkidle');
		expect(jsErrors, `unexpected JS errors: ${jsErrors.join(', ')}`).toHaveLength(0);
	} finally {
		await stopServer(server.proc);
	}
});
