/**
 * V2 Tournament API tests — REST endpoints for tournament lifecycle.
 */

import {
	assert,
	assertEqual,
	runTest,
	sleep,
	startServer,
	stopServer,
} from './harness';

async function api(url: string, method = 'GET', body?: any) {
	const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
	if (body) opts.body = JSON.stringify(body);
	const r = await fetch(url, opts);
	return r.json();
}

runTest('v2: tournament API — create, register, start, bracket', async () => {
	const server = await startServer();
	const base = `http://127.0.0.1:${server.port}/api`;
	try {
		// ── Create tournament ──
		const created = await api(`${base}/tournaments`, 'POST', {
			id: 'api-test-1', name: 'Test Tournament', maxPlayers: 8,
			startsAt: new Date(Date.now() + 3600000).toISOString(),
		});
		assertEqual(created.id, 'api-test-1');
		assertEqual(created.status, 'registration');

		// ── List tournaments ──
		const list = await api(`${base}/tournaments`);
		assert(list.tournaments.length >= 1, 'should have at least 1 tournament');
		assert(list.tournaments.some((t: any) => t.id === 'api-test-1'), 'our tournament in list');

		// ── Get tournament details ──
		const detail = await api(`${base}/tournaments/api-test-1`);
		assertEqual(detail.name, 'Test Tournament');
		assertEqual(detail.status, 'registration');
		assertEqual(detail.playerCount, 0);

		// ── Register players ──
		for (const name of ['alice', 'bob', 'charlie', 'dave']) {
			const reg = await api(`${base}/tournaments/api-test-1/register`, 'POST', { nametag: name });
			assertEqual(reg.status, 'registered');
		}
		const afterReg = await api(`${base}/tournaments/api-test-1`);
		assertEqual(afterReg.playerCount, 4);
		assertEqual(afterReg.players.length, 4);

		// ── Duplicate registration ──
		const dup = await api(`${base}/tournaments/api-test-1/register`, 'POST', { nametag: 'alice' });
		// Should still be 4 (INSERT OR IGNORE)
		const afterDup = await api(`${base}/tournaments/api-test-1`);
		assertEqual(afterDup.playerCount, 4);

		// ── Register without nametag → error ──
		const noName = await api(`${base}/tournaments/api-test-1/register`, 'POST', {});
		assert(noName.error, 'should error without nametag');

		// ── Start tournament ──
		const started = await api(`${base}/tournaments/api-test-1/start`, 'POST');
		assertEqual(started.status, 'started');

		// ── Register after start → error ──
		const lateReg = await api(`${base}/tournaments/api-test-1/register`, 'POST', { nametag: 'eve' });
		assert(lateReg.error, 'should error after tournament started');

		// ── Get bracket ──
		const bracket = await api(`${base}/tournaments/api-test-1/bracket`);
		assertEqual(bracket.tournament.status, 'active');
		assertEqual(bracket.tournament.current_round, 0);
		assert(bracket.matches.length >= 2, 'should have matches');

		// Check round 0 matches are ready_wait
		const r0 = bracket.matches.filter((m: any) => m.round === 0);
		for (const m of r0) {
			if (m.playerA && m.playerB) {
				assertEqual(m.status, 'ready_wait', `match ${m.id} should be ready_wait`);
			}
		}

		// Check round 1 match is pending
		const r1 = bracket.matches.filter((m: any) => m.round === 1);
		assertEqual(r1.length, 1, 'one final match');
		assertEqual(r1[0].status, 'pending');

		// ── Start with too few players → error ──
		await api(`${base}/tournaments`, 'POST', { id: 'empty-t', name: 'Empty' });
		const startEmpty = await api(`${base}/tournaments/empty-t/start`, 'POST');
		assert(startEmpty.error, 'should error with no players');

		// ── Nonexistent tournament ──
		const notFound = await api(`${base}/tournaments/nope`);
		assert(notFound.error || !notFound.id, 'should 404 or error');

	} finally {
		await stopServer(server.proc);
	}
});
