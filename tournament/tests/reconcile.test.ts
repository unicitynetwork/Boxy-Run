/**
 * Reconciliation tick tests — exercise the state-based timeouts
 * (ready-TTL 30s, offline auto-ready 5s, offline auto-done 30s) using
 * the fake clock instead of real wall-time waiting.
 *
 * The server's reconciliation tick runs every 1s in the background.
 * We advance the fake clock, then sleep briefly to let the next tick
 * observe the new elapsed time and take action.
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
		ws.on('open', () => {
			ws.send(JSON.stringify({ type: 'register', identity: { nametag } }));
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
		method: 'POST', body: { nametag: a },
	});
	await api(server, '/api/tournaments/' + tid + '/register', {
		method: 'POST', body: { nametag: b },
	});
	await api(server, '/api/tournaments/' + tid + '/start', {
		method: 'POST', asAdmin: true,
	});
}

/** Wait for the next reconciliation tick to fire (server runs every 1s). */
async function tickOnce() {
	await sleep(1200);
}

runTest('reconcile: ready TTL expires after 30s', async () => {
	const server = await startServer();
	try {
		await setupMatch(server, 't-ttl', 'alice', 'bob');
		// Both online so no offline auto-ready fires
		const a = await wsConnect(server.port, 'alice');
		const b = await wsConnect(server.port, 'bob');
		await sleep(100);

		// Alice readies; bob stays silent
		a.send({ type: 'match-ready', matchId: 't-ttl/R0M0' });
		await a.waitFor('match-status');

		const before = await api(server, '/api/tournaments/t-ttl/matches/0/0/state');
		const aliceSide = before.playerA === 'alice' ? 'A' : 'B';
		assertEqual(before.ready[aliceSide], true, 'alice flag set');

		// Advance 35s → past the 30s TTL. Next tick should clear flags.
		await advanceClock(server, 35_000);
		await tickOnce();

		const after = await api(server, '/api/tournaments/t-ttl/matches/0/0/state');
		assertEqual(after.phase, 'ready_wait', 'still in ready_wait, not expired-to-forfeit');
		// Flags should be cleared now
		assertEqual(after.ready[aliceSide], false, 'alice flag cleared by TTL');
		assertEqual(after.ready[aliceSide === 'A' ? 'B' : 'A'], false);

		// Alice should have received ready-expired
		const expired = a.messages.find((m) => m.type === 'ready-expired');
		assert(expired, 'ready-expired notification sent');

		a.close();
		b.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('reconcile: offline opponent auto-readied after 5s', async () => {
	const server = await startServer();
	try {
		await setupMatch(server, 't-off5', 'carol', 'dave');
		// Both come online so the sync offline-auto-ready in applyReady doesn't fire
		const c = await wsConnect(server.port, 'carol');
		const d = await wsConnect(server.port, 'dave');
		await sleep(100);

		c.send({ type: 'match-ready', matchId: 't-off5/R0M0' });
		await c.waitFor('match-status');

		// Dave disconnects, leaving carol waiting. Match stays in ready_wait.
		d.close();
		await sleep(100);

		const before = await api(server, '/api/tournaments/t-off5/matches/0/0/state');
		const carolSide = before.playerA === 'carol' ? 'A' : 'B';
		assertEqual(before.ready[carolSide], true);

		// Advance 6s → past the 5s offline grace
		await advanceClock(server, 6_000);
		await tickOnce();

		// Match should have started (both flags set, match transitions to active)
		const after = await api(server, '/api/tournaments/t-off5/matches/0/0/state');
		assertEqual(after.phase, 'active', 'match started after auto-ready of offline dave');

		c.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('reconcile: online opponent NOT auto-readied even after 30s', async () => {
	const server = await startServer();
	try {
		await setupMatch(server, 't-noauto', 'eve', 'frank');
		const e = await wsConnect(server.port, 'eve');
		const f = await wsConnect(server.port, 'frank');
		await sleep(100);

		e.send({ type: 'match-ready', matchId: 't-noauto/R0M0' });
		await e.waitFor('match-status');

		// Advance 20s but keep frank ONLINE. The reconciler should NOT auto-ready him.
		await advanceClock(server, 20_000);
		await tickOnce();

		const mid = await api(server, '/api/tournaments/t-noauto/matches/0/0/state');
		assertEqual(mid.phase, 'ready_wait', 'still waiting for frank');
		const frankSide = mid.playerA === 'frank' ? 'A' : 'B';
		assertEqual(mid.ready[frankSide], false, 'frank NOT auto-readied while online');

		// Pass the 30s TTL → flags cleared
		await advanceClock(server, 15_000);
		await tickOnce();

		const after = await api(server, '/api/tournaments/t-noauto/matches/0/0/state');
		const eveSide = mid.playerA === 'eve' ? 'A' : 'B';
		assertEqual(after.ready[eveSide], false, 'eve flag cleared by TTL');
		assertEqual(after.phase, 'ready_wait');

		e.close();
		f.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('reconcile: opponent offline after match-done → auto-done at 30s', async () => {
	const server = await startServer();
	try {
		await setupMatch(server, 't-done30', 'gil', 'helen');
		const g = await wsConnect(server.port, 'gil');
		const h = await wsConnect(server.port, 'helen');
		await sleep(100);
		g.send({ type: 'match-ready', matchId: 't-done30/R0M0' });
		h.send({ type: 'match-ready', matchId: 't-done30/R0M0' });
		await g.waitFor('match-start');
		await h.waitFor('match-start');

		// Gil finishes; helen disconnects without finishing
		g.send({ type: 'match-done', matchId: 't-done30/R0M0' });
		await sleep(100);
		h.close();
		await sleep(200);

		// Before 30s: still active, helen not done
		const before = await api(server, '/api/tournaments/t-done30/matches/0/0/state');
		assertEqual(before.phase, 'active');
		const helenSide = before.playerA === 'helen' ? 'A' : 'B';
		assertEqual(before.done[helenSide], false, 'helen not auto-done yet');

		// Advance 35s past the 30s grace
		await advanceClock(server, 35_000);
		await tickOnce();
		// Give the handleDone resolution a moment to run
		await sleep(300);

		const after = await api(server, '/api/tournaments/t-done30/matches/0/0/state');
		assertEqual(after.phase, 'complete', 'match resolved after helen auto-done');
		assert(after.winner, 'winner set');

		g.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('reconcile: active-branch ready TTL force-readies a no-show opponent', async () => {
	// Scenario: challenge flow where match goes straight to 'active' on accept.
	// Player A clicks READY on the game page; player B leaves challenge.html
	// open but never navigates to the game. A should not hang forever.
	const server = await startServer();
	try {
		// Simulate a challenge acceptance by creating a 2-player tournament and
		// starting a match directly (without going through ready_wait).
		await api(server, '/api/tournaments', {
			method: 'POST', asAdmin: true,
			body: { id: 'ar-ttl', name: 'ar-ttl', maxPlayers: 2 },
		});
		await api(server, '/api/tournaments/ar-ttl/register', {
			method: 'POST', body: { nametag: 'ready_player' },
		});
		await api(server, '/api/tournaments/ar-ttl/register', {
			method: 'POST', body: { nametag: 'noshow_player' },
		});
		await api(server, '/api/tournaments/ar-ttl/start', {
			method: 'POST', asAdmin: true,
		});

		// Both players connect over WS so neither appears "offline" in the
		// applyReady sync path (we want to test the TTL reconciler, not the
		// immediate offline-auto-ready).
		const ready = await wsConnect(server.port, 'ready_player');
		const noshow = await wsConnect(server.port, 'noshow_player');
		await sleep(100);

		// Kick the match into 'active' by having both do the initial ready_wait handshake
		ready.send({ type: 'match-ready', matchId: 'ar-ttl/R0M0' });
		noshow.send({ type: 'match-ready', matchId: 'ar-ttl/R0M0' });
		await ready.waitFor('match-start');
		await noshow.waitFor('match-start');

		// Now simulate the challenge re-ready phase: ready_player clicks READY
		// again (active-branch of applyReady). noshow never does.
		ready.send({ type: 'match-ready', matchId: 'ar-ttl/R0M0' });
		await sleep(200);

		// Before TTL: the ready flag is set, but match-status shows only one ready
		const before = await api(server, '/api/tournaments/ar-ttl/matches/0/0/state');
		assertEqual(before.phase, 'active', 'still active');

		// Advance past 30s TTL and let the tick observe
		await advanceClock(server, 35_000);
		await tickOnce();

		// The reconciler should have auto-readied the no-show. Inspect match-status
		// pushed to the ready player — both should now be ready.
		const statuses = ready.messages.filter((m: any) => m.type === 'match-status');
		const lastStatus = statuses[statuses.length - 1];
		assert(lastStatus, 'ready_player received a match-status push');
		assertEqual(lastStatus.readyA && lastStatus.readyB, true,
			'both flags set after TTL force-ready');

		ready.close();
		noshow.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('reconcile: reconcileMatch is idempotent', async () => {
	const server = await startServer();
	try {
		await setupMatch(server, 't-idem', 'ivy', 'jack');
		const i = await wsConnect(server.port, 'ivy');
		const j = await wsConnect(server.port, 'jack');
		await sleep(100);

		i.send({ type: 'match-ready', matchId: 't-idem/R0M0' });
		await i.waitFor('match-status');

		// Advance past TTL so reconciler fires expiry
		await advanceClock(server, 35_000);
		await tickOnce();

		const after1 = await api(server, '/api/tournaments/t-idem/matches/0/0/state');
		const ivySide = after1.playerA === 'ivy' ? 'A' : 'B';
		assertEqual(after1.ready[ivySide], false);

		// Wait another tick — reconciler should see no state change
		await tickOnce();
		const after2 = await api(server, '/api/tournaments/t-idem/matches/0/0/state');
		assertEqual(after2.phase, 'ready_wait');
		assertEqual(after2.ready[ivySide], false);

		i.close();
		j.close();
	} finally {
		await stopServer(server.proc);
	}
});
