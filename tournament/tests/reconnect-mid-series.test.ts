/**
 * Reconnect mid-series — a player drops their WS between games and
 * reconnects with a new one. The match state must survive.
 *
 * REGRESSION SHAPE: the pre-refactor code kept series state in a
 * legacy in-memory map that was never synced with the machine. A
 * reconnect could observe a stale currentGame and misroute inputs.
 * With the machine as the single source of truth, reconnect just
 * re-registers the socket and the machine keeps ticking.
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

runTest('reconnect: alice reconnects between game 1 and game 2 of a Bo3 — series state survives', async () => {
	const server = await startServer();
	try {
		const tid = 'rc-bo3';
		await api(server, '/api/tournaments', {
			method: 'POST', asAdmin: true,
			body: { id: tid, name: tid, maxPlayers: 2, bestOf: 3 },
		});
		await api(server, `/api/tournaments/${tid}/register`, { method: 'POST', body: { nametag: 'alice' } });
		await api(server, `/api/tournaments/${tid}/register`, { method: 'POST', body: { nametag: 'bob' } });
		await api(server, `/api/tournaments/${tid}/start`, { method: 'POST', asAdmin: true });

		let alice = await wsConnect(server.port, 'alice');
		const bob = await wsConnect(server.port, 'bob');
		await sleep(100);

		const matchId = `${tid}/R0M0`;

		// Game 1 handshake + done
		alice.send({ type: 'match-ready', matchId });
		bob.send({ type: 'match-ready', matchId });
		await alice.waitFor('match-start');
		await bob.waitFor('match-start');

		alice.send({ type: 'match-done', matchId });
		bob.send({ type: 'match-done', matchId });
		const g1 = await alice.waitFor('game-result');
		assertEqual(g1.gameNumber, 1);

		// series-next for game 2
		await alice.waitFor('series-next');
		await bob.waitFor('series-next');

		// ── Alice reconnects between games ──
		alice.close();
		await sleep(300); // let server process the close
		alice = await wsConnect(server.port, 'alice');
		await sleep(200);

		// Verify server still knows Alice's mid-series state.
		const midState = await api(server, `/api/tournaments/${tid}/matches/0/0/state`) as any;
		assertEqual(midState.phase, 'active');
		assert(midState.series, 'series object present after reconnect');
		assertEqual(midState.series.currentGame, 2, 'currentGame is 2 — state survived reconnect');
		assertEqual(midState.series.winsA + midState.series.winsB, 1, 'exactly one series win recorded');

		// Game 2 handshake + done — alice's new socket must still drive the machine
		alice.send({ type: 'match-ready', matchId });
		bob.send({ type: 'match-ready', matchId });
		await alice.waitFor('match-start');
		await bob.waitFor('match-start');

		alice.send({ type: 'match-done', matchId });
		bob.send({ type: 'match-done', matchId });
		// Either game-result (series continues) or match-end (2-0 sweep).
		const ended = await Promise.race([
			alice.waitFor('game-result', 6000).then((m) => ({ kind: 'game-result', m })).catch(() => null),
			alice.waitFor('match-end', 6000).then((m) => ({ kind: 'match-end', m })).catch(() => null),
		]);
		assert(ended, 'alice receives a game-result or match-end after reconnect + game 2');

		alice.close();
		bob.close();
	} finally {
		await stopServer(server.proc);
	}
});
