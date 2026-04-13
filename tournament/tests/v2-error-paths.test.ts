/**
 * V2 Error paths — ready for wrong match, input for inactive match,
 * ready when not in match, register for full tournament.
 */

import WebSocket from 'ws';
import {
	assert,
	assertEqual,
	runTest,
	sleep,
	startServer,
	stopServer,
} from './harness';

async function api(baseUrl: string, path: string, method = 'GET', body?: any) {
	const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
	if (body) opts.body = JSON.stringify(body);
	const r = await fetch(`${baseUrl}${path}`, opts);
	return r.json();
}

function wsConnect(port: number, nametag: string): Promise<{
	ws: WebSocket; messages: any[]; send: (msg: any) => void; close: () => void;
	waitFor: (type: string, timeout?: number) => Promise<any>;
}> {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		const messages: any[] = [];
		const waiters: any[] = [];
		ws.on('message', (raw) => {
			const msg = JSON.parse(raw.toString());
			messages.push(msg);
			for (let i = 0; i < waiters.length; i++) {
				if (waiters[i].type === msg.type) {
					clearTimeout(waiters[i].timer);
					waiters[i].resolve(msg);
					waiters.splice(i, 1);
					break;
				}
			}
		});
		ws.on('open', () => {
			ws.send(JSON.stringify({ type: 'register', identity: { nametag } }));
			resolve({
				ws, messages,
				send(msg: any) { ws.send(JSON.stringify(msg)); },
				close() { ws.close(); },
				waitFor(type: string, timeout = 3000) {
					for (const m of messages) if (m.type === type) return Promise.resolve(m);
					return new Promise((res, rej) => {
						const timer = setTimeout(() => rej(new Error(`timeout: ${type}`)), timeout);
						waiters.push({ type, resolve: res, timer });
					});
				},
			});
		});
	});
}

runTest('v2: error paths — invalid ready, full tournament, wrong match', async () => {
	const server = await startServer();
	const base = `http://127.0.0.1:${server.port}/api`;
	try {
		// ── 1. Ready for nonexistent match ──
		{
			const c = await wsConnect(server.port, 'error_test_1');
			await sleep(100);
			c.send({ type: 'match-ready', matchId: 'nonexistent/R0M0' });
			const err = await c.waitFor('error');
			assert(err.code, 'should get error for bad match');
			c.close();
		}

		// ── 2. Ready for match you're not in ──
		{
			await api(base, '/tournaments', 'POST', { id: 'err-t1', name: 'Err Test' });
			await api(base, '/tournaments/err-t1/register', 'POST', { nametag: 'alice' });
			await api(base, '/tournaments/err-t1/register', 'POST', { nametag: 'bob' });
			await api(base, '/tournaments/err-t1/start', 'POST');

			const bracket = await api(base, '/tournaments/err-t1/bracket');
			const matchId = bracket.matches[0].id;

			const eve = await wsConnect(server.port, 'eve_outsider');
			await sleep(100);
			eve.send({ type: 'match-ready', matchId });
			const err = await eve.waitFor('error');
			assertEqual(err.code, 'not_in_match');
			eve.close();
		}

		// ── 3. Register for full tournament ──
		{
			await api(base, '/tournaments', 'POST', { id: 'full-t', name: 'Full', maxPlayers: 2 });
			await api(base, '/tournaments/full-t/register', 'POST', { nametag: 'p1' });
			await api(base, '/tournaments/full-t/register', 'POST', { nametag: 'p2' });
			const full = await api(base, '/tournaments/full-t/register', 'POST', { nametag: 'p3' });
			assert(full.error, 'should error when full');
		}

		// ── 4. Start already-started tournament ──
		{
			const started = await api(base, '/tournaments/err-t1/start', 'POST');
			assert(started.error, 'should error on double start');
		}

		// ── 5. Input for match not in active state ──
		{
			await api(base, '/tournaments', 'POST', { id: 'err-t2', name: 'Input Err' });
			await api(base, '/tournaments/err-t2/register', 'POST', { nametag: 'inputA' });
			await api(base, '/tournaments/err-t2/register', 'POST', { nametag: 'inputB' });
			await api(base, '/tournaments/err-t2/start', 'POST');

			const bracket = await api(base, '/tournaments/err-t2/bracket');
			const matchId = bracket.matches[0].id;

			// Send input before match starts (still in ready_wait)
			const c = await wsConnect(server.port, 'inputA');
			await sleep(100);
			c.send({ type: 'input', matchId, tick: 10, payload: btoa('up') });
			await sleep(200);

			// Input should be silently dropped (match not active)
			// No crash, no error message for inputs (fire-and-forget)
			c.close();
		}

	} finally {
		await stopServer(server.proc);
	}
});
