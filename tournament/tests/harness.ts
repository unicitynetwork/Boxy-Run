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
	const proc = spawn('node', [SERVER_BUNDLE], {
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	let stderrBuf = '';
	proc.stderr!.on('data', (chunk) => {
		stderrBuf += chunk.toString();
	});

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
		if (proc.exitCode !== null) {
			resolve();
			return;
		}
		proc.on('exit', () => resolve());
		proc.kill('SIGINT');
		// Fallback SIGKILL after 2s if SIGINT didn't work
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
export function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(`assertion failed: ${message}`);
	}
}

/**
 * Run an async test function, print pass/fail, and exit with the
 * correct status code. Each test file calls this once at the bottom.
 */
export async function runTest(
	name: string,
	fn: () => Promise<void>,
): Promise<void> {
	const start = Date.now();
	try {
		await fn();
		const ms = Date.now() - start;
		console.log(`  ✓ ${name} (${ms}ms)`);
		process.exit(0);
	} catch (err) {
		const ms = Date.now() - start;
		console.error(`  ✗ ${name} (${ms}ms)`);
		console.error(`    ${err instanceof Error ? err.stack || err.message : err}`);
		process.exit(1);
	}
}

/** Short sleep for tests that need to observe server-side timing. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
