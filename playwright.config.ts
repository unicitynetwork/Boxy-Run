/**
 * Playwright config for browser tests.
 *
 * Tests live in tournament/browser-tests/ and exercise the actual HTML
 * pages + the bundled game/JS. Each test spawns a local server
 * subprocess (same harness as server tests) and points the browser at it.
 *
 * Run with:  npm run test:browser
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './tournament/browser-tests',
	fullyParallel: false,       // server spawns per test; keep sequential until we need speed
	workers: 1,
	reporter: [['list']],
	timeout: 30_000,
	use: {
		trace: 'retain-on-failure',
		video: 'retain-on-failure',
		screenshot: 'only-on-failure',
	},
	projects: [
		{ name: 'chromium', use: { browserName: 'chromium' } },
	],
});
