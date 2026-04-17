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

// Run test files in parallel — each picks a random port and uses a unique
// DB path, so there's no contention. Output is captured per-file and
// streamed after completion to keep the console readable.
console.log('\nrunning tests (parallel):');
// 10 min ceiling — the bot-e2e tests need several minutes to play out
// full Bo3 series. Individual tests still exit fast on success; this
// just prevents a wedged test from running forever.
const TEST_TIMEOUT_MS = 600_000;
const CONCURRENCY = parseInt(process.env.TEST_CONCURRENCY || '0', 10)
	|| Math.min(testFiles.length, Math.max(4, (await import('node:os')).cpus().length));

async function runOne(src) {
	const js = src.replace(/\.ts$/, '.js');
	const bundle = join(DIST_DIR, js);
	return new Promise((resolveRun) => {
		const child = spawn('node', [bundle], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (c) => { stdout += c.toString(); });
		child.stderr.on('data', (c) => { stderr += c.toString(); });
		const timer = setTimeout(() => {
			try { process.kill(-child.pid, 'SIGKILL'); } catch {}
			resolveRun({ src, code: 1, stdout, stderr: stderr + `\n  TIMEOUT: exceeded ${TEST_TIMEOUT_MS}ms` });
		}, TEST_TIMEOUT_MS);
		child.on('exit', (code) => {
			clearTimeout(timer);
			resolveRun({ src, code: code ?? 1, stdout, stderr });
		});
	});
}

async function runPool(files, n) {
	const results = [];
	let idx = 0;
	async function worker() {
		while (idx < files.length) {
			const my = idx++;
			results[my] = await runOne(files[my]);
		}
	}
	await Promise.all(Array.from({ length: n }, worker));
	return results;
}

const results = await runPool(testFiles, CONCURRENCY);

// Print outputs in deterministic order (test file order) so logs are stable.
let failures = 0;
for (const r of results) {
	if (r.stdout) process.stdout.write(r.stdout);
	if (r.stderr) process.stderr.write(r.stderr);
	if (r.code !== 0) failures++;
}

console.log(
	failures === 0
		? `\nall ${testFiles.length} test file(s) passed`
		: `\n${failures}/${testFiles.length} test file(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
