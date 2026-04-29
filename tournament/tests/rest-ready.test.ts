/**
 * REST ready endpoint — POST /api/tournaments/:tid/matches/:round/:slot/ready
 *
 * Must be equivalent to a WS `match-ready` message, idempotent, and
 * work even when the caller's WebSocket is a zombie.
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
import { chaosConnect } from './chaos';

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
				waitFor(type, timeout = 5000) {
					for (const m of messages) if (m.type === type) return Promise.resolve(m);
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

async function setupMatch(server: { port: number }, tid: string, a: string, b: string) {
	await api(server, '/api/tournaments', {
		method: 'POST', asAdmin: true,
		body: { id: tid, name: tid, maxPlayers: 2 },
	});
	await api(server, '/api/tournaments/' + tid + '/register', {
		method: 'POST', body: { nametag: a }, asNametag: a,
	});
	await api(server, '/api/tournaments/' + tid + '/register', {
		method: 'POST', body: { nametag: b }, asNametag: b,
	});
	await api(server, '/api/tournaments/' + tid + '/start', {
		method: 'POST', asAdmin: true,
	});
}

runTest('REST ready endpoint — equivalent to WS ready, idempotent, zombie-safe', async () => {
	const server = await startServer();
	try {
		// ─────────────────────────────────────────────
		// 1. Basic ready via REST — waiting state
		// ─────────────────────────────────────────────
		await setupMatch(server, 't-rest1', 'alice', 'bob');
		// Connect both via WS first so neither is "offline" — otherwise the
		// offline-auto-ready rule would start the match on the first REST call.
		const aliceWs = await wsConnect(server.port, 'alice');
		const bobWs = await wsConnect(server.port, 'bob');
		await sleep(100);

		const matchIdPath = '/api/tournaments/t-rest1/matches/0/0/ready';

		const r1 = await api(server, matchIdPath, {
			method: 'POST', body: { nametag: 'alice' }, asNametag: 'alice',
		});
		assertEqual(r1.status, 'ok');
		assertEqual(r1.phase, 'waiting', 'alice is first, waiting for bob');

		// State shows alice ready
		const state1 = await api(server, '/api/tournaments/t-rest1/matches/0/0/state');
		const aliceSide = state1.playerA === 'alice' ? 'A' : 'B';
		assertEqual(state1.ready[aliceSide], true);

		// ─────────────────────────────────────────────
		// 2. Idempotent — second REST ready doesn't error
		// ─────────────────────────────────────────────
		const r1b = await api(server, matchIdPath, {
			method: 'POST', body: { nametag: 'alice' }, asNametag: 'alice',
		});
		assertEqual(r1b.status, 'ok', 'duplicate ready is fine');

		// ─────────────────────────────────────────────
		// 3. Bob readies → match starts, matchStart returned
		// ─────────────────────────────────────────────
		const r2 = await api(server, matchIdPath, {
			method: 'POST', body: { nametag: 'bob' }, asNametag: 'bob',
		});
		assertEqual(r2.status, 'ok');
		assertEqual(r2.phase, 'started');
		assert(r2.matchStart, 'matchStart payload present on started');
		assertEqual(r2.matchStart.matchId, 't-rest1/R0M0');
		assert(r2.matchStart.seed, 'seed present');

		const state2 = await api(server, '/api/tournaments/t-rest1/matches/0/0/state');
		assertEqual(state2.phase, 'active', 'match is active after both ready');

		aliceWs.close();
		bobWs.close();

		// ─────────────────────────────────────────────
		// 4. Error: non-participant — 403
		// ─────────────────────────────────────────────
		await setupMatch(server, 't-rest2', 'carol', 'dave');
		const intruder = await api(server, '/api/tournaments/t-rest2/matches/0/0/ready', {
			method: 'POST', body: { nametag: 'eve' }, asNametag: 'eve', allowError: true,
		});
		assertEqual(intruder.error, 'not_in_match', 'eve is not in match');

		// ─────────────────────────────────────────────
		// 5. Error: 404 nonexistent match
		// ─────────────────────────────────────────────
		const nope = await api(server, '/api/tournaments/t-rest2/matches/9/9/ready', {
			method: 'POST', body: { nametag: 'carol' }, asNametag: 'carol', allowError: true,
		});
		assertEqual(nope.error, 'not_found');

		// ─────────────────────────────────────────────
		// 6. Error: 400 missing nametag
		// ─────────────────────────────────────────────
		const noName = await api(server, '/api/tournaments/t-rest2/matches/0/0/ready', {
			method: 'POST', body: {}, allowError: true,
		});
		assertEqual(noName.error, 'nametag_required');

		// ─────────────────────────────────────────────
		// 7. REST + WS: both from same player = single effect
		// ─────────────────────────────────────────────
		await setupMatch(server, 't-rest3', 'fran', 'greg');
		// Both need WS connections so the offline-auto-ready doesn't fire
		const franWs = await wsConnect(server.port, 'fran');
		const gregWs = await wsConnect(server.port, 'greg');
		await sleep(100);
		franWs.send({ type: 'match-ready', matchId: 't-rest3/R0M0' });
		await sleep(100);

		const also = await api(server, '/api/tournaments/t-rest3/matches/0/0/ready', {
			method: 'POST', body: { nametag: 'fran' }, asNametag: 'fran',
		});
		assertEqual(also.status, 'ok');

		const state3 = await api(server, '/api/tournaments/t-rest3/matches/0/0/state');
		const franSide = state3.playerA === 'fran' ? 'A' : 'B';
		assertEqual(state3.ready[franSide], true);
		// greg should still be not ready
		const gregSide = franSide === 'A' ? 'B' : 'A';
		assertEqual(state3.ready[gregSide], false);
		franWs.close();
		gregWs.close();

		// ─────────────────────────────────────────────
		// 8. Zombie WS: REST ready still advances (the whole point)
		// ─────────────────────────────────────────────
		await setupMatch(server, 't-rest4', 'hank', 'iris');

		// Hank connects and registers, THEN goes zombie (silenced). Once silent,
		// his WS match-ready would silently drop — REST is the only way out.
		const hank = await chaosConnect({
			port: server.port,
			nametag: 'hank',
			onOpen: async (c) => {
				c.send({ type: 'register', identity: { nametag: 'hank' } });
			},
		});
		await sleep(100); // let the register land so server has hank in players map
		hank.setMode('zombie');

		// Iris readies over normal WS
		const iris = await wsConnect(server.port, 'iris');
		await sleep(100);
		iris.send({ type: 'match-ready', matchId: 't-rest4/R0M0' });
		await sleep(100);

		// Hank's WS is zombie — but REST ready works
		const zResult = await api(server, '/api/tournaments/t-rest4/matches/0/0/ready', {
			method: 'POST', body: { nametag: 'hank' }, asNametag: 'hank',
		});
		assertEqual(zResult.status, 'ok');
		assertEqual(zResult.phase, 'started', 'both now ready, match starts');

		const state4 = await api(server, '/api/tournaments/t-rest4/matches/0/0/state');
		assertEqual(state4.phase, 'active');

		hank.close();
		iris.close();
	} finally {
		await stopServer(server.proc);
	}
});
