/**
 * Test harness for the tournament server. Each test file imports this,
 * spawns a fresh server subprocess, connects one or more clients, and
 * asserts against the message stream.
 *
 * The design avoids a test framework on purpose: tests compile to
 * standalone Node scripts via esbuild (one per file), and the runner
 * (tournament/tests/run-all.mjs) executes each and collects results.
 * A failing test throws; the runner catches and reports.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import WebSocket from 'ws';

import type {
	ClientMessage,
	ServerMessage,
} from '../protocol/messages';

const REPO_ROOT = join(__dirname, '..', '..');
const SERVER_BUNDLE = join(REPO_ROOT, 'dist', 'server.js');

/**
 * Boot the server as a child process. Returns once the server has
 * logged "listening on" to stdout, so subsequent client connects
 * don't race against the listen call. Each call picks a unique port
 * to allow parallel test runs.
 */
// Random port in 10000-60000 range to avoid collisions with orphaned servers
function randomPort(): number {
	return 10000 + Math.floor(Math.random() * 50000);
}

export async function startServer(
	options: {
		capacity?: number;
		minPlayers?: number;
		roundWindowMs?: number;
		tournamentId?: string;
		readyRateLimitMs?: number;
	} = {},
): Promise<{
	proc: ChildProcess;
	url: string;
	port: number;
}> {
	const port = randomPort();
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PORT: String(port),
		// Enable test-only endpoints (fake clock etc.)
		TEST_MODE: '1',
	};
	if (options.capacity !== undefined) {
		env.LOBBY_CAPACITY = String(options.capacity);
	}
	if (options.minPlayers !== undefined) {
		env.MIN_PLAYERS = String(options.minPlayers);
	}
	if (options.roundWindowMs !== undefined) {
		env.ROUND_WINDOW_MS = String(options.roundWindowMs);
	}
	if (options.tournamentId !== undefined) {
		env.TOURNAMENT_ID = options.tournamentId;
	}
	// Default to 0 rate limit in tests for speed
	env.READY_RATE_LIMIT_MS = String(options.readyRateLimitMs ?? 0);
	// Unique DB per test run — include pid + hrtime to prevent a random-port
	// collision with a previous test run leaving stale data behind.
	const runId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	env.DB_PATH = `/tmp/boxyrun-test-${port}-${runId}.db`;
	// Make sure the file doesn't exist from a prior run.
	try { (await import('node:fs')).unlinkSync(env.DB_PATH); } catch {}
	const proc = spawn('node', [SERVER_BUNDLE], {
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	// Tag the db path on the process so stopServer can clean it up.
	(proc as any)._dbPath = env.DB_PATH;

	let stderrBuf = '';
	proc.stderr!.on('data', (chunk) => {
		stderrBuf += chunk.toString();
	});
	// Debug: pipe server stdout to test stderr so logs surface in the runner.
	if (process.env.DEBUG_SERVER) {
		proc.stdout!.on('data', (c) => process.stderr.write('[srv] ' + c.toString()));
	}

	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(
				new Error(
					`server did not start within 5s. stderr: ${stderrBuf || '(empty)'}`,
				),
			);
		}, 5000);
		proc.stdout!.on('data', (chunk) => {
			if (chunk.toString().includes('listening on')) {
				clearTimeout(timer);
				resolve();
			}
		});
		proc.on('exit', (code) => {
			clearTimeout(timer);
			reject(
				new Error(
					`server exited before ready (code=${code}). stderr: ${stderrBuf}`,
				),
			);
		});
	});

	return { proc, url: `ws://127.0.0.1:${port}`, port };
}

/** Stop the server and wait for the process to fully exit. */
export function stopServer(proc: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		const cleanupDb = () => {
			// Clean the DB file the child was using so /tmp doesn't accumulate.
			const dbPath = proc.spawnargs && (proc as any).spawnargs
				? undefined
				: undefined;
			// Easiest: harvest from env. But we have a reference stored below.
			if ((proc as any)._dbPath) {
				try { require('node:fs').unlinkSync((proc as any)._dbPath); } catch {}
			}
			resolve();
		};
		if (proc.exitCode !== null) { cleanupDb(); return; }
		proc.on('exit', cleanupDb);
		proc.kill('SIGINT');
		setTimeout(() => {
			if (proc.exitCode === null) proc.kill('SIGKILL');
		}, 2000);
	});
}

/** A WebSocket client wrapper that records every server message. */
export interface TestClient {
	readonly ws: WebSocket;
	readonly received: ServerMessage[];
	/** Send a fully-formed client message as JSON. */
	send(msg: ClientMessage): void;
	/**
	 * Wait for the next message of the given type. If one has already
	 * been received and not yet consumed by nextMessage, returns it
	 * immediately. Rejects after the timeout.
	 */
	nextMessage<T extends ServerMessage['type']>(
		type: T,
		timeoutMs?: number,
	): Promise<Extract<ServerMessage, { type: T }>>;
	close(): void;
}

/**
 * Open a WebSocket connection to the given url and resolve once the
 * socket is open. The returned TestClient records every incoming
 * server message for later assertion.
 */
