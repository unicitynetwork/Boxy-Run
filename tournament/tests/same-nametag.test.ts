/**
 * Same-nametag reconnect — second WS with the same identity displaces
 * the first. No state corruption; match-level state (readyFlags, matchSides)
 * persists across the swap.
 *
 * This is the "user refreshes the page" scenario in production.
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

runTest('same-nametag: second WS displaces first, match state preserved', async () => {
	const server = await startServer();
	try {
		await api(server, '/api/tournaments', {
			method: 'POST', asAdmin: true,
			body: { id: 'sn-1', name: 'sn-1', maxPlayers: 2 },
		});
		await api(server, '/api/tournaments/sn-1/register', { method: 'POST', body: { nametag: 'alice' } });
		await api(server, '/api/tournaments/sn-1/register', { method: 'POST', body: { nametag: 'bob' } });
		await api(server, '/api/tournaments/sn-1/start', { method: 'POST', asAdmin: true });

		const alice1 = await wsConnect(server.port, 'alice');
		const bob = await wsConnect(server.port, 'bob');
		await sleep(100);

		alice1.send({ type: 'match-ready', matchId: 'sn-1/R0M0' });
		bob.send({ type: 'match-ready', matchId: 'sn-1/R0M0' });
		await alice1.waitFor('match-start');
		await bob.waitFor('match-start');

		// Alice "refreshes": a second WS with the same nametag
		const alice2 = await wsConnect(server.port, 'alice');
		await sleep(200);

		// The new socket re-readies (via active-match branch → re-sends match-start)
		alice2.send({ type: 'match-ready', matchId: 'sn-1/R0M0' });
		const restart = await alice2.waitFor('match-start');
		assertEqual(restart.matchId, 'sn-1/R0M0');

		// Bob can still send inputs that reach the NEW alice socket, not the old one
		bob.send({ type: 'input', matchId: 'sn-1/R0M0', tick: 50, payload: Buffer.from('up').toString('base64') });
		const relay = await alice2.waitFor('opponent-input');
		assertEqual(relay.tick, 50);

		// Old socket should NOT get bob's input (routing moved to alice2)
		// Note: alice1's socket may still be open at the TCP level — we just
		// no longer route messages to it. We can only check that alice1 didn't
		// receive bob's post-swap input.
		await sleep(100);
		const oldRelays = alice1.messages.filter((m) => m.type === 'opponent-input' && m.tick === 50);
		assertEqual(oldRelays.length, 0, 'old socket did not receive new input');

		alice1.close();
		alice2.close();
		bob.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('same-nametag: rapid reconnect doesn\'t corrupt active match', async () => {
	const server = await startServer();
	try {
		await api(server, '/api/tournaments', {
			method: 'POST', asAdmin: true,
			body: { id: 'challenge-sn-2', name: 'sn-2', maxPlayers: 2 },
		});
		await api(server, '/api/tournaments/challenge-sn-2/register', { method: 'POST', body: { nametag: 'carol' } });
		await api(server, '/api/tournaments/challenge-sn-2/register', { method: 'POST', body: { nametag: 'dave' } });
		await api(server, '/api/tournaments/challenge-sn-2/start', { method: 'POST', asAdmin: true });

		// Both players need to actually ready up — auto-ready of offline
		// opponents is disabled (READY_OFFLINE_GRACE_MS = Infinity), so
		// dave can't sit out and have the match start without him.
		const carol = await wsConnect(server.port, 'carol');
		const dave = await wsConnect(server.port, 'dave');
		await sleep(100);
		carol.send({ type: 'match-ready', matchId: 'challenge-sn-2/R0M0' });
		dave.send({ type: 'match-ready', matchId: 'challenge-sn-2/R0M0' });
		await carol.waitFor('match-start');
		await dave.waitFor('match-start');

		// Carol refreshes her page 3 times in quick succession. Each
		// close() emits a TCP FIN; we sleep 200ms between attempts to
		// give the server time to process the unregister before the
		// new socket arrives — without this gap the players-map swap
		// races and the test goes flaky.
		let current = carol;
		for (let i = 0; i < 3; i++) {
			current.close();
			await sleep(200);
			current = await wsConnect(server.port, 'carol');
			await sleep(150);
		}

		// Match is still active — the reconnects didn't corrupt anything
		const state = await api(server, '/api/tournaments/challenge-sn-2/matches/0/0/state');
		assertEqual(state.phase, 'active');
		assertEqual(state.playerA === 'carol' || state.playerB === 'carol', true);

		current.close();
		dave.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('same-nametag: register message is idempotent (re-sending it works)', async () => {
	const server = await startServer();
	try {
		const c = await wsConnect(server.port, 'eve');
		await sleep(100);
		const first = await c.waitFor('registered');
		assertEqual(first.nametag, 'eve');

		// Re-send register on the SAME socket — sessionId is reusable
		// for the lifetime of the session, so we mint once and replay it.
		c.send({ type: 'register', identity: { nametag: 'eve' } });
		const second = await c.waitFor('registered');
		assertEqual(second.nametag, 'eve');

		c.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('same-nametag: two sockets, second one gets the pushes', async () => {
	const server = await startServer();
	try {
		const frank1 = await wsConnect(server.port, 'frank');
		await sleep(100);
		const frank2 = await wsConnect(server.port, 'frank');
		await sleep(100);

		// Now have someone challenge frank. Only the NEWER socket (frank2)
		// should receive the challenge-received push.
		const gil = await wsConnect(server.port, 'gil_challenger');
		await sleep(100);
		await api(server, '/api/challenges', {
			method: 'POST',
			body: { from: 'gil_challenger', opponent: 'frank' },
		});

		const msg2 = await frank2.waitFor('challenge-received', 2000);
		assertEqual(msg2.from, 'gil_challenger');

		// frank1 should NOT have received it (routing moved to frank2)
		await sleep(200);
		const frank1Msgs = frank1.messages.filter((m) => m.type === 'challenge-received');
		assertEqual(frank1Msgs.length, 0, 'old socket did not get the push');

		frank1.close();
		frank2.close();
		gil.close();
	} finally {
		await stopServer(server.proc);
	}
});
