/**
 * V2 Error paths — ready for wrong match, input for inactive match,
 * ready when not in match, register for full tournament.
 */

import WebSocket from 'ws';
import {
	api,
	assert,
	assertEqual,
	runTest,
	sleep,
	startServer,
	stopServer,
	mintSession,
} from './harness';

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
		ws.on('open', async () => {
			const sessionId = await mintSession({ port }, nametag);
			ws.send(JSON.stringify({ type: 'register', identity: { nametag }, sessionId }));
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
			await api(server, '/api/tournaments', {
				method: 'POST', asAdmin: true, body: { id: 'err-t1', name: 'Err Test' },
			});
			await api(server, '/api/tournaments/err-t1/register', {
				method: 'POST', body: { nametag: 'alice' }, asNametag: 'alice',
			});
			await api(server, '/api/tournaments/err-t1/register', {
				method: 'POST', body: { nametag: 'bob' }, asNametag: 'bob',
			});
			await api(server, '/api/tournaments/err-t1/start', {
				method: 'POST', asAdmin: true,
			});

			const bracket = await api(server, '/api/tournaments/err-t1/bracket');
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
			await api(server, '/api/tournaments', {
				method: 'POST', asAdmin: true,
				body: { id: 'full-t', name: 'Full', maxPlayers: 2 },
			});
			await api(server, '/api/tournaments/full-t/register', {
				method: 'POST', body: { nametag: 'p1' }, asNametag: 'p1',
			});
			await api(server, '/api/tournaments/full-t/register', {
				method: 'POST', body: { nametag: 'p2' }, asNametag: 'p2',
			});
			const full = await api(server, '/api/tournaments/full-t/register', {
				method: 'POST', body: { nametag: 'p3' }, asNametag: 'p3', allowError: true,
			});
			assert(full.error, 'should error when full');
		}

		// ── 4. Start already-started tournament ──
		{
			const started = await api(server, '/api/tournaments/err-t1/start', {
				method: 'POST', asAdmin: true, allowError: true,
			});
			assert(started.error, 'should error on double start');
		}

		// ── 5. Input for match not in active state ──
		{
			await api(server, '/api/tournaments', {
				method: 'POST', asAdmin: true, body: { id: 'err-t2', name: 'Input Err' },
			});
			await api(server, '/api/tournaments/err-t2/register', {
				method: 'POST', body: { nametag: 'inputA' }, asNametag: 'inputA',
			});
			await api(server, '/api/tournaments/err-t2/register', {
				method: 'POST', body: { nametag: 'inputB' }, asNametag: 'inputB',
			});
			await api(server, '/api/tournaments/err-t2/start', {
				method: 'POST', asAdmin: true,
			});

			const bracket = await api(server, '/api/tournaments/err-t2/bracket');
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
