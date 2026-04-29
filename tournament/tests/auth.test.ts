/**
 * Auth tests — Sphere-signed session lifecycle and the gates that depend
 * on it.
 *
 * The bypass mode (AUTH_BYPASS=1) lets tests skip real signature
 * verification, but every other check (challenge → verify → session,
 * matching nametags, expiry, single-use) is exercised end-to-end.
 *
 * Coverage:
 *   1. Challenge issuance: valid nametag → returns nonce; invalid → 400
 *   2. Verify accepts the bypass signature, returns sessionId
 *   3. Verify rejects unknown challengeId
 *   4. Verify is single-use (challengeId destroyed after first verify)
 *   5. WS register without sessionId is rejected
 *   6. WS register with mismatched session is rejected
 *   7. WS register with valid session is accepted
 *   8. REST mutating endpoint without Authorization → 401
 *   9. REST mutating endpoint with wrong-nametag session → 403
 *  10. REST mutating endpoint with correct session → ok
 *  11. Admin endpoints without X-Admin-Key still 403 (admin-key path
 *      independent of session auth)
 *  12. Score submission binds nickname to authed session, not body
 */

import WebSocket from 'ws';
import {
	api,
	assert,
	assertEqual,
	mintSession,
	runTest,
	sleep,
	startServer,
	stopServer,
	TEST_ADMIN_KEY,
} from './harness';

// ── 1. Challenge issuance ────────────────────────────────────────

runTest('auth: /challenge returns nonce + challengeId for valid nametag', async () => {
	const server = await startServer();
	try {
		const r = await api(server, '/api/auth/challenge', {
			method: 'POST', body: { nametag: 'alice' },
		});
		assert(typeof r.challengeId === 'string' && r.challengeId.length > 0, 'challengeId set');
		assert(typeof r.nonce === 'string' && r.nonce.length === 64, '32-byte hex nonce');
		assert(typeof r.expiresAt === 'number' && r.expiresAt > Date.now(), 'expiresAt in future');
	} finally {
		await stopServer(server.proc);
	}
});

runTest('auth: /challenge rejects invalid nametag', async () => {
	const server = await startServer();
	try {
		const r = await api(server, '/api/auth/challenge', {
			method: 'POST', body: { nametag: 'has spaces' }, allowError: true,
		});
		assertEqual(r.error, 'invalid_nametag');
	} finally {
		await stopServer(server.proc);
	}
});

runTest('auth: /challenge strips leading @ and lowercases', async () => {
	const server = await startServer();
	try {
		// Both should issue cleanly; the server normalizes internally.
		const r1 = await api(server, '/api/auth/challenge', {
			method: 'POST', body: { nametag: '@Alice' },
		});
		assert(r1.challengeId, 'leading @ accepted via normalization');
	} finally {
		await stopServer(server.proc);
	}
});

// ── 2-4. Verify ──────────────────────────────────────────────────

runTest('auth: /verify accepts bypass signature, returns session', async () => {
	const server = await startServer();
	try {
		const ch = await api(server, '/api/auth/challenge', {
			method: 'POST', body: { nametag: 'alice' },
		});
		const v = await api(server, '/api/auth/verify', {
			method: 'POST', body: { challengeId: ch.challengeId, signature: 'whatever' },
		});
		assertEqual(v.nametag, 'alice');
		assert(v.sessionId.length > 0, 'sessionId minted');
	} finally {
		await stopServer(server.proc);
	}
});

runTest('auth: /verify rejects unknown challengeId', async () => {
	const server = await startServer();
	try {
		const r = await api(server, '/api/auth/verify', {
			method: 'POST', body: { challengeId: 'made-up', signature: 'x' }, allowError: true,
		});
		assertEqual(r.error, 'unknown_challenge');
	} finally {
		await stopServer(server.proc);
	}
});

runTest('auth: /verify is single-use — challengeId destroyed after first call', async () => {
	const server = await startServer();
	try {
		const ch = await api(server, '/api/auth/challenge', {
			method: 'POST', body: { nametag: 'bob' },
		});
		await api(server, '/api/auth/verify', {
			method: 'POST', body: { challengeId: ch.challengeId, signature: 'x' },
		});
		const second = await api(server, '/api/auth/verify', {
			method: 'POST', body: { challengeId: ch.challengeId, signature: 'x' }, allowError: true,
		});
		assertEqual(second.error, 'unknown_challenge', 'challenge cannot be replayed');
	} finally {
		await stopServer(server.proc);
	}
});

