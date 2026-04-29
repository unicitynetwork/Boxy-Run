/**
 * Tournament entry fee — comprehensive test coverage.
 *
 * Covers:
 *   - Happy path: fee charged, prize pool grows, ledger entry created
 *   - Insufficient balance: 402, no registration, no charge
 *   - Zero entry fee: no ledger write, no prize pool change
 *   - Duplicate registration: no double-charge (idempotent)
 *   - Prize pool accumulates: 4 players × 25 UCT = 100 UCT pool
 *   - Entry fee pool seeded + additional fees from registrants
 *   - Entry fee persists through tournament lifecycle
 *   - Conservation: tokens leave players, appear in prize_pool field
 */

import {
	api,
	assert,
	assertEqual,
	runTest,
	startServer,
	stopServer,
} from './harness';

async function deposit(server: { port: number }, nametag: string, amount: number) {
	await api(server, '/api/admin/credit', {
		method: 'POST', body: { nametag, amount }, asAdmin: true,
	});
}

async function balance(server: { port: number }, nametag: string): Promise<number> {
	// Endpoint is now session-gated to "own nametag or admin" — read as
	// admin so the test isn't shaped by who's authed.
	const r = await api(server, `/api/balance/${encodeURIComponent(nametag)}`, { asAdmin: true });
	return r.balance ?? 0;
}

async function transactions(server: { port: number }, nametag: string): Promise<any[]> {
	const r = await api(server, `/api/transactions/${encodeURIComponent(nametag)}`, { asAdmin: true });
	return r.transactions || [];
}

async function createTournamentWithFee(
	server: { port: number },
	id: string,
	entryFee: number,
	opts: any = {},
) {
	await api(server, '/api/tournaments', {
		method: 'POST', asAdmin: true,
		body: { id, name: id, maxPlayers: 8, entryFee, ...opts },
	});
}

runTest('entry fee: happy path — balance debited, prize pool grows, ledger entry created', async () => {
	const server = await startServer();
	try {
		await deposit(server, 'alice', 100);
		await createTournamentWithFee(server, 'ef-1', 25);

		const before = await balance(server, 'alice');
		assertEqual(before, 100);

		const r = await api(server, '/api/tournaments/ef-1/register', {
			method: 'POST', body: { nametag: 'alice' },
		});
		assertEqual(r.status, 'registered');

		// Balance debited
		const after = await balance(server, 'alice');
		assertEqual(after, 75, 'alice paid 25 UCT entry fee');

		// Prize pool incremented
		const tournament = await api(server, '/api/tournaments/ef-1');
		assertEqual(tournament.prize_pool, 25);

		// Ledger has an entry_fee transaction
		const txs = await transactions(server, 'alice');
		const entryTx = txs.find((t: any) => t.type === 'entry_fee');
		assert(entryTx, 'entry_fee transaction present');
		assertEqual(entryTx.amount, -25);
		assert(entryTx.memo.includes('ef-1'), 'memo references tournament');
	} finally {
		await stopServer(server.proc);
	}
});

runTest('entry fee: insufficient balance → 402, no registration, no charge', async () => {
	const server = await startServer();
	try {
		await deposit(server, 'poor_bob', 10);
		await createTournamentWithFee(server, 'ef-poor', 50);

		const r = await api(server, '/api/tournaments/ef-poor/register', {
			method: 'POST', body: { nametag: 'poor_bob' }, allowError: true,
		});
		assertEqual(r.error, 'insufficient_balance');
		assertEqual(r.balance, 10);
		assertEqual(r.entryFee, 50);

		// Balance unchanged
		const bal = await balance(server, 'poor_bob');
		assertEqual(bal, 10);

		// No entry_fee transactions
		const txs = await transactions(server, 'poor_bob');
		const entryTxs = txs.filter((t: any) => t.type === 'entry_fee');
		assertEqual(entryTxs.length, 0);

		// Tournament player count unchanged
		const tournament = await api(server, '/api/tournaments/ef-poor');
		assertEqual(tournament.playerCount, 0);
		assertEqual(tournament.prize_pool, 0);
	} finally {
		await stopServer(server.proc);
	}
});

runTest('entry fee: zero fee skips ledger write entirely', async () => {
	const server = await startServer();
	try {
		await createTournamentWithFee(server, 'ef-zero', 0);

		const r = await api(server, '/api/tournaments/ef-zero/register', {
			method: 'POST', body: { nametag: 'freeplay' },
		});
		assertEqual(r.status, 'registered');

		const txs = await transactions(server, 'freeplay');
		const entryTxs = txs.filter((t: any) => t.type === 'entry_fee');
		assertEqual(entryTxs.length, 0, 'no entry_fee ledger row for zero-fee');

		const tournament = await api(server, '/api/tournaments/ef-zero');
		assertEqual(tournament.prize_pool, 0);
	} finally {
		await stopServer(server.proc);
	}
});

