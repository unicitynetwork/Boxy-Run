/**
 * tournament-v2.html — registration + bracket rendering.
 *
 * Covers the other entry point (not challenges). A user lands on the
 * detail page via ?id=xxx, the registration section is visible,
 * clicking Register adds them to the list, and once the tournament
 * starts we see a bracket with match cards.
 */

import { test, expect } from '@playwright/test';
import { startServer, stopServer, api, TEST_ADMIN_KEY } from '../tests/harness';

test.describe.configure({ mode: 'serial' });

async function giveNametag(page: any, base: string, nametag: string) {
	await page.goto(base);
	await page.evaluate((n: string) => {
		localStorage.setItem('boxyrun-nametag', n);
		localStorage.setItem('boxyrun-skin', 'Classic');
	}, nametag);
}

test('tournament-v2: register flow updates player list + count', async ({ browser }) => {
	const server = await startServer();
	try {
		const base = `http://127.0.0.1:${server.port}`;

		const tId = 'v2-reg-test';
		await api(server, '/api/tournaments', {
			method: 'POST',
			asAdmin: true,
			body: {
				id: tId,
				name: 'Registration Browser Test',
				maxPlayers: 4,
				startsAt: new Date(Date.now() + 3600_000).toISOString(),
				entryFee: 0,
			},
		});

		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		page.on('pageerror', (e) => { throw new Error(`JS error: ${e.message}`); });

		await giveNametag(page, base, 'v2_carol');
		await page.goto(`${base}/tournament-v2.html?id=${tId}`);

		// Registration section should be visible, bracket hidden
		await expect(page.locator('#section-reg')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('#section-bracket')).toBeHidden();

		// Initially 0 players, button enabled
		await expect(page.locator('#reg-count')).toContainText('0');
		const btn = page.locator('#btn-register');
		await expect(btn).toBeEnabled();
		await expect(btn).toHaveText(/Register/);

		// Click Register. The page polls and re-renders.
		await btn.click();

		// Count should increment, button should flip to "Registered"
		await expect(page.locator('#reg-count')).toContainText('1', { timeout: 10_000 });
		await expect(page.locator('#reg-players')).toContainText('v2_carol');
		await expect(btn).toHaveText(/Registered/, { timeout: 5000 });
		await expect(btn).toBeDisabled();

		await ctx.close();
	} finally {
		await stopServer(server.proc);
	}
});

test('tournament-v2: active tournament renders bracket with round 1 matches', async ({ browser }) => {
	const server = await startServer();
	try {
		const base = `http://127.0.0.1:${server.port}`;

		const tId = 'v2-bracket-test';
		await api(server, '/api/tournaments', {
			method: 'POST',
			asAdmin: true,
			body: {
				id: tId,
				name: 'Bracket Browser Test',
				maxPlayers: 4,
				startsAt: new Date(Date.now() + 3600_000).toISOString(),
				entryFee: 0,
			},
		});

		// Seed 4 players + start the tournament via admin API so it's active
		for (const name of ['b_alice', 'b_bob', 'b_carol', 'b_dave']) {
			await api(server, `/api/tournaments/${tId}/register`, {
				method: 'POST',
				body: { nametag: name },
			});
		}
		await api(server, `/api/tournaments/${tId}/start`, {
			method: 'POST', asAdmin: true,
		});

		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		page.on('pageerror', (e) => { throw new Error(`JS error: ${e.message}`); });

		await giveNametag(page, base, 'spectator');
		await page.goto(`${base}/tournament-v2.html?id=${tId}`);

		// Bracket visible, registration hidden
		await expect(page.locator('#section-bracket')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('#section-reg')).toBeHidden();

		// Round 1 column rendered
		const draw = page.locator('#draw-wrap');
		await expect(draw).toContainText('Round', { timeout: 5000 });

		// All 4 registered players should appear in match cards
		await expect(draw).toContainText('b_alice');
		await expect(draw).toContainText('b_bob');
		await expect(draw).toContainText('b_carol');
		await expect(draw).toContainText('b_dave');

		await ctx.close();
	} finally {
		await stopServer(server.proc);
	}
});
