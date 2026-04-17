/**
 * tournament-v2.html "Your Match" section — appears for a registered
 * player when a tournament is active and they have a round-1 match
 * in ready_wait status. Shows opponent name + Ready button.
 *
 * This exercises the branch at tournament-v2.html:982 (myMatch found,
 * status=ready_wait) which is easy to break when the page's match
 * visibility logic is refactored.
 */

import { test, expect } from '@playwright/test';
import { startServer, stopServer, api } from '../tests/harness';

test.describe.configure({ mode: 'serial' });

async function giveNametag(page: any, base: string, nametag: string) {
	await page.goto(base);
	await page.evaluate((n: string) => {
		localStorage.setItem('boxyrun-nametag', n);
		localStorage.setItem('boxyrun-skin', 'Classic');
	}, nametag);
}

test('tournament-v2: active tournament shows "Your Match" section for a registered player', async ({ browser }) => {
	const server = await startServer();
	try {
		const base = `http://127.0.0.1:${server.port}`;

		const tId = 'v2-your-match';
		await api(server, '/api/tournaments', {
			method: 'POST', asAdmin: true,
			body: {
				id: tId, name: 'Your Match Test', maxPlayers: 4,
				startsAt: new Date(Date.now() + 3600_000).toISOString(),
				entryFee: 0,
			},
		});

		for (const name of ['ym_alice', 'ym_bob', 'ym_carol', 'ym_dave']) {
			await api(server, `/api/tournaments/${tId}/register`, {
				method: 'POST', body: { nametag: name },
			});
		}
		await api(server, `/api/tournaments/${tId}/start`, {
			method: 'POST', asAdmin: true,
		});

		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		page.on('pageerror', (e) => { throw new Error(`JS error: ${e.message}`); });

		// Load as ym_alice — she should see her match + opponent + ready button
		await giveNametag(page, base, 'ym_alice');
		await page.goto(`${base}/tournament-v2.html?id=${tId}`);

		const yourMatch = page.locator('#section-match');
		await expect(yourMatch).toBeVisible({ timeout: 10_000 });

		// Opponent name must populate — it's one of bob/carol/dave depending on
		// bracket seeding, but definitely not alice or "---".
		const opp = page.locator('#match-opponent');
		await expect(opp).not.toHaveText('---', { timeout: 5000 });
		await expect(opp).not.toHaveText('ym_alice');

		// Ready button must be there and enabled (not yet clicked)
		const readyBtn = page.locator('#btn-ready');
		await expect(readyBtn).toBeVisible();
		await expect(readyBtn).toBeEnabled();

		await ctx.close();
	} finally {
		await stopServer(server.proc);
	}
});

test('tournament-v2: spectator (not registered) sees only bracket, no Your Match', async ({ browser }) => {
	const server = await startServer();
	try {
		const base = `http://127.0.0.1:${server.port}`;

		const tId = 'v2-spectator';
		await api(server, '/api/tournaments', {
			method: 'POST', asAdmin: true,
			body: {
				id: tId, name: 'Spectator Test', maxPlayers: 4,
				startsAt: new Date(Date.now() + 3600_000).toISOString(),
				entryFee: 0,
			},
		});
		for (const name of ['sp_a', 'sp_b', 'sp_c', 'sp_d']) {
			await api(server, `/api/tournaments/${tId}/register`, {
				method: 'POST', body: { nametag: name },
			});
		}
		await api(server, `/api/tournaments/${tId}/start`, {
			method: 'POST', asAdmin: true,
		});

		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		page.on('pageerror', (e) => { throw new Error(`JS error: ${e.message}`); });

		await giveNametag(page, base, 'outsider');
		await page.goto(`${base}/tournament-v2.html?id=${tId}`);

		await expect(page.locator('#section-bracket')).toBeVisible({ timeout: 5000 });
		// Your-Match section must stay hidden for non-participants
		await expect(page.locator('#section-match')).toBeHidden();

		await ctx.close();
	} finally {
		await stopServer(server.proc);
	}
});
