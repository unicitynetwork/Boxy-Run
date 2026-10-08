/**
 * Unit tests for the arena watcher's history reconcile. No server and no SDK:
 * the Sphere is a stub whose `payments.history()` serves canned pages, and the
 * ledger is a throwaway SQLite file.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { reconcileFloor, reconcileFromHistory } from '../server/arena-watcher';
import { getDb } from '../server/db';
import { assert, assertEqual, runTest } from './harness';

// db.ts opens the client lazily on first use, so this lands before it does.
const DB_PATH = join(tmpdir(), `boxyrun-reconcile-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = DB_PATH;
process.on('exit', () => { try { unlinkSync(DB_PATH); } catch {} });

const UCT = 'f581d30f593e4b369d684a4563b5246f07b1d265f7178a2c0a82b81f39c24dc0';
const OTHER = 'aa'.repeat(32);
const uct = (whole: bigint) => (whole * 10n ** 18n).toString();
const tok = (n: number) => n.toString(16).padStart(64, '0');

/** Stub Sphere whose history is served from `pages`, recording each `before`. */
function stubSphere(pages: Array<{ entries: unknown[]; more: boolean; cursor: string | null }>) {
	const seenBefore: Array<string | undefined> = [];
	let i = 0;
	return {
		seenBefore,
		payments: {
			async history(opts: { before?: string; limit?: number }) {
				seenBefore.push(opts.before);
				return pages[i++];
			},
		},
	};
}

async function deposits(): Promise<Array<{ tx_id: string; nametag: string; amount: number }>> {
	const res = await getDb().execute(
		`SELECT tx_id, nametag, amount FROM player_transactions WHERE type = 'deposit' ORDER BY tx_id`,
	);
	return res.rows.map((r: any) => ({ tx_id: String(r.tx_id), nametag: String(r.nametag), amount: Number(r.amount) }));
}

const received = (tokenId: string, extra: Record<string, unknown>) => ({
	id: `h-${tokenId}`, type: 'RECEIVED', tokenId, coinId: UCT, amount: uct(10n),
	senderNametag: 'alice', timestamp: Date.parse('2026-10-08T12:00:00Z'), ...extra,
});

runTest('arena reconcile: credits uncredited UCT arrivals across pages, skips everything else', async () => {
	const sphere = stubSphere([
		{
			entries: [
				received(tok(1), {}),
				// Multi-asset token: only the UCT leg counts.
				received(tok(2), {
					coinId: OTHER, amount: '999',
					tokenIds: [{ id: OTHER, amount: '999' }, { id: UCT, amount: uct(3n) }],
					senderNametag: 'bob',
				}),
				received(tok(3), { coinId: OTHER, amount: '5' }),        // foreign coin only
				received(tok(4), { coinId: '', amount: '0' }),           // coinless
				{ ...received(tok(5), {}), type: 'SENT' },               // outgoing
			],
			more: true,
			cursor: 'c1',
		},
		{
			entries: [
				received(tok(6), { senderNametag: undefined }),          // no nametag: cannot credit
				received(tok(7), { amount: uct(7n), senderNametag: 'carol' }),
			],
			more: false,
			cursor: null,
		},
	]);

	await reconcileFromHistory(sphere, 0);

	assertEqual(sphere.seenBefore, [undefined, 'c1'], 'walks the cursor');
	assertEqual(await deposits(), [
		{ tx_id: tok(1), nametag: 'alice', amount: 10 },
		{ tx_id: tok(2), nametag: 'bob', amount: 3 },
		{ tx_id: tok(7), nametag: 'carol', amount: 7 },
	]);
});

runTest('arena reconcile: a second pass credits nothing new', async () => {
	const page = {
		entries: [received(tok(1), {}), received(tok(7), { amount: uct(7n), senderNametag: 'carol' })],
		more: false,
		cursor: null,
	};
	const before = await deposits();
	await reconcileFromHistory(stubSphere([page]), 0);
	assertEqual(await deposits(), before, 'ledger unchanged');
});

runTest('arena reconcile: a row the live listener already wrote is not credited again', async () => {
	// What recordIncomingTransfer writes for a live `transfer:incoming`.
	await getDb().execute({
		sql: `INSERT INTO player_transactions (nametag, amount, type, memo, timestamp, tx_id)
		      VALUES (?, ?, 'deposit', ?, ?, ?)`,
		args: ['dave', 4, `on-chain transfer ${tok(8)}`, new Date().toISOString(), tok(8)],
	});
	await reconcileFromHistory(stubSphere([
		{ entries: [received(tok(8), { amount: uct(4n), senderNametag: 'dave' })], more: false, cursor: null },
	]), 0);
	const rows = (await deposits()).filter((d) => d.tx_id === tok(8));
	assertEqual(rows.length, 1, 'exactly one row for the token');
	assert(rows[0].amount === 4, 'amount untouched');
});

runTest('arena reconcile: nothing older than the floor is credited, and the walk stops there', async () => {
	const floor = Date.parse('2026-10-08T12:00:00Z');
	const sphere = stubSphere([
		{
			entries: [
				received(tok(9), { timestamp: floor + 1000, senderNametag: 'erin' }),
				received(tok(10), { timestamp: NaN, senderNametag: 'frank' }),     // unusable: skipped, walk goes on
				received(tok(11), { timestamp: floor, senderNametag: 'grace' }),   // AT the floor: counts
				received(tok(12), { timestamp: floor - 1, senderNametag: 'heidi' }), // older: stop
				received(tok(13), { timestamp: floor - 2, senderNametag: 'ivan' }),
			],
			more: true,
			cursor: 'c-older',
		},
		{ entries: [received(tok(14), { timestamp: floor - 3 })], more: false, cursor: null },
	]);
	await reconcileFromHistory(sphere, floor);
	assertEqual(sphere.seenBefore, [undefined], 'no page fetched past the floor');
	const credited = (await deposits()).map((d) => d.nametag);
	assert(credited.includes('erin') && credited.includes('grace'), 'rows at/after the floor credited');
	for (const n of ['frank', 'heidi', 'ivan']) assert(!credited.includes(n), `${n} must not be credited`);
});

runTest('arena reconcile: the floor is pinned by the first boot against a ledger', async () => {
	const first = await reconcileFloor(1_000);
	const later = await reconcileFloor(5_000);
	assertEqual([first, later], [1_000, 1_000]);
});
