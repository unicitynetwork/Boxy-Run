/**
 * Input message validation — guards against malformed / malicious inputs
 * hitting the WS input relay.
 *
 *   - Input from non-participant: dropped silently (no relay, no storage)
 *   - Malformed base64: stored but ignored on replay (no crash)
 *   - Input before match becomes active: dropped
 *   - Input for nonexistent match: dropped
 *   - Duplicate ticks stored cumulatively (replay applies both)
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
} from './harness';

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
		const waiters: any[] = [];
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
		ws.on('open', () => {
			ws.send(JSON.stringify({ type: 'register', identity: { nametag } }));
			resolve({
				ws, messages,
				waitFor(type, timeout = 3000) {
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

async function setupActiveMatch(server: { port: number }, tid: string, a: string, b: string) {
	await api(server, '/api/tournaments', {
		method: 'POST', asAdmin: true,
		body: { id: tid, name: tid, maxPlayers: 2 },
	});
	await api(server, '/api/tournaments/' + tid + '/register', {
		method: 'POST', body: { nametag: a },
	});
	await api(server, '/api/tournaments/' + tid + '/register', {
		method: 'POST', body: { nametag: b },
	});
	await api(server, '/api/tournaments/' + tid + '/start', {
		method: 'POST', asAdmin: true,
	});
	const matchId = `${tid}/R0M0`;
	const wsA = await wsConnect(server.port, a);
	const wsB = await wsConnect(server.port, b);
	await sleep(100);
	wsA.send({ type: 'match-ready', matchId });
	wsB.send({ type: 'match-ready', matchId });
	await wsA.waitFor('match-start');
	await wsB.waitFor('match-start');
	return { matchId, wsA, wsB };
}

runTest('input: from non-participant is silently dropped', async () => {
	const server = await startServer();
	try {
		const { matchId, wsA, wsB } = await setupActiveMatch(server, 'iv-1', 'alice', 'bob');

		// Eve is a registered socket but NOT a participant in this match
		const eve = await wsConnect(server.port, 'eve_outsider');
		await sleep(100);

		const beforeInputs = wsA.messages.filter((m) => m.type === 'opponent-input').length;
		eve.send({ type: 'input', matchId, tick: 100, payload: Buffer.from('up').toString('base64') });
		// Small wait for relay or no-relay
		await sleep(200);

		const afterInputs = wsA.messages.filter((m) => m.type === 'opponent-input').length;
		assertEqual(afterInputs, beforeInputs, 'eve\'s input did not reach alice');

		wsA.close();
		wsB.close();
		eve.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('input: normal relay works — opponent receives it', async () => {
	const server = await startServer();
	try {
		const { matchId, wsA, wsB } = await setupActiveMatch(server, 'iv-2', 'carol', 'dave');

		wsA.send({ type: 'input', matchId, tick: 100, payload: Buffer.from('up').toString('base64') });
		const relay = await wsB.waitFor('opponent-input');
		assertEqual(relay.matchId, matchId);
		assertEqual(relay.tick, 100);

		wsA.close();
		wsB.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('input: malformed payload stored and later skipped on replay — no crash', async () => {
	const server = await startServer();
	try {
		const { matchId, wsA, wsB } = await setupActiveMatch(server, 'iv-3', 'eve', 'frank');

		// Bad payloads
		wsA.send({ type: 'input', matchId, tick: 100, payload: 'not-base64-at-all' });
		wsA.send({ type: 'input', matchId, tick: 110, payload: '' });
		wsA.send({ type: 'input', matchId, tick: 120, payload: Buffer.from('unknown_action').toString('base64') });
		// One valid input so the test proves the pipeline still works
		wsA.send({ type: 'input', matchId, tick: 130, payload: Buffer.from('up').toString('base64') });
		await sleep(200);

		// Resolve and assert no crash
		wsA.send({ type: 'match-done', matchId });
		wsB.send({ type: 'match-done', matchId });
		const end = await wsA.waitFor('match-end');
		assert(end.winner, 'match resolved despite bad inputs');

		wsA.close();
		wsB.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('input: before match active is dropped (no crash, no relay)', async () => {
	const server = await startServer();
	try {
		await api(server, '/api/tournaments', {
			method: 'POST', asAdmin: true,
			body: { id: 'iv-4', name: 'iv-4', maxPlayers: 2 },
		});
		await api(server, '/api/tournaments/iv-4/register', { method: 'POST', body: { nametag: 'gil' } });
		await api(server, '/api/tournaments/iv-4/register', { method: 'POST', body: { nametag: 'helen' } });
		await api(server, '/api/tournaments/iv-4/start', { method: 'POST', asAdmin: true });

		const gil = await wsConnect(server.port, 'gil');
		const helen = await wsConnect(server.port, 'helen');
		await sleep(100);

		// Send input BEFORE readying — match is in ready_wait, not active
		gil.send({ type: 'input', matchId: 'iv-4/R0M0', tick: 10, payload: Buffer.from('up').toString('base64') });
		await sleep(200);

		// helen should NOT have received an opponent-input
		const relays = helen.messages.filter((m) => m.type === 'opponent-input');
		assertEqual(relays.length, 0, 'no relay for pre-active input');

		gil.close();
		helen.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('input: nonexistent match is silently dropped', async () => {
	const server = await startServer();
	try {
		const alice = await wsConnect(server.port, 'alice');
		await sleep(100);

		// No tournament, no match, no participant
		alice.send({ type: 'input', matchId: 'ghost/R0M0', tick: 1, payload: Buffer.from('up').toString('base64') });
		await sleep(200);

		// No error, no crash — just nothing
		const errors = alice.messages.filter((m) => m.type === 'error');
		assertEqual(errors.length, 0, 'no error response for ghost-match input');

		alice.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('input: unknown action types relay but don\'t crash replay', async () => {
	const server = await startServer();
	try {
		const { matchId, wsA, wsB } = await setupActiveMatch(server, 'iv-6', 'ivy', 'jack');

		// "teleport" is not a valid action; server stores the payload and
		// replay rejects it as not matching up/left/right/fire.
		wsA.send({ type: 'input', matchId, tick: 50, payload: Buffer.from('teleport').toString('base64') });
		await sleep(100);

		wsA.send({ type: 'match-done', matchId });
		wsB.send({ type: 'match-done', matchId });
		const end = await wsA.waitFor('match-end');
		assert(end.winner, 'match still resolved with unknown action in input trace');

		wsA.close();
		wsB.close();
	} finally {
		await stopServer(server.proc);
	}
});