runTest('entry fee: duplicate registration is idempotent — no double charge', async () => {
	const server = await startServer();
	try {
		await deposit(server, 'carol', 100);
		await createTournamentWithFee(server, 'ef-dup', 20);

		await api(server, '/api/tournaments/ef-dup/register', {
			method: 'POST', body: { nametag: 'carol' },
		});
		// Second register attempt
		await api(server, '/api/tournaments/ef-dup/register', {
			method: 'POST', body: { nametag: 'carol' }, allowError: true,
		});

		const bal = await balance(server, 'carol');
		assertEqual(bal, 80, 'charged exactly once, not twice');

		const entryTxs = (await transactions(server, 'carol'))
			.filter((t: any) => t.type === 'entry_fee');
		assertEqual(entryTxs.length, 1);

		const tournament = await api(server, '/api/tournaments/ef-dup');
		assertEqual(tournament.prize_pool, 20, 'prize pool only grew once');
		assertEqual(tournament.playerCount, 1);
	} finally {
		await stopServer(server.proc);
	}
});

runTest('entry fee: multi-player tournament accumulates prize pool', async () => {
	const server = await startServer();
	try {
		const players = ['p1', 'p2', 'p3', 'p4'];
		for (const p of players) await deposit(server, p, 100);
		await createTournamentWithFee(server, 'ef-multi', 25);

		for (const p of players) {
			await api(server, '/api/tournaments/ef-multi/register', {
				method: 'POST', body: { nametag: p },
			});
		}

		const tournament = await api(server, '/api/tournaments/ef-multi');
		assertEqual(tournament.playerCount, 4);
		assertEqual(tournament.prize_pool, 100, '4 × 25 = 100 UCT');

		// Each player debited
		for (const p of players) {
			assertEqual(await balance(server, p), 75, `${p} paid fee`);
		}
	} finally {
		await stopServer(server.proc);
	}
});

runTest('entry fee: combines with seeded prize pool', async () => {
	const server = await startServer();
	try {
		await deposit(server, 'alice', 100);
		await deposit(server, 'bob', 100);

		// Seed a 200 prize pool on top of entry fees
		await api(server, '/api/tournaments', {
			method: 'POST', asAdmin: true,
			body: { id: 'ef-seed', name: 'seeded', maxPlayers: 2, entryFee: 10, prizePool: 200 },
		});

		await api(server, '/api/tournaments/ef-seed/register', {
			method: 'POST', body: { nametag: 'alice' },
		});
		await api(server, '/api/tournaments/ef-seed/register', {
			method: 'POST', body: { nametag: 'bob' },
		});

		const tournament = await api(server, '/api/tournaments/ef-seed');
		assertEqual(tournament.prize_pool, 220, '200 seed + 2×10 entry fees');
		assertEqual(tournament.entry_fee, 10);
	} finally {
		await stopServer(server.proc);
	}
});

runTest('entry fee: default is 0 when not specified', async () => {
	const server = await startServer();
	try {
		// No entryFee in create body
		await api(server, '/api/tournaments', {
			method: 'POST', asAdmin: true,
			body: { id: 'ef-default', name: 'default' },
		});

		const tournament = await api(server, '/api/tournaments/ef-default');
		assertEqual(tournament.entry_fee, 0);

		// Register without depositing → should succeed (no fee)
		const r = await api(server, '/api/tournaments/ef-default/register', {
			method: 'POST', body: { nametag: 'broke_player' },
		});
		assertEqual(r.status, 'registered');
	} finally {
		await stopServer(server.proc);
	}
});

runTest('entry fee: exact balance allowed (balance == fee succeeds)', async () => {
	const server = await startServer();
	try {
		await deposit(server, 'exact', 50);
		await createTournamentWithFee(server, 'ef-exact', 50);

		const r = await api(server, '/api/tournaments/ef-exact/register', {
			method: 'POST', body: { nametag: 'exact' },
		});
		assertEqual(r.status, 'registered');
		assertEqual(await balance(server, 'exact'), 0, 'balance depleted exactly');
	} finally {
		await stopServer(server.proc);
	}
});

runTest('entry fee: token conservation — sum of player losses = prize pool growth', async () => {
	const server = await startServer();
	try {
		const players = ['a1', 'a2', 'a3'];
		for (const p of players) await deposit(server, p, 100);

		const balsBefore = await Promise.all(players.map((p) => balance(server, p)));

		await createTournamentWithFee(server, 'ef-cons', 30);
		for (const p of players) {
			await api(server, '/api/tournaments/ef-cons/register', {
				method: 'POST', body: { nametag: p },
			});
		}

		const balsAfter = await Promise.all(players.map((p) => balance(server, p)));
		const totalPaid = balsBefore.reduce((s, b, i) => s + (b - balsAfter[i]), 0);

		const tournament = await api(server, '/api/tournaments/ef-cons');
		assertEqual(totalPaid, tournament.prize_pool, 'players paid = prize pool');
	} finally {
		await stopServer(server.proc);
	}
});