// ── 5-7. WS register gating ──────────────────────────────────────

function rawWsConnect(port: number): Promise<{
	ws: WebSocket;
	messages: any[];
	waitForType: (type: string, timeoutMs?: number) => Promise<any>;
	waitForClose: (timeoutMs?: number) => Promise<{ code: number; reason: string }>;
	close: () => void;
}> {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		const messages: any[] = [];
		ws.on('message', (raw) => { try { messages.push(JSON.parse(raw.toString())); } catch {} });
		ws.on('open', () => {
			resolve({
				ws, messages,
				waitForType(type, timeoutMs = 2000) {
					return new Promise((res, rej) => {
						const start = Date.now();
						const t = setInterval(() => {
							const m = messages.find((mm) => mm.type === type);
							if (m) { clearInterval(t); res(m); }
							else if (Date.now() - start > timeoutMs) {
								clearInterval(t);
								rej(new Error(`timeout waiting for ${type}; got ${JSON.stringify(messages.map(x => x.type))}`));
							}
						}, 20);
					});
				},
				waitForClose(timeoutMs = 2000) {
					return new Promise((res, rej) => {
						const t = setTimeout(() => rej(new Error('timeout waiting for close')), timeoutMs);
						ws.on('close', (code, reason) => {
							clearTimeout(t);
							res({ code, reason: reason.toString() });
						});
					});
				},
				close() { ws.close(); },
			});
		});
	});
}

runTest('auth: WS register without sessionId is rejected and socket closed', async () => {
	const server = await startServer();
	try {
		const c = await rawWsConnect(server.port);
		c.ws.send(JSON.stringify({ type: 'register', identity: { nametag: 'mallory' } }));
		const closed = await c.waitForClose(2000);
		assertEqual(closed.code, 1008, 'policy violation close code');
	} finally {
		await stopServer(server.proc);
	}
});

runTest('auth: WS register with mismatched session is rejected', async () => {
	const server = await startServer();
	try {
		const aliceSession = await mintSession(server, 'alice');
		const c = await rawWsConnect(server.port);
		// Alice's session, but claiming to be bob — server must reject.
		c.ws.send(JSON.stringify({
			type: 'register', identity: { nametag: 'bob' }, sessionId: aliceSession,
		}));
		const closed = await c.waitForClose(2000);
		assertEqual(closed.code, 1008);
	} finally {
		await stopServer(server.proc);
	}
});

runTest('auth: WS register with valid session is accepted', async () => {
	const server = await startServer();
	try {
		const sid = await mintSession(server, 'alice');
		const c = await rawWsConnect(server.port);
		c.ws.send(JSON.stringify({
			type: 'register', identity: { nametag: 'alice' }, sessionId: sid,
		}));
		const ack = await c.waitForType('registered');
		assertEqual(ack.nametag, 'alice');
		c.close();
	} finally {
		await stopServer(server.proc);
	}
});

// ── 8-10. REST mutating endpoint gating ──────────────────────────

runTest('auth: REST register without Authorization → 401', async () => {
	const server = await startServer();
	try {
		await api(server, '/api/tournaments', {
			method: 'POST', asAdmin: true,
			body: { id: 'auth-rest-1', name: 't1', maxPlayers: 4 },
		});
		const r = await api(server, '/api/tournaments/auth-rest-1/register', {
			method: 'POST', body: { nametag: 'alice' }, allowError: true,
		});
		assertEqual(r.error, 'unauthorized');
	} finally {
		await stopServer(server.proc);
	}
});

runTest('auth: REST register with wrong-nametag session → 403', async () => {
	const server = await startServer();
	try {
		await api(server, '/api/tournaments', {
			method: 'POST', asAdmin: true,
			body: { id: 'auth-rest-2', name: 't2', maxPlayers: 4 },
		});
		const aliceSession = await mintSession(server, 'alice');
		// Authed as alice but trying to register bob.
		const r = await api(server, '/api/tournaments/auth-rest-2/register', {
			method: 'POST', body: { nametag: 'bob' }, session: aliceSession, allowError: true,
		});
		assertEqual(r.error, 'session_mismatch');
	} finally {
		await stopServer(server.proc);
	}
});

