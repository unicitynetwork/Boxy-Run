/**
 * Server-restart mid-series regression test.
 *
 * Plays game 1 of a Bo3 to a clean win, then kills the server and
 * starts a fresh one against the SAME database. The new server's
 * machine state is empty; first event for the match triggers a
 * `loadOrSeed` that must read the persisted series progress (winsA,
 * winsB, currentGame, currentSeed) from the DB and rebuild state at
 * game 2 with the right score — NOT reset to game 1 with 0-0.
 *
 * Without this, a server restart mid-Bo3 silently wipes the series
 * score and players replay games they already won.
 */

import WebSocket from 'ws';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import {
	api,
	assert,
	assertEqual,
	runTest,
	sleep,
	startServer,
	stopServer,
	mintSession,
	TEST_ADMIN_KEY,
} from './harness';

const REPO_ROOT = join(__dirname, '..', '..');
const SERVER_BUNDLE = join(REPO_ROOT, 'dist', 'server.js');

function wsConnect(port: number, nametag: string): Promise<{
	ws: WebSocket;
	messages: any[];
	waitFor: (type: string, timeout?: number) => Promise<any>;
	send: (msg: any) => void;
	close: () => void;
}> {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		const messages: any[] = [];
		const consumed = new Set<number>();
		const waiters: { type: string; resolve: (m: any) => void; timer: NodeJS.Timeout }[] = [];
		ws.on('message', (raw) => {
			const msg = JSON.parse(raw.toString());
			const idx = messages.length;
			messages.push(msg);
			for (let i = 0; i < waiters.length; i++) {
				if (waiters[i].type === msg.type && !consumed.has(idx)) {
					consumed.add(idx);
					clearTimeout(waiters[i].timer);
					waiters[i].resolve(msg);
					waiters.splice(i, 1);
					break;
				}
			}
		});
		ws.on('open', async () => {
			const sessionId = await mintSession({ port }, nametag);
			ws.send(JSON.stringify({ type: 'register', identity: { nametag }, sessionId }));
			resolve({
				ws, messages,
				waitFor(type, timeout = 5000) {
					for (let i = 0; i < messages.length; i++) {
						if (messages[i].type === type && !consumed.has(i)) {
							consumed.add(i);
							return Promise.resolve(messages[i]);
						}
					}
					return new Promise((res, rej) => {
						const timer = setTimeout(() => rej(new Error(`timeout: ${type}`)), timeout);
						waiters.push({ type, resolve: res, timer });
					});
				},
				send(msg) { ws.send(JSON.stringify(msg)); },
				close() { ws.close(); },
			});
		});
	});
}

/** Spawn a server process bound to a specific DB path + port. */
async function spawnServer(dbPath: string, port: number): Promise<ChildProcess> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PORT: String(port),
		DB_PATH: dbPath,
		TEST_MODE: '1',
		READY_RATE_LIMIT_MS: '0',
		// Same auth bypass + admin key the harness sets — the server
		// refuses to boot without ADMIN_KEY (≥16 chars).
		ADMIN_KEY: TEST_ADMIN_KEY,
		AUTH_BYPASS: '1',
	};
	const proc = spawn('node', [SERVER_BUNDLE], {
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (process.env.DEBUG_SERVER) {
		proc.stdout!.on('data', (c) => process.stderr.write('[srv] ' + c.toString()));
		proc.stderr!.on('data', (c) => process.stderr.write('[srv-err] ' + c.toString()));
	}
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('server start timeout')), 5000);
		proc.stdout!.on('data', (chunk) => {
			if (chunk.toString().includes('listening on')) {
				clearTimeout(timer);
				resolve();
			}
		});
		proc.on('exit', (code) => {
			clearTimeout(timer);
			reject(new Error(`server exited (code=${code})`));
		});
	});
	return proc;
}

function killServer(proc: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		if (proc.exitCode !== null) return resolve();
		proc.on('exit', () => resolve());
		proc.kill('SIGINT');
		setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 2000);
	});
}

