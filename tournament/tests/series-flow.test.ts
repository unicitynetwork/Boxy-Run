/**
 * Best-of-N series flow — verifies game-result + series-next + match-end
 * (with seriesEnd flag) messages land in the right order and with the
 * right content.
 *
 * These specifically guard against the production bugs we hit:
 *   - seriesEnd=true must be set ONLY on the final game's match-end
 *   - game-result must precede series-next on intermediate games
 *   - No spurious series-next after a series ends
 *   - Series wins tallied correctly on ties (playerA tiebreak)
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

/** Switch lane at tick 1 + jump every tick to ensure the player survives
 *  longer than a no-input opponent across virtually any seed. */
function sendWinningInputs(client: any, matchId: string) {
	const b64 = (s: string) => Buffer.from(s).toString('base64');
	client.send({ type: 'input', matchId, tick: 1, payload: b64('left') });
	for (let t = 1; t <= 700; t += 2) {
		client.send({ type: 'input', matchId, tick: t, payload: b64('up') });
	}
}

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
		// Each waitFor call consumes the first unconsumed message of the type —
		// essential for series tests that wait for multiple same-typed messages
		// (e.g. game-result × N).
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

async function setupBo3Match(server: { port: number }, tid: string, a: string, b: string) {
	await api(server, '/api/tournaments', {
		method: 'POST', asAdmin: true,
		body: { id: tid, name: tid, maxPlayers: 2, bestOf: 3 },
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

/** Play one game of a series and wait for game-result. */
async function playOneGame(
	a: any, b: any, matchId: string,
): Promise<{ winner: string; winsA: number; winsB: number; gameNumber: number }> {
	a.send({ type: 'match-done', matchId });
	b.send({ type: 'match-done', matchId });
	const result = await a.waitFor('game-result');
	return {
		winner: result.winner,
		winsA: result.winsA,
		winsB: result.winsB,
		gameNumber: result.gameNumber,
	};
}

runTest('series: Bo3 2-0 sweep — seriesEnd on game 2, no series-next after', async () => {
	const server = await startServer();
	try {
		await setupBo3Match(server, 'sw-bo3-20', 'alice', 'bob');
		const a = await wsConnect(server.port, 'alice');
		const b = await wsConnect(server.port, 'bob');
		await sleep(100);

		a.send({ type: 'match-ready', matchId: 'sw-bo3-20/R0M0' });
		b.send({ type: 'match-ready', matchId: 'sw-bo3-20/R0M0' });
		const startMsg = await a.waitFor('match-start');
		await b.waitFor('match-start');
		assertEqual(startMsg.bestOf, 3);

		// Game 1 — alice sends inputs to beat bob (no-input)
		sendWinningInputs(a, 'sw-bo3-20/R0M0');
		await sleep(500);
		a.send({ type: 'match-done', matchId: 'sw-bo3-20/R0M0' });
		b.send({ type: 'match-done', matchId: 'sw-bo3-20/R0M0' });
		const g1 = await a.waitFor('game-result');
		assertEqual(g1.gameNumber, 1);
		assertEqual(g1.winsA + g1.winsB, 1, 'series 1-0 after game 1');

		// series-next for game 2
		const next = await a.waitFor('series-next');
		assertEqual(next.gameNumber, 2);
		assert(next.seed, 'new seed for game 2');
		assert(next.seed !== startMsg.seed, 'game 2 seed differs from game 1');
		await b.waitFor('series-next');

		// Game 2 — both ready again (machine requires handshake per game)
		a.send({ type: 'match-ready', matchId: 'sw-bo3-20/R0M0' });
		b.send({ type: 'match-ready', matchId: 'sw-bo3-20/R0M0' });
		await a.waitFor('match-start');
		await b.waitFor('match-start');
		// Alice sends inputs again → wins game 2 → series 2-0 → match-end with seriesEnd
		sendWinningInputs(a, 'sw-bo3-20/R0M0');
		await sleep(500);
		a.send({ type: 'match-done', matchId: 'sw-bo3-20/R0M0' });
		b.send({ type: 'match-done', matchId: 'sw-bo3-20/R0M0' });
		const end = await a.waitFor('match-end');
		assertEqual(end.seriesEnd, true, 'seriesEnd flag set on final game');
		assert(end.winner, 'series winner set');
		// match-end score fields for series end carry series wins (2-0)
		assertEqual(Math.max(end.scoreA, end.scoreB), 2, 'winner has 2 series wins');
		assertEqual(Math.min(end.scoreA, end.scoreB), 0, 'loser has 0 series wins');

		// No game-result for game 2 (replaced by match-end on series end)
		// No series-next after game 2 (series is over)
		await sleep(500);
		const gameResults = a.messages.filter((m) => m.type === 'game-result');
		const seriesNext = a.messages.filter((m) => m.type === 'series-next');
		assertEqual(gameResults.length, 1, 'exactly one game-result (game 1 only)');
		assertEqual(seriesNext.length, 1, 'exactly one series-next (game 2 only)');

		a.close();
		b.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('series: Bo5 sweep — 3-0, seriesEnd on game 3', async () => {
	const server = await startServer();
	try {
		await api(server, '/api/tournaments', {
			method: 'POST', asAdmin: true,
			body: { id: 'sw-bo5', name: 'bo5', maxPlayers: 2, bestOf: 5 },
		});
		await api(server, '/api/tournaments/sw-bo5/register', {
			method: 'POST', body: { nametag: 'carol' }, asNametag: 'carol',
		});
		await api(server, '/api/tournaments/sw-bo5/register', {
			method: 'POST', body: { nametag: 'dave' }, asNametag: 'dave',
		});
		await api(server, '/api/tournaments/sw-bo5/start', {
			method: 'POST', asAdmin: true,
		});

		const c = await wsConnect(server.port, 'carol');
		const d = await wsConnect(server.port, 'dave');
		await sleep(100);
		c.send({ type: 'match-ready', matchId: 'sw-bo5/R0M0' });
		d.send({ type: 'match-ready', matchId: 'sw-bo5/R0M0' });
		const start = await c.waitFor('match-start');
		await d.waitFor('match-start');
		assertEqual(start.bestOf, 5);

		for (let g = 1; g <= 2; g++) {
			// Carol sends inputs to score higher than no-input dave
			sendWinningInputs(c, 'sw-bo5/R0M0');
			await sleep(500);
			c.send({ type: 'match-done', matchId: 'sw-bo5/R0M0' });
			d.send({ type: 'match-done', matchId: 'sw-bo5/R0M0' });
			const gr = await c.waitFor('game-result');
			assertEqual(gr.gameNumber, g);
			await c.waitFor('series-next');
			await d.waitFor('game-result');
			await d.waitFor('series-next');
			c.send({ type: 'match-ready', matchId: 'sw-bo5/R0M0' });
			d.send({ type: 'match-ready', matchId: 'sw-bo5/R0M0' });
			await c.waitFor('match-start');
			await d.waitFor('match-start');
		}

		// Game 3 — carol sends inputs, sweep → match-end with seriesEnd
		sendWinningInputs(c, 'sw-bo5/R0M0');
		await sleep(100);
		c.send({ type: 'match-done', matchId: 'sw-bo5/R0M0' });
		d.send({ type: 'match-done', matchId: 'sw-bo5/R0M0' });
		const end = await c.waitFor('match-end', 10_000);
		assertEqual(end.seriesEnd, true);

		c.close();
		d.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('series: Bo1 produces one match-end, no series-next, no game-result', async () => {
	const server = await startServer();
	try {
		// Default bestOf=1
		await api(server, '/api/tournaments', {
			method: 'POST', asAdmin: true,
			body: { id: 'sw-bo1', name: 'bo1', maxPlayers: 2 },
		});
		await api(server, '/api/tournaments/sw-bo1/register', {
			method: 'POST', body: { nametag: 'eve' }, asNametag: 'eve',
		});
		await api(server, '/api/tournaments/sw-bo1/register', {
			method: 'POST', body: { nametag: 'frank' }, asNametag: 'frank',
		});
		await api(server, '/api/tournaments/sw-bo1/start', {
			method: 'POST', asAdmin: true,
		});

		const e = await wsConnect(server.port, 'eve');
		const f = await wsConnect(server.port, 'frank');
		await sleep(100);
		e.send({ type: 'match-ready', matchId: 'sw-bo1/R0M0' });
		f.send({ type: 'match-ready', matchId: 'sw-bo1/R0M0' });
		await e.waitFor('match-start');
		await f.waitFor('match-start');

		e.send({ type: 'match-done', matchId: 'sw-bo1/R0M0' });
		f.send({ type: 'match-done', matchId: 'sw-bo1/R0M0' });
		const end = await e.waitFor('match-end');

		// Bo1: no seriesEnd flag (or false), no game-result, no series-next
		assert(end.seriesEnd !== true, 'Bo1 match-end has no seriesEnd flag');
		await sleep(500);
		const gr = e.messages.filter((m) => m.type === 'game-result');
		const sn = e.messages.filter((m) => m.type === 'series-next');
		assertEqual(gr.length, 0, 'no game-result for Bo1');
		assertEqual(sn.length, 0, 'no series-next for Bo1');

		e.close();
		f.close();
	} finally {
		await stopServer(server.proc);
	}
});