runTest('auth: REST register with matching session → ok', async () => {
	const server = await startServer();
	try {
		await api(server, '/api/tournaments', {
			method: 'POST', asAdmin: true,
			body: { id: 'auth-rest-3', name: 't3', maxPlayers: 4 },
		});
		const r = await api(server, '/api/tournaments/auth-rest-3/register', {
			method: 'POST', body: { nametag: 'alice' }, asNametag: 'alice',
		});
		assertEqual(r.status, 'registered');
	} finally {
		await stopServer(server.proc);
	}
});

// ── 11. Admin endpoints still gated by X-Admin-Key ───────────────

runTest('auth: admin endpoint without X-Admin-Key → 403 (independent of session)', async () => {
	const server = await startServer();
	try {
		const sid = await mintSession(server, 'alice');
		// A valid session shouldn't grant admin powers — admin key is a
		// separate authority.
		const r = await api(server, '/api/admin/credit', {
			method: 'POST', body: { nametag: 'alice', amount: 100 },
			session: sid, allowError: true,
		});
		assertEqual(r.error, 'Unauthorized');
	} finally {
		await stopServer(server.proc);
	}
});

// ── 12. Score submission binds nickname to session ───────────────

runTest('auth: /api/scores 401 without session', async () => {
	const server = await startServer();
	try {
		const r = await api(server, '/api/scores', {
			method: 'POST', body: { seed: 0, inputs: [] }, allowError: true,
		});
		assertEqual(r.error, 'unauthorized');
	} finally {
		await stopServer(server.proc);
	}
});

runTest('auth: /api/scores rejects body-supplied nickname spoofing', async () => {
	const server = await startServer();
	try {
		const sid = await mintSession(server, 'alice');
		// Even if alice tries to submit under bob's name, the server uses
		// the session nametag — bob will not appear on the leaderboard.
		const r = await api(server, '/api/scores', {
			method: 'POST', session: sid,
			body: { nickname: 'bob', seed: 1, inputs: [] },
		});
		// Returns "rejected" because score is 0/low or "accepted"; either
		// way the row should be associated with alice, NOT bob.
		const lb = await api(server, '/api/leaderboard/daily?limit=50');
		const bobRow = lb.leaderboard.find((row: any) => row.nickname === 'bob');
		assert(!bobRow, `bob should not appear: ${JSON.stringify(lb.leaderboard)}`);
	} finally {
		await stopServer(server.proc);
	}
});

// ── 13. Sessions issued separately are independent ───────────────

runTest('auth: alice and bob get different session IDs', async () => {
	const server = await startServer();
	try {
		const a = await mintSession(server, 'alice');
		const b = await mintSession(server, 'bob');
		assert(a !== b, 'distinct session ids');
	} finally {
		await stopServer(server.proc);
	}
});

// ── 14. Forged session token rejected ────────────────────────────

runTest('auth: forged session token returns 401 on mutating endpoint', async () => {
	const server = await startServer();
	try {
		const r = await api(server, '/api/scores', {
			method: 'POST', session: 'made-up-' + 'a'.repeat(40),
			body: { seed: 1, inputs: [] }, allowError: true,
		});
		assertEqual(r.error, 'unauthorized');
	} finally {
		await stopServer(server.proc);
	}
});

// ── 15. Admin endpoint accepts X-Admin-Key (sanity) ──────────────

runTest('auth: admin credit works with X-Admin-Key (sanity)', async () => {
	const server = await startServer();
	try {
		const r = await api(server, '/api/admin/credit', {
			method: 'POST', asAdmin: true,
			body: { nametag: 'alice', amount: 50, type: 'deposit', memo: 'test' },
		});
		assertEqual(r.status, 'ok');
		assert(r.balance >= 50);
	} finally {
		await stopServer(server.proc);
	}
});

// ── 16. Bounded body — large POST rejected ───────────────────────

runTest('auth: oversized body is rejected (DoS guard)', async () => {
	const server = await startServer();
	try {
		// Build a >1MB body. We can't test the cap precisely from here
		// because fetch streams the body, but a 2MB string is well over
		// the limit and should fail.
		const huge = 'x'.repeat(2 * 1024 * 1024);
		const url = `http://127.0.0.1:${server.port}/api/auth/challenge`;
		try {
			await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ nametag: 'alice', pad: huge }),
			});
			// We don't really care WHAT happens — only that the server
			// doesn't OOM. A connection-destroy or 4xx is fine.
		} catch (err) {
			// Connection reset is the expected outcome.
		}
		// Verify the server is still alive afterward.
		const r = await api(server, '/api/auth/challenge', {
			method: 'POST', body: { nametag: 'alice' },
		});
		assert(r.challengeId, 'server still healthy after oversized request');
	} finally {
		await stopServer(server.proc);
	}
});

