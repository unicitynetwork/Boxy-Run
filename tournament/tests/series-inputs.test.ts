/**
 * Series input tagging — REGRESSION for "I won but got a loss" prod bug.
 *
 * The state machine tracks currentGame, but `handleInput` was reading
 * currentGame from the legacy `tournamentSeries` map, which stopped
 * being incremented after the state-machine refactor. Consequence:
 * every game after game 1 stored its inputs under the game-1 tag,
 * and the replay (which looks up the game-N tag) found nothing —
 * both sims fell back to the deterministic no-input run, which
 * produces a tie, which by tiebreak rule picks player A regardless
 * of what the actual players did.
 *
 * This test ensures game 2's inputs actually affect game 2's replayed
 * scores. If they don't, scoreA === scoreB (deterministic tie) and
 * the test fails.
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

runTest('series-inputs: game 2 inputs are tagged with currentGame (not overwritten as g1)', async () => {
	const server = await startServer();
	try {
		// Use Bo5 so game 2 is always an interim game (emits game-result, not
		// match-end). Bo3 would end the series at 2-0 if alice sweeps, and
		// match-end's scoreA/scoreB are series wins (not game scores) — which
		// would mask the bug.
		const tid = 'si-bo5';
		await api(server, '/api/tournaments', {
			method: 'POST', asAdmin: true,
			body: { id: tid, name: tid, maxPlayers: 2, bestOf: 5 },
		});
		await api(server, `/api/tournaments/${tid}/register`, { method: 'POST', body: { nametag: 'alice' } });
		await api(server, `/api/tournaments/${tid}/register`, { method: 'POST', body: { nametag: 'bob' } });
		await api(server, `/api/tournaments/${tid}/start`, { method: 'POST', asAdmin: true });

		const alice = await wsConnect(server.port, 'alice');
		const bob = await wsConnect(server.port, 'bob');
		await sleep(100);

		const matchId = `si-bo5/R0M0`;

		// Game 1 — both ready, alice sends some inputs, both done
		alice.send({ type: 'match-ready', matchId });
		bob.send({ type: 'match-ready', matchId });
		await alice.waitFor('match-start');
		await bob.waitFor('match-start');

		// Alice jumps at a range of ticks (more than enough to change her sim
		// trajectory vs no-input bob)
		for (const tick of [10, 40, 80, 120, 160, 200, 240, 280, 320, 360]) {
			alice.send({ type: 'input', matchId, tick, payload: Buffer.from('up').toString('base64') });
		}
		await sleep(50); // let stores complete

		alice.send({ type: 'match-done', matchId });
		bob.send({ type: 'match-done', matchId });
		const g1 = await alice.waitFor('game-result');
		assertEqual(g1.gameNumber, 1);
		// Alice's inputs changed her sim, so scores must differ for game 1.
		// If this fails, something much more fundamental is wrong.
		assert(g1.scoreA !== g1.scoreB, `game 1 scores must differ (had inputs): A=${g1.scoreA} B=${g1.scoreB}`);

		// Series-next for game 2
		const next = await alice.waitFor('series-next');
		assertEqual(next.gameNumber, 2);
		await bob.waitFor('series-next');

		// Game 2 — re-ready, alice sends DIFFERENT inputs, both done
		alice.send({ type: 'match-ready', matchId });
		bob.send({ type: 'match-ready', matchId });
		await alice.waitFor('match-start');
		await bob.waitFor('match-start');

		// Alice sends a distinct input pattern for game 2. With the bug,
		// these would be stored under tag "A" (game-1 key), replay would
		// look up "A:g2" and find empty → both sims tie → scoreA === scoreB.
		for (const tick of [15, 50, 100, 150, 200, 250, 300, 350, 400]) {
			alice.send({ type: 'input', matchId, tick, payload: Buffer.from('up').toString('base64') });
		}
		await sleep(50);

		alice.send({ type: 'match-done', matchId });
		bob.send({ type: 'match-done', matchId });
		// Bo5 → game 2 is always interim → game-result (not match-end).
		// scoreA and scoreB are GAME scores (not series wins). With the bug,
		// replay looks up "A:g2"/"B:g2" → empty → both sims deterministic →
		// identical scores. Without the bug, alice's inputs change her sim
		// trajectory → scores differ.
		const g2 = await alice.waitFor('game-result', 8000);
		assertEqual(g2.gameNumber, 2, 'this is the game-2 result');
		assert(g2.scoreA !== undefined && g2.scoreB !== undefined, 'game 2 scores present');
		assert(
			g2.scoreA !== g2.scoreB,
			`game 2 scores must differ (alice had inputs, bob didn't): A=${g2.scoreA} B=${g2.scoreB}. ` +
			`If equal, inputs weren't tagged with the right game number.`,
		);

		alice.close();
		bob.close();
	} finally {
		await stopServer(server.proc);
	}
});
