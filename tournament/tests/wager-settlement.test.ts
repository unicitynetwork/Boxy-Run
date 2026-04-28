/**
 * Wager settlement — ledger idempotency and correctness.
 *
 * Critical because real UCT moves between players based on match outcomes.
 * Verifies:
 *   - Bo1 wager: winner credited, loser debited, exactly one transaction each
 *   - Bo3 series wager: exactly one settlement at series end, not per game
 *   - Insufficient balance blocks challenge creation
 *   - Insufficient acceptor balance blocks challenge accept
 *   - Balance is SUM(player_transactions) — append-only
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

async function deposit(server: { port: number }, nametag: string, amount: number) {
	await api(server, '/api/admin/credit', {
		method: 'POST', body: { nametag, amount }, asAdmin: true,
	});
}

async function balance(server: { port: number }, nametag: string): Promise<number> {
	const r = await api(server, `/api/balance/${encodeURIComponent(nametag)}`);
	return r.balance ?? 0;
}

async function transactions(server: { port: number }, nametag: string): Promise<any[]> {
	const r = await api(server, `/api/transactions/${encodeURIComponent(nametag)}`);
	return r.transactions || [];
}

runTest('wager: Bo1 challenge settles once — winner +W, loser -W', async () => {
	const server = await startServer();
	try {
		await deposit(server, 'alice', 100);
		await deposit(server, 'bob', 100);

		const alice = await wsConnect(server.port, 'alice');
		const bob = await wsConnect(server.port, 'bob');
		await sleep(100);

		const created = await api(server, '/api/challenges', {
			method: 'POST',
			body: { from: 'alice', opponent: 'bob', wager: 20, bestOf: 1 },
		});
		await bob.waitFor('challenge-received');

		const accepted = await api(server, `/api/challenges/${created.challengeId}/accept`, {
			method: 'POST', body: { by: 'bob' },
		});
		const matchId = accepted.matchId;
		await alice.waitFor('challenge-start');
		await bob.waitFor('challenge-start');

		// Per-game handshake — clients always send match-ready before playing.
		// Skipping it leaves the machine in awaiting_ready and `done` events
		// are correctly rejected by the reducer.
		alice.send({ type: 'match-ready', matchId });
		bob.send({ type: 'match-ready', matchId });
		await alice.waitFor('match-start');
		await bob.waitFor('match-start');

		// Both send done — playerA wins on tiebreak
		alice.send({ type: 'match-done', matchId });
		bob.send({ type: 'match-done', matchId });
		const end = await alice.waitFor('match-end');
		await bob.waitFor('match-end');
		assert(end.winner, 'winner set');

		await sleep(300); // let ledger writes land

		const aliceBal = await balance(server, 'alice');
		const bobBal = await balance(server, 'bob');

		// One side is up 20, the other down 20, sum unchanged
		assertEqual(aliceBal + bobBal, 200, 'zero-sum');
		assert(Math.abs(aliceBal - bobBal) === 40, `winner margin is 2×wager, got ${aliceBal} vs ${bobBal}`);

		// Exactly ONE wager transaction per side (plus the deposit)
		const aliceTx = (await transactions(server, 'alice'))
			.filter((t) => t.type === 'wager_win' || t.type === 'wager_loss');
		const bobTx = (await transactions(server, 'bob'))
			.filter((t) => t.type === 'wager_win' || t.type === 'wager_loss');
		assertEqual(aliceTx.length, 1, 'one wager tx for alice');
		assertEqual(bobTx.length, 1, 'one wager tx for bob');

		alice.close();
		bob.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('wager: Bo3 series settles ONCE at series end, not per game', async () => {
	const server = await startServer();
	try {
		await deposit(server, 'carol', 100);
		await deposit(server, 'dave', 100);

		const c = await wsConnect(server.port, 'carol');
		const d = await wsConnect(server.port, 'dave');
		await sleep(100);

		const created = await api(server, '/api/challenges', {
			method: 'POST',
			body: { from: 'carol', opponent: 'dave', wager: 15, bestOf: 3 },
		});
		await d.waitFor('challenge-received');
		const accepted = await api(server, `/api/challenges/${created.challengeId}/accept`, {
			method: 'POST', body: { by: 'dave' },
		});
		const matchId = accepted.matchId;
		await c.waitFor('challenge-start');
		await d.waitFor('challenge-start');

		// Per-game handshake: ready → play → done for game 1
		c.send({ type: 'match-ready', matchId });
		d.send({ type: 'match-ready', matchId });
		await c.waitFor('match-start');
		await d.waitFor('match-start');
		// Carol switches lane + jumps every tick to beat no-input dave
		const b64 = (s: string) => Buffer.from(s).toString('base64');
		c.send({ type: 'input', matchId, tick: 1, payload: b64('left') });
		for (let t = 1; t <= 700; t += 2) {
			c.send({ type: 'input', matchId, tick: t, payload: b64('up') });
		}
		await sleep(500);
		c.send({ type: 'match-done', matchId });
		d.send({ type: 'match-done', matchId });
		await c.waitFor('game-result'); // game 1
		await c.waitFor('series-next');
		await d.waitFor('series-next');

		// Game 2
		c.send({ type: 'match-ready', matchId });
		d.send({ type: 'match-ready', matchId });
		await c.waitFor('match-start');
		await d.waitFor('match-start');
		c.send({ type: 'input', matchId, tick: 1, payload: b64('left') });
		for (let t = 1; t <= 700; t += 2) {
			c.send({ type: 'input', matchId, tick: t, payload: b64('up') });
		}
		await sleep(500);
		c.send({ type: 'match-done', matchId });
		d.send({ type: 'match-done', matchId });
		const end = await c.waitFor('match-end');
		assertEqual(end.seriesEnd, true);

		await sleep(300);

		// Only one wager_win + one wager_loss should exist, even though there
		// were 2 games. The wager is settled at series end, not per game.
		const cTx = (await transactions(server, 'carol')).filter(
			(t) => t.type === 'wager_win' || t.type === 'wager_loss',
		);
		const dTx = (await transactions(server, 'dave')).filter(
			(t) => t.type === 'wager_win' || t.type === 'wager_loss',
		);
		assertEqual(cTx.length, 1, 'carol got exactly 1 wager tx');
		assertEqual(dTx.length, 1, 'dave got exactly 1 wager tx');

		// Balance is 100±15
		const cBal = await balance(server, 'carol');
		const dBal = await balance(server, 'dave');
		assertEqual(cBal + dBal, 200);
		assert(Math.abs(cBal - dBal) === 30);

		c.close();
		d.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('wager: challenger with insufficient balance → 403, no challenge created', async () => {
	const server = await startServer();
	try {
		await deposit(server, 'poor_alice', 5);
		const bob = await wsConnect(server.port, 'bob');
		await sleep(100);

		const r = await api(server, '/api/challenges', {
			method: 'POST',
			body: { from: 'poor_alice', opponent: 'bob', wager: 100, bestOf: 1 },
			allowError: true,
		});
		assertEqual(r.error, 'insufficient_balance');

		// Bob should NOT have received an invitation
		await sleep(200);
		const got = bob.messages.find((m) => m.type === 'challenge-received');
		assert(!got, 'no invitation pushed');

		bob.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('wager: acceptor with insufficient balance → 403, challenger notified', async () => {
	const server = await startServer();
	try {
		await deposit(server, 'alice', 100);
		await deposit(server, 'poor_bob', 5);

		const alice = await wsConnect(server.port, 'alice');
		const bob = await wsConnect(server.port, 'poor_bob');
		await sleep(100);

		const created = await api(server, '/api/challenges', {
			method: 'POST',
			body: { from: 'alice', opponent: 'poor_bob', wager: 50, bestOf: 1 },
		});
		await bob.waitFor('challenge-received');

		const r = await api(server, `/api/challenges/${created.challengeId}/accept`, {
			method: 'POST', body: { by: 'poor_bob' }, allowError: true,
		});
		assertEqual(r.error, 'insufficient_balance');

		// Alice should get challenge-declined push
		const decl = await alice.waitFor('challenge-declined');
		assertEqual(decl.by, 'poor_bob');

		// No wager transactions should have been written
		const aliceTx = (await transactions(server, 'alice'))
			.filter((t) => t.type === 'wager_win' || t.type === 'wager_loss');
		assertEqual(aliceTx.length, 0, 'no settlement from failed acceptance');

		alice.close();
		bob.close();
	} finally {
		await stopServer(server.proc);
	}
});

runTest('wager: ledger is append-only (no updates to existing rows)', async () => {
	const server = await startServer();
	try {
		await deposit(server, 'eve', 200);
		const before = await transactions(server, 'eve');
		assertEqual(before.length, 1, 'one deposit row');

		// Do a few more deposits — each adds a row, never updates
		await deposit(server, 'eve', 50);
		await deposit(server, 'eve', -30); // a debit
		const after = await transactions(server, 'eve');
		assertEqual(after.length, 3, 'three separate rows');

		// Balance reflects the sum
		const bal = await balance(server, 'eve');
		assertEqual(bal, 220);
	} finally {
		await stopServer(server.proc);
	}
});