runTest('series-restart: Bo3 game-1 win persists across a server restart', async () => {
	// Boot server #1 with a known DB path so server #2 can re-open it.
	const port = 10000 + Math.floor(Math.random() * 50000);
	const dbPath = `/tmp/boxyrun-restart-test-${process.pid}-${Date.now()}.db`;
	try { unlinkSync(dbPath); } catch {}
	let proc = await spawnServer(dbPath, port);
	const server = { port, proc } as any;

	try {
		// Set up Bo3 tournament
		await api(server, '/api/tournaments', {
			method: 'POST', asAdmin: true,
			body: { id: 'restart-bo3', name: 'restart-bo3', maxPlayers: 2, bestOf: 3 },
		});
		await api(server, '/api/tournaments/restart-bo3/register', { method: 'POST', body: { nametag: 'alice' }, asNametag: 'alice' });
		await api(server, '/api/tournaments/restart-bo3/register', { method: 'POST', body: { nametag: 'bob' }, asNametag: 'bob' });
		await api(server, '/api/tournaments/restart-bo3/start', { method: 'POST', asAdmin: true });

		const matchId = 'restart-bo3/R0M0';

		// ─── Game 1: alice wins via input asymmetry ───
		let alice = await wsConnect(port, 'alice');
		let bob = await wsConnect(port, 'bob');
		await sleep(100);
		alice.send({ type: 'match-ready', matchId });
		bob.send({ type: 'match-ready', matchId });
		await alice.waitFor('match-start');
		await bob.waitFor('match-start');
		await sleep(100); // give server a beat to settle into 'playing'

		// alice sends inputs to differentiate from bob's empty replay
		for (const tick of [10, 40, 80, 120, 160, 200, 240, 280, 320, 360]) {
			alice.send({ type: 'input', matchId, tick, payload: Buffer.from('up').toString('base64') });
		}
		await sleep(150); // let stores commit
		alice.send({ type: 'match-done', matchId });
		bob.send({ type: 'match-done', matchId });
		const g1 = await alice.waitFor('game-result');
		assertEqual(g1.gameNumber, 1, 'game 1 result received');
		assert(g1.scoreA !== g1.scoreB, `g1 scores must differ: A=${g1.scoreA} B=${g1.scoreB}`);
		const g1Winner = g1.winner as string;
		const aliceWonG1 = g1Winner === 'alice';
		const expectedWinsA = aliceWonG1 ? 1 : 0;
		const expectedWinsB = aliceWonG1 ? 0 : 1;
		assertEqual(g1.winsA, expectedWinsA, `winsA after g1`);
		assertEqual(g1.winsB, expectedWinsB, `winsB after g1`);

		// Wait for the series-next to fire so persist_series_progress runs
		// for the advance_to_next_game effect (currentGame=2 in DB).
		await alice.waitFor('series-next');
		await sleep(100); // let persist effect commit

		alice.close();
		bob.close();

		// ─── KILL server #1, BOOT server #2 against same DB ───
		await killServer(proc);
		proc = await spawnServer(dbPath, port);
		server.proc = proc;

		// New server has empty machine state. Reconnect + re-ready.
		alice = await wsConnect(port, 'alice');
		bob = await wsConnect(port, 'bob');
		await sleep(100);

		// First ready loadOrSeeds the match. With the fix, machine reads
		// series_wins_a/b/current_game from DB. Without the fix, machine
		// resets to game 1 with 0-0 wins.
		alice.send({ type: 'match-ready', matchId });
		await sleep(150); // let loadOrSeed run
		const stateBefore = await api(server, `/api/tournaments/restart-bo3/matches/0/0/state`) as any;
		assertEqual(stateBefore.series.winsA, expectedWinsA, 'wins survived restart');
		assertEqual(stateBefore.series.winsB, expectedWinsB, 'wins survived restart');
		assertEqual(stateBefore.series.currentGame, 2, 'currentGame=2 after restart');

		bob.send({ type: 'match-ready', matchId });
		await alice.waitFor('match-start');
		await bob.waitFor('match-start');
		alice.send({ type: 'match-done', matchId });
		bob.send({ type: 'match-done', matchId });

		// Result must be tagged as game 2 (NOT game 1 — that would mean
		// the restart silently wiped progress).
		const g2 = await alice.waitFor('game-result', 8000).catch(async () => {
			// If alice has 1 win and wins this too → series ends with match-end
			return await alice.waitFor('match-end', 5000);
		});
		if (g2.type === 'match-end') {
			// Series ended at 2-? — this confirms server treated the post-restart
			// game as game 2 (otherwise it'd be game 1 with 1-0, not series end).
			assertEqual(g2.seriesEnd, true, 'match-end has seriesEnd');
		} else {
			assertEqual(g2.gameNumber, 2, 'post-restart game is game 2 (NOT game 1)');
		}

		alice.close();
		bob.close();
	} finally {
		await killServer(proc);
		try { unlinkSync(dbPath); } catch {}
	}
});
