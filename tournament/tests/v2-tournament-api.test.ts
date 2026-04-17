/**
 * V2 Tournament API tests — REST endpoints for tournament lifecycle.
 */

import {
	api,
	assert,
	assertEqual,
	runTest,
	startServer,
	stopServer,
} from './harness';

runTest('v2: tournament API — create, register, start, bracket', async () => {
	const server = await startServer();
	try {
		// ── Create tournament (admin) ──
		const created = await api(server, '/api/tournaments', {
			method: 'POST',
			asAdmin: true,
			body: {
				id: 'api-test-1', name: 'Test Tournament', maxPlayers: 8,
				startsAt: new Date(Date.now() + 3600000).toISOString(),
			},
		});
		assertEqual(created.id, 'api-test-1');
		assertEqual(created.status, 'registration');

		// ── Create without admin key → 403 ──
		const unauth = await api(server, '/api/tournaments', {
			method: 'POST',
			body: { id: 'nope', name: 'Nope' },
			allowError: true,
		});
		assert(unauth.error, 'should reject unauthorized create');

		// ── List tournaments ──
		const list = await api(server, '/api/tournaments');
		assert(list.tournaments.length >= 1, 'should have at least 1 tournament');
		assert(list.tournaments.some((t: any) => t.id === 'api-test-1'), 'our tournament in list');

		// ── Get tournament details ──
		const detail = await api(server, '/api/tournaments/api-test-1');
		assertEqual(detail.name, 'Test Tournament');
		assertEqual(detail.status, 'registration');
		assertEqual(detail.playerCount, 0);

		// ── Register players ──
		for (const name of ['alice', 'bob', 'charlie', 'dave']) {
			const reg = await api(server, '/api/tournaments/api-test-1/register', {
				method: 'POST', body: { nametag: name },
			});
			assertEqual(reg.status, 'registered');
		}
		const afterReg = await api(server, '/api/tournaments/api-test-1');
		assertEqual(afterReg.playerCount, 4);
		assertEqual(afterReg.players.length, 4);

		// ── Duplicate registration → still 4 ──
		await api(server, '/api/tournaments/api-test-1/register', {
			method: 'POST', body: { nametag: 'alice' }, allowError: true,
		});
		const afterDup = await api(server, '/api/tournaments/api-test-1');
		assertEqual(afterDup.playerCount, 4);

		// ── Register without nametag → error ──
		const noName = await api(server, '/api/tournaments/api-test-1/register', {
			method: 'POST', body: {}, allowError: true,
		});
		assert(noName.error, 'should error without nametag');

		// ── Start tournament (admin) ──
		const started = await api(server, '/api/tournaments/api-test-1/start', {
			method: 'POST', asAdmin: true,
		});
		assertEqual(started.status, 'started');

		// ── Register after start → error ──
		const lateReg = await api(server, '/api/tournaments/api-test-1/register', {
			method: 'POST', body: { nametag: 'eve' }, allowError: true,
		});
		assert(lateReg.error, 'should error after tournament started');

		// ── Get bracket ──
		const bracket = await api(server, '/api/tournaments/api-test-1/bracket');
		assertEqual(bracket.tournament.status, 'active');
		assertEqual(bracket.tournament.current_round, 0);
		assert(bracket.matches.length >= 2, 'should have matches');

		const r0 = bracket.matches.filter((m: any) => m.round === 0);
		for (const m of r0) {
			if (m.playerA && m.playerB) {
				assertEqual(m.status, 'ready_wait', `match ${m.id} should be ready_wait`);
			}
		}

		const r1 = bracket.matches.filter((m: any) => m.round === 1);
		assertEqual(r1.length, 1, 'one final match');
		assertEqual(r1[0].status, 'pending');

		// ── Start with too few players → error ──
		await api(server, '/api/tournaments', {
			method: 'POST', asAdmin: true, body: { id: 'empty-t', name: 'Empty' },
		});
		const startEmpty = await api(server, '/api/tournaments/empty-t/start', {
			method: 'POST', asAdmin: true, allowError: true,
		});
		assert(startEmpty.error, 'should error with no players');

		// ── Nonexistent tournament ──
		const notFound = await api(server, '/api/tournaments/nope', { allowError: true });
		assert(notFound.error || !notFound.id, 'should 404 or error');

	} finally {
		await stopServer(server.proc);
	}
});
