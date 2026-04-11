#!/usr/bin/env node
/**
 * Test runner for tournament tests. Bundles every tournament/tests/*.test.ts
 * file with esbuild (once, in parallel), then runs each compiled bundle
 * sequentially as a node child process. Each test file is expected to
 * call runTest() from harness.ts, which exits 0 on success and 1 on
 * failure. The runner collects results and exits non-zero if any test
 * failed.
 *
 * Usage:
 *   npm run test:server
 *
 * This script expects dist/server.js to already exist (built by
 * `npm run build:server`). The npm script chain handles that.
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const TESTS_DIR = __dirname;
const DIST_DIR = join(REPO_ROOT, 'dist', 'tests');

if (!existsSync(DIST_DIR)) mkdirSync(DIST_DIR, { recursive: true });

// Discover test files
const testFiles = readdirSync(TESTS_DIR)
	.filter((f) => f.endsWith('.test.ts'))
	.sort();

if (testFiles.length === 0) {
	console.log('no tests found');
	process.exit(0);
}

// Build every test file with esbuild (reuses the node_modules esbuild).
console.log(`building ${testFiles.length} test file(s)...`);
const entries = testFiles
	.map((f) => join(TESTS_DIR, f))
	.map((p) => `"${p}"`)
	.join(' ');
execSync(
	`npx esbuild ${entries} --bundle --platform=node --format=cjs --packages=external --outdir="${DIST_DIR}"`,
	{ cwd: REPO_ROOT, stdio: 'inherit' },
);

// Run each compiled test in sequence.
console.log('\nrunning tests:');
let failures = 0;
for (const src of testFiles) {
	const js = src.replace(/\.ts$/, '.js');
	const bundle = join(DIST_DIR, js);
	const result = await new Promise((resolveRun) => {
		const child = spawn('node', [bundle], { stdio: 'inherit' });
		child.on('exit', (code) => resolveRun(code ?? 1));
	});
	if (result !== 0) failures++;
}

console.log(
	failures === 0
		? `\nall ${testFiles.length} tests passed`
		: `\n${failures}/${testFiles.length} tests failed`,
);
process.exit(failures === 0 ? 0 : 1);