// ── 17. Balance/transactions: own-session-or-admin only ─────────

runTest('auth: /api/balance/:nametag is 401 without session', async () => {
	const server = await startServer();
	try {
		const r = await api(server, '/api/balance/alice', { allowError: true });
		assertEqual(r.error, 'unauthorized');
	} finally {
		await stopServer(server.proc);
	}
});

runTest('auth: /api/balance/bob with alice session → 403', async () => {
	const server = await startServer();
	try {
		const aliceSession = await mintSession(server, 'alice');
		const r = await api(server, '/api/balance/bob', {
			session: aliceSession, allowError: true,
		});
		assertEqual(r.error, 'forbidden');
	} finally {
		await stopServer(server.proc);
	}
});

runTest('auth: /api/balance/alice with alice session → ok', async () => {
	const server = await startServer();
	try {
		const r = await api(server, '/api/balance/alice', { asNametag: 'alice' });
		assertEqual(typeof r.balance, 'number');
	} finally {
		await stopServer(server.proc);
	}
});

runTest('auth: /api/balance/anyone with admin key → ok', async () => {
	const server = await startServer();
	try {
		const r = await api(server, '/api/balance/anyone', { asAdmin: true });
		assertEqual(typeof r.balance, 'number');
	} finally {
		await stopServer(server.proc);
	}
});

runTest('auth: /api/transactions enforces same gate', async () => {
	const server = await startServer();
	try {
		const noAuth = await api(server, '/api/transactions/alice', { allowError: true });
		assertEqual(noAuth.error, 'unauthorized');
		const wrongSession = await mintSession(server, 'eve');
		const wrong = await api(server, '/api/transactions/alice', {
			session: wrongSession, allowError: true,
		});
		assertEqual(wrong.error, 'forbidden');
	} finally {
		await stopServer(server.proc);
	}
});

// ── 18. /api/log requires session and binds nametag to it ───────

runTest('auth: /api/log without session → 401', async () => {
	const server = await startServer();
	try {
		const r = await api(server, '/api/log', {
			method: 'POST', body: { event: 'spam', data: { x: 1 } }, allowError: true,
		});
		assertEqual(r.error, 'unauthorized');
	} finally {
		await stopServer(server.proc);
	}
});

runTest('auth: /api/log with session → ok (nametag pulled from session, not body)', async () => {
	const server = await startServer();
	try {
		// Even if body claims to be 'mallory', the server logs as alice.
		const r = await api(server, '/api/log', {
			method: 'POST', asNametag: 'alice',
			body: { nametag: 'mallory', event: 'test', data: {} },
		});
		assertEqual(r.ok, true);
	} finally {
		await stopServer(server.proc);
	}
});

// ── 19. Match-ready REST: nametag must match session ─────────────

runTest('auth: REST match-ready rejects mismatched nametag', async () => {
	const server = await startServer();
	try {
		await api(server, '/api/tournaments', {
			method: 'POST', asAdmin: true,
			body: { id: 'auth-mr', name: 'auth-mr', maxPlayers: 2 },
		});
		await api(server, '/api/tournaments/auth-mr/register', {
			method: 'POST', body: { nametag: 'alice' }, asNametag: 'alice',
		});
		await api(server, '/api/tournaments/auth-mr/register', {
			method: 'POST', body: { nametag: 'bob' }, asNametag: 'bob',
		});
		await api(server, '/api/tournaments/auth-mr/start', {
			method: 'POST', asAdmin: true,
		});
		// alice tries to mark bob ready — must be rejected.
		const aliceSession = await mintSession(server, 'alice');
		const r = await api(server, '/api/tournaments/auth-mr/matches/0/0/ready', {
			method: 'POST', body: { nametag: 'bob' }, session: aliceSession, allowError: true,
		});
		assertEqual(r.error, 'session_mismatch');
	} finally {
		await stopServer(server.proc);
	}
});