export function connectClient(url: string): Promise<TestClient> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		const received: ServerMessage[] = [];
		const consumedIndex = new Set<number>();
		const waiters: Array<{
			type: string;
			resolve: (msg: ServerMessage) => void;
			reject: (err: Error) => void;
			timer: NodeJS.Timeout;
		}> = [];

		ws.on('message', (raw) => {
			const msg = JSON.parse(raw.toString()) as ServerMessage;
			const idx = received.length;
			received.push(msg);
			for (let i = 0; i < waiters.length; i++) {
				if (waiters[i].type === msg.type && !consumedIndex.has(idx)) {
					consumedIndex.add(idx);
					clearTimeout(waiters[i].timer);
					waiters[i].resolve(msg);
					waiters.splice(i, 1);
					break;
				}
			}
		});

		ws.on('error', (err) => reject(err));

		ws.on('open', () => {
			const client: TestClient = {
				ws,
				received,
				send(msg) {
					ws.send(JSON.stringify(msg));
				},
				nextMessage(type, timeoutMs = 2000) {
					// First, check received buffer for an unconsumed message of this type.
					for (let i = 0; i < received.length; i++) {
						if (received[i].type === type && !consumedIndex.has(i)) {
							consumedIndex.add(i);
							return Promise.resolve(received[i] as any);
						}
					}
					// Otherwise, wait for one.
					return new Promise((res, rej) => {
						const timer = setTimeout(() => {
							const idx = waiters.findIndex((w) => w.type === type);
							if (idx >= 0) waiters.splice(idx, 1);
							rej(
								new Error(
									`timeout waiting for message type '${type}' after ${timeoutMs}ms. Received so far: ${JSON.stringify(
										received.map((m) => m.type),
									)}`,
								),
							);
						}, timeoutMs);
						waiters.push({
							type,
							resolve: res as (m: ServerMessage) => void,
							reject: rej,
							timer,
						});
					});
				},
				close() {
					ws.close();
				},
			};
			resolve(client);
		});
	});
}

/** Deep-equal assertion. Throws with a descriptive message on mismatch. */
export function assertEqual<T>(actual: T, expected: T, label = ''): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(
			`assertEqual failed${label ? ` (${label})` : ''}:\n  expected: ${e}\n  actual:   ${a}`,
		);
	}
}

/** Truthy assertion. */
export function assert(condition: unknown, message = 'condition was falsy'): asserts condition {
	if (!condition) {
		throw new Error(`assertion failed: ${message}`);
	}
}

/**
 * Run an async test function, print pass/fail, and exit with the
 * correct status code. Each test file calls this once at the bottom.
 */
/**
 * Collects all runTest() calls in a file and runs them sequentially when
 * the event loop drains (via a microtask scheduled on first call). This
 * lets a single .test.ts file define multiple named tests.
 */
interface RegisteredTest { name: string; fn: () => Promise<void>; }
const pendingTests: RegisteredTest[] = [];
let runScheduled = false;

export function runTest(name: string, fn: () => Promise<void>): void {
	pendingTests.push({ name, fn });
	if (!runScheduled) {
		runScheduled = true;
		// Defer to next tick so all registrations complete before we start.
		setImmediate(async () => {
			let failed = 0;
			for (const t of pendingTests) {
				const start = Date.now();
				try {
					await t.fn();
					console.log(`  ✓ ${t.name} (${Date.now() - start}ms)`);
				} catch (err) {
					failed++;
					console.error(`  ✗ ${t.name} (${Date.now() - start}ms)`);
					console.error(`    ${err instanceof Error ? err.stack || err.message : err}`);
				}
			}
			process.exit(failed === 0 ? 0 : 1);
		});
	}
}

/** Short sleep for tests that need to observe server-side timing. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── REST client helper ──────────────────────────────────────────────

/** Default admin key the server falls back to when ADMIN_KEY env is unset. */
export const TEST_ADMIN_KEY = 'boxyrun-admin-2024';

export interface ApiOptions {
	method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
	body?: unknown;
	asAdmin?: boolean;
	/** Expect non-2xx and return body anyway (for error-path tests) */
	allowError?: boolean;
}

/**
 * Make a REST call against the test server. `path` should start with `/api`.
 * Throws on non-2xx by default (use `allowError: true` to inspect errors).
 */
export async function api<T = any>(
	server: { port: number },
	path: string,
	opts: ApiOptions = {},
): Promise<T> {
	const url = `http://127.0.0.1:${server.port}${path}`;
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (opts.asAdmin) headers['X-Admin-Key'] = TEST_ADMIN_KEY;
	const init: RequestInit = {
		method: opts.method || 'GET',
		headers,
	};
	if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
	const r = await fetch(url, init);
	const text = await r.text();
	let data: any;
	try { data = text ? JSON.parse(text) : null; } catch { data = text; }
	if (!r.ok && !opts.allowError) {
		throw new Error(
			`${opts.method || 'GET'} ${path} failed: HTTP ${r.status}` +
			`${data ? ' ' + JSON.stringify(data) : ''}`,
		);
	}
	return data as T;
}

/**
 * Test-only: advance the server's fake clock by `ms`. Lets tests exercise
 * 30s / 45s timeouts without real waiting. Requires server started via
 * startServer() (which sets TEST_MODE=1).
 */
export async function advanceClock(
	server: { port: number },
	ms: number,
): Promise<void> {
	const url = `http://127.0.0.1:${server.port}/__test/advance-clock`;
	const r = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ms }),
	});
	if (!r.ok) throw new Error(`advance-clock failed: HTTP ${r.status} ${await r.text()}`);
}

/** Test-only: reset the server's fake-clock offset to zero. */
export async function resetClock(server: { port: number }): Promise<void> {
	const url = `http://127.0.0.1:${server.port}/__test/reset-clock`;
	const r = await fetch(url, { method: 'POST' });
	if (!r.ok) throw new Error(`reset-clock failed: HTTP ${r.status}`);
}
