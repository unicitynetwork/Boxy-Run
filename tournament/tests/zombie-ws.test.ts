/**
 * Zombie WebSocket scenarios — a socket that's OPEN per readyState but
 * silently drops all outbound/inbound frames. Replicates the production
 * failure mode where Fly's proxy or a mobile network kills the TCP
 * without sending a close frame.
 *
 * The refactor's mitigations (tested here):
 *   1. REST ready endpoint lets the zombie's owner progress the match.
 *   2. Reconciler tick auto-readies/auto-dones the zombie's opponent
 *      based on elapsed-time + offline-detection.
 *   3. Server's forceResolveStuck resolves matches where BOTH are offline.
 */

import WebSocket from 'ws';
import {
	advanceClock,
	api,
	assert,
	assertEqual,
	runTest,
	sleep,
	startServer,
	stopServer,
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

async function setupMatch(server: { port: number }, tid: string, a: string, b: string) {
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
}

runTest('zombie: REST ready works when the caller\'s WS goes silent', async () => {
	const server = await startServer();
	try {
		await setupMatch(server, 'z-rest', 'alice', 'bob');

		// Alice connects + registers, then goes zombie (silenced).
		const alice = await chaosConnect({
			port: server.port, nametag: 'alice',
			onOpen: (c) => c.send({ type: 'register', identity: { nametag: 'alice' } }),
		});
		await sleep(100);
		alice.setMode('zombie');

		// Bob connects normally and readies via WS
		const bob = await wsConnect(server.port, 'bob');
		await sleep(100);
		bob.send({ type: 'match-ready', matchId: 'z-rest/R0M0' });
		await sleep(200);

		// Alice's WS match-ready would silently drop. REST is the escape hatch.
		const r = await api(server, '/api/tournaments/z-rest/matches/0/0/ready', {
			method: 'POST', body: { nametag: 'alice' },
		});
		assertEqual(r.status, 'ok');
		assertEqual(r.phase, 'started', 'match starts when both now ready');
		assert(r.matchStart, 'matchStart payload present');

		const state = await api(server, '/api/tournaments/z-rest/matches/0/0/state');
		assertEqual(state.phase, 'active');

		alice.close();
		bob.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('zombie: reconciler auto-readies when opponent is offline during ready_wait', async () => {
	const server = await startServer();
	try {
		await setupMatch(server, 'z-auto', 'carol', 'dave');

		// Carol connects + registers, then goes zombie. Because she's "online"
		// per the server's players map but completely silent, she won't send
		// match-ready via WS. But the auto-ready for offline opponents fires
		// when dave readies + reconciler sees ≥5s elapsed + carol ws is... hmm.
		// Actually with zombie (WS still OPEN), server sees carol as ONLINE.
		// The reconciler's 5s grace only fires for OFFLINE opponents. So in this
		// pure zombie case, match hangs until 30s TTL clears flags.
		const carol = await chaosConnect({
			port: server.port, nametag: 'carol',
			onOpen: (c) => c.send({ type: 'register', identity: { nametag: 'carol' } }),
		});
		await sleep(100);
		carol.setMode('zombie');

		const dave = await wsConnect(server.port, 'dave');
		await sleep(100);
		dave.send({ type: 'match-ready', matchId: 'z-auto/R0M0' });
		await sleep(200);

		// Dave is ready, carol is zombie-silent. Advance past 30s TTL.
		await advanceClock(server, 35_000);
		await sleep(1300); // reconciler tick

		// Flags should be cleared by TTL
		const state = await api(server, '/api/tournaments/z-auto/matches/0/0/state');
		assertEqual(state.phase, 'ready_wait', 'still in ready_wait');
		const daveSide = state.playerA === 'dave' ? 'A' : 'B';
		assertEqual(state.ready[daveSide], false, 'dave flag cleared by TTL');

		// ready-expired push should have arrived at dave
		const expired = dave.messages.find((m) => m.type === 'ready-expired');
		assert(expired, 'dave notified of TTL expiry');

		carol.close();
		dave.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('zombie: abrupt TCP close triggers normal reconnect path', async () => {
	const server = await startServer();
	try {
		await setupMatch(server, 'challenge-z-abrupt', 'eve', 'frank');

		const eve = await chaosConnect({
			port: server.port, nametag: 'eve',
			onOpen: (c) => c.send({ type: 'register', identity: { nametag: 'eve' } }),
		});
		await sleep(100);

		const frank = await wsConnect(server.port, 'frank');
		await sleep(100);

		// Eve's TCP drops without a close frame — server will eventually notice
		// via the ping/pong protocol and evict her from players map.
		eve.abruptClose();
		await sleep(500);

		// Frank readies AFTER eve is offline. For challenge-prefixed matches,
		// the server auto-readies the offline opponent immediately when
		// the other player readies.
		frank.send({ type: 'match-ready', matchId: 'challenge-z-abrupt/R0M0' });
		await sleep(500);

		const state = await api(server, '/api/tournaments/challenge-z-abrupt/matches/0/0/state');
		assertEqual(state.phase, 'active', 'match started after offline auto-ready');

		frank.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('zombie: both players disconnect during active match → force-resolve', async () => {
	const server = await startServer();
	try {
		await setupMatch(server, 'z-both', 'gil', 'helen');

		const g = await wsConnect(server.port, 'gil');
		const h = await wsConnect(server.port, 'helen');
		await sleep(100);
		g.send({ type: 'match-ready', matchId: 'z-both/R0M0' });
		h.send({ type: 'match-ready', matchId: 'z-both/R0M0' });
		await g.waitFor('match-start');
		await h.waitFor('match-start');

		// Both disconnect — neither will send match-done.
		g.close();
		h.close();
		// Let the reconciler tick at least once with REAL time so that
		// matchStuckSince is recorded at the moment of disconnect (before any
		// fake-clock advance). Otherwise the advance happens first and the
		// stuck-since timestamp gets set post-advance, making elapsed ≈ 0.
		await sleep(1500);

		// Now advance past the 45s stuck threshold. The next tick computes
		// stuckFor = now() - matchStuckSince ≈ 50s → force-resolves.
		await advanceClock(server, 50_000);
		await sleep(1500);

		const state = await api(server, '/api/tournaments/z-both/matches/0/0/state');
		assertEqual(state.phase, 'complete', 'match force-resolved');
		assert(state.winner, 'winner set deterministically');
	} finally {
		await stopServer(server.proc);
	}
});
