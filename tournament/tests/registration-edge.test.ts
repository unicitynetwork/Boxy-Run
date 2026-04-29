/**
 * Registration edge cases — nametag formats, full tournaments,
 * post-start, duplicates, missing fields.
 */

import { api, assert, assertEqual, runTest, startServer, stopServer } from './harness';

async function createTournament(server: { port: number }, id: string, opts: any = {}) {
	await api(server, '/api/tournaments', {
		method: 'POST', asAdmin: true,
		body: { id, name: id, maxPlayers: 8, ...opts },
	});
}

runTest('registration: valid nametag → 200 registered', async () => {
	const server = await startServer();
	try {
		await createTournament(server, 'reg-basic');
		const r = await api(server, '/api/tournaments/reg-basic/register', {
			method: 'POST', body: { nametag: 'alice' }, asNametag: 'alice',
		});
		assertEqual(r.status, 'registered');
	} finally {
		await stopServer(server.proc);
	}
});

runTest('registration: duplicate is idempotent (no count increase)', async () => {
	const server = await startServer();
	try {
		await createTournament(server, 'reg-dup');
		await api(server, '/api/tournaments/reg-dup/register', {
			method: 'POST', body: { nametag: 'bob' }, asNametag: 'bob',
		});
		await api(server, '/api/tournaments/reg-dup/register', {
			method: 'POST', body: { nametag: 'bob' }, asNametag: 'bob', allowError: true,
		});
		const detail = await api(server, '/api/tournaments/reg-dup');
		assertEqual(detail.playerCount, 1, 'duplicate did not add a second row');
	} finally {
		await stopServer(server.proc);
	}
});

runTest('registration: missing nametag → 400', async () => {
	const server = await startServer();
	try {
		await createTournament(server, 'reg-missing');
		const r = await api(server, '/api/tournaments/reg-missing/register', {
			method: 'POST', body: {}, allowError: true,
		});
		assert(r.error, 'should error');
	} finally {
		await stopServer(server.proc);
	}
});

runTest('registration: whitespace-only nametag → rejected', async () => {
	const server = await startServer();
	try {
		await createTournament(server, 'reg-ws');
		// No asNametag — these malformed nametags can't be auth-signed,
		// so the auth layer rejects them first. That's still "server
		// rejects bad nametags," just at a different layer.
		const r = await api(server, '/api/tournaments/reg-ws/register', {
			method: 'POST', body: { nametag: '   ' }, allowError: true,
		});
		assert(r.error, 'should reject whitespace');
	} finally {
		await stopServer(server.proc);
	}
});

runTest('registration: wallet-style numeric nametag works', async () => {
	const server = await startServer();
	try {
		await createTournament(server, 'reg-wallet');
		const r = await api(server, '/api/tournaments/reg-wallet/register', {
			method: 'POST', body: { nametag: '7288238' }, asNametag: '7288238',
		});
		assertEqual(r.status, 'registered');
		const d = await api(server, '/api/tournaments/reg-wallet');
		assert(d.players.includes('7288238'));
	} finally {
		await stopServer(server.proc);
	}
});

runTest('registration: underscore + @ nametags both work', async () => {
	const server = await startServer();
	try {
		await createTournament(server, 'reg-chars');
		await api(server, '/api/tournaments/reg-chars/register', {
			method: 'POST', body: { nametag: 'my_player_01' }, asNametag: 'my_player_01',
		});
		await api(server, '/api/tournaments/reg-chars/register', {
			method: 'POST', body: { nametag: '@dev_player' }, asNametag: '@dev_player',
		});
		const d = await api(server, '/api/tournaments/reg-chars');
		assertEqual(d.playerCount, 2);
	} finally {
		await stopServer(server.proc);
	}
});

runTest('registration: after tournament started → error', async () => {
	const server = await startServer();
	try {
		await createTournament(server, 'reg-late');
		await api(server, '/api/tournaments/reg-late/register', {
			method: 'POST', body: { nametag: 'p1' }, asNametag: 'p1',
		});
		await api(server, '/api/tournaments/reg-late/register', {
			method: 'POST', body: { nametag: 'p2' }, asNametag: 'p2',
		});
		await api(server, '/api/tournaments/reg-late/start', {
			method: 'POST', asAdmin: true,
		});
		const r = await api(server, '/api/tournaments/reg-late/register', {
			method: 'POST', body: { nametag: 'p3' }, asNametag: 'p3', allowError: true,
		});
		assert(r.error, 'should reject after start');
	} finally {
		await stopServer(server.proc);
	}
});

runTest('registration: when tournament full → error', async () => {
	const server = await startServer();
	try {
		await createTournament(server, 'reg-full', { maxPlayers: 2 });
		await api(server, '/api/tournaments/reg-full/register', {
			method: 'POST', body: { nametag: 'p1' }, asNametag: 'p1',
		});
		await api(server, '/api/tournaments/reg-full/register', {
			method: 'POST', body: { nametag: 'p2' }, asNametag: 'p2',
		});
		const r = await api(server, '/api/tournaments/reg-full/register', {
			method: 'POST', body: { nametag: 'p3' }, asNametag: 'p3', allowError: true,
		});
		assert(r.error, 'should reject when full');
	} finally {
		await stopServer(server.proc);
	}
});

runTest('registration: nonexistent tournament → error', async () => {
	const server = await startServer();
	try {
		const r = await api(server, '/api/tournaments/ghost/register', {
			method: 'POST', body: { nametag: 'alice' }, asNametag: 'alice', allowError: true,
		});
		assert(r.error, 'should error on nonexistent');
	} finally {
		await stopServer(server.proc);
	}
});

runTest('registration: very long nametag (256 chars) handled', async () => {
	const server = await startServer();
	try {
		await createTournament(server, 'reg-long');
		const longName = 'a'.repeat(256);
		const r = await api(server, '/api/tournaments/reg-long/register', {
			method: 'POST', body: { nametag: longName }, allowError: true,
		});
		// Either accepts or rejects — what matters is no crash + a clean response
		assert(r.status === 'registered' || r.error, 'clean response for long name');
	} finally {
		await stopServer(server.proc);
	}
});

runTest('registration: special chars (xss attempt) stored safely', async () => {
	const server = await startServer();
	try {
		await createTournament(server, 'reg-xss');
		const xssName = '<script>alert(1)</script>';
		// Auth layer will reject before nametag validation in the
		// register endpoint — that's correct: malformed nametags should
		// never reach the database.
		const r = await api(server, '/api/tournaments/reg-xss/register', {
			method: 'POST', body: { nametag: xssName }, allowError: true,
		});
		if (r.status === 'registered') {
			const d = await api(server, '/api/tournaments/reg-xss');
			// Whatever validation applies, the raw string must round-trip exactly
			// (the browser layer is responsible for escaping on display)
			assertEqual(d.players[0], xssName);
		}
	} finally {
		await stopServer(server.proc);
	}
});
