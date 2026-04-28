/**
 * admin.html — auth, balance-sheet view, tournament creation with entry fee.
 *
 * Uses the default ADMIN_KEY that startServer configures.
 */

import { test, expect } from '@playwright/test';
import { startServer, stopServer, api, TEST_ADMIN_KEY } from '../tests/harness';

test.describe.configure({ mode: 'serial' });

test('admin: invalid key → auth failure, no balance-sheet loaded', async ({ page }) => {
	const server = await startServer();
	try {
		const base = `http://127.0.0.1:${server.port}`;
		await page.goto(`${base}/admin.html`);
		await page.fill('#admin-key', 'wrong-key');
		await page.click('#btn-auth');
		await expect(page.locator('#auth-status')).toHaveText('Invalid key', { timeout: 5000 });
		// Balance sheet still shows "authenticate first" (or something non-empty)
		const bsText = await page.locator('#bs-body').innerText();
		expect(bsText.toLowerCase()).toMatch(/authenticate|failed|unauthorized/);
	} finally {
		await stopServer(server.proc);
	}
});

test('admin: valid auth → balance-sheet renders with system totals', async ({ page }) => {
	const server = await startServer();
	try {
		// Seed some state so the view has numbers to show
		await api(server, '/api/admin/credit', { method: 'POST', body: { nametag: 'alice', amount: 500 }, asAdmin: true });
		await api(server, '/api/admin/credit', { method: 'POST', body: { nametag: 'bob', amount: 300 }, asAdmin: true });
		await api(server, '/api/tournaments', {
			method: 'POST', asAdmin: true,
			body: { id: 'admin-bs-t', name: 'Admin Test', prizePool: 100, entryFee: 50 },
		});
		await api(server, '/api/tournaments/admin-bs-t/register', {
			method: 'POST', body: { nametag: 'alice' },
		});

		const base = `http://127.0.0.1:${server.port}`;
		await page.goto(`${base}/admin.html`);
		await page.fill('#admin-key', TEST_ADMIN_KEY);
		await page.click('#btn-auth');
		await expect(page.locator('#auth-status')).toHaveText('Authenticated', { timeout: 5000 });

		// Balance sheet populated
		const bsBody = page.locator('#bs-body');
		await expect(bsBody).toContainText('Arena Wallet', { timeout: 5000 });
		await expect(bsBody).toContainText('@boxyrunarena');
		await expect(bsBody).toContainText('Expected Arena Balance');
		// alice: 500 - 50 entry = 450; bob: 300; total balance = 750
		// Prize pool: 100 seed + 50 entry = 150. total tokens = 900.
		await expect(bsBody).toContainText('900 UCT');
		await expect(bsBody).toContainText('150 UCT');
		// byType table should include deposit and entry_fee
		await expect(bsBody).toContainText('deposit');
		await expect(bsBody).toContainText('entry_fee');
	} finally {
		await stopServer(server.proc);
	}
});

test('admin: create tournament with entry fee via form', async ({ page }) => {
	const server = await startServer();
	try {
		const base = `http://127.0.0.1:${server.port}`;
		await page.goto(`${base}/admin.html`);
		await page.fill('#admin-key', TEST_ADMIN_KEY);
		await page.click('#btn-auth');
		await expect(page.locator('#auth-status')).toHaveText('Authenticated', { timeout: 5000 });

		await page.fill('#t-name', 'Browser-Created Tournament');
		await page.fill('#t-entry', '75');
		await page.fill('#t-prize', '200');
		await page.click('#btn-create');

		await expect(page.locator('#create-msg')).toContainText('Created', { timeout: 5000 });

		// Verify server has the tournament with correct entry_fee
		const list = await api(server, '/api/tournaments');
		const found = list.tournaments.find((t: any) => t.name === 'Browser-Created Tournament');
		expect(found).toBeTruthy();
		expect(found.entry_fee).toBe(75);
		expect(found.prize_pool).toBe(200);
	} finally {
		await stopServer(server.proc);
	}
});
