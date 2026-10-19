/**
 * Arena wallet watcher.
 *
 * Boots a Sphere instance using the arena wallet's mnemonic, subscribes
 * to incoming on-chain transfers, and credits the local ledger
 * (`player_transactions`) when UCT actually arrives at the arena wallet.
 *
 * No client-side `/api/deposit` is involved — the wallet→wallet transfer
 * over the Sphere network IS the source of truth, and this watcher mirrors
 * confirmed transfers into our internal accounting.
 *
 * CUSTODY MODEL (sphere-sdk >= 0.14.1, the "P11 flip"): the arena wallet no
 * longer keeps tokens on local disk. Inventory, blobs and the incoming mailbox
 * live in the wallet-api backend; this process holds only keys and a small
 * scoped KV. That makes `WALLET_API_URL` mandatory — `Sphere.import` is
 * fail-closed and throws INVALID_CONFIG without a `walletApi` config, before it
 * writes anything.
 *
 * Configuration (Fly secrets):
 *   ARENA_WALLET_FILE      JSON exported from a Sphere wallet (contains
 *                          `mnemonic` field). The full file body is set
 *                          as the secret value. Required.
 *   ARENA_WALLET_NAMETAG   Display nametag, e.g. '@boxyrunarena'. Used
 *                          for log/diag output only — the SDK derives
 *                          identity from the mnemonic.
 *   WALLET_API_URL         wallet-api backend base URL. Defaults to the
 *                          production backend, which is where the deployed
 *                          Sphere wallet (sphere.unicity.network) keeps its
 *                          users' tokens. A player's send deposits into the
 *                          arena wallet's mailbox ON THAT BACKEND, so pointing
 *                          this at a different one means deposits are accepted
 *                          on chain and then never delivered here.
 *   WALLET_API_DEVICE_ID   Stable per-deployment label keying the refresh-token
 *                          row. Defaults to a name derived from the network.
 *                          Two processes sharing one value fight over the same
 *                          rotating token; give staging and prod distinct ones.
 *   AGGREGATOR_API_KEY     Gateway API key for the token engine. The SDK no
 *                          longer bundles a default. The testnet2 key is
 *                          documented non-secret, so it is defaulted below; a
 *                          mainnet key would be a real secret.
 *   SPHERE_NETWORK         Defaults to 'testnet2'. This string must EXACTLY
 *                          match the backend's configured network: the SDK
 *                          verifies it against the `network` field embedded in
 *                          the auth challenge, so 'testnet' — an alias of
 *                          testnet2 everywhere else in the SDK — fails sign-in
 *                          with ChallengeTemplateError.
 *   SPHERE_DATA_DIR        Where Sphere caches its state. Defaults to
 *                          '/data/arena-sphere' (on the Fly volume so
 *                          the cache survives restarts).
 *
 * Idempotency: each `IncomingTransfer.id` becomes the `tx_id` on the
 * inserted row. The column has UNIQUE so duplicate firings (after a
 * reconnect, a crash between store and mailbox-ack, etc.) silently no-op.
 * After every boot the watcher also replays the wallet's RECEIVED history
 * under the same key (reconcileFromHistory), to credit arrivals the live
 * listener could not see.
 *
 * Two things to know about that key, neither of which is a defect introduced
 * here — both are recorded so the next reader does not rediscover them:
 *
 *  - The id is, and always was, the token's GENESIS id: `v2_<tokenId>` before
 *    the 0.15.0 bump and bare `<tokenId>` after it. The format change means old
 *    `v2_*` rows and new bare-hex rows coexist in `player_transactions`, and a
 *    token credited under the old format would not collide with itself under
 *    the new one. Unreachable in practice — the state-transition 3.x wire break
 *    came with a testnet reset and a backend inventory truncation on
 *    2026-08-29, so no pre-migration token can arrive again.
 *  - Because the key is the genesis id and not (tokenId, stateHash) — which is
 *    what the SDK's own receive dedup uses — a token that legitimately returns
 *    to this wallet at a LATER state is refused as a duplicate and credits
 *    nothing. The event does not carry `stateHash`, so the watcher cannot key
 *    on it. Left as-is deliberately: the alternative keys all trade this
 *    under-credit for a double-credit on crash-redelivery, which is worse.
 */

import { existsSync, mkdirSync } from 'node:fs';
// NOTE: @unicitylabs/sphere-sdk is ESM-only. The server is a CJS bundle
// (esbuild --format=cjs) so we can't `require()` it. Use dynamic import
// inside startArenaWatcher() instead — Node handles ESM-from-CJS via
// `import()` at runtime.
import { getDb, ensureSchema } from './db';

// IncomingTransfer type is structurally simple — re-declare locally to
// avoid pulling the SDK type into the static import graph.
type IncomingTransfer = {
	readonly id: string;
	readonly senderPubkey: string;
	readonly senderNametag?: string;
	readonly tokens: ReadonlyArray<{ coinId?: string; symbol?: string; amount?: string; decimals?: number }>;
	readonly memo?: string;
	readonly receivedAt: number;
};

let sphere: any = null;
let transport: any = null;

/** Exposed for the auth module — resolveNametagInfo() lives on the
 *  TransportProvider returned by createNodeProviders. Returns null until
 *  the watcher has booted. */
export function getTransport(): any {
	return transport;
}

interface ParsedWallet {
	mnemonic: string;
	masterKey?: string;
	chainCode?: string;
	derivationMode?: string;
	basePath?: string;
}

/** Parse the wallet JSON blob from the env secret. Returns import options. */
function readWalletFile(): ParsedWallet {
	const raw = process.env.ARENA_WALLET_FILE;
	if (!raw) throw new Error('[arena-watcher] ARENA_WALLET_FILE not set');
	let parsed: any;
	try { parsed = JSON.parse(raw); }
	catch (e) { throw new Error('[arena-watcher] ARENA_WALLET_FILE is not valid JSON: ' + (e as Error).message); }
	const mnemonic = parsed.mnemonic;
	if (typeof mnemonic !== 'string' || mnemonic.split(/\s+/).length < 12) {
		throw new Error('[arena-watcher] mnemonic missing or malformed in ARENA_WALLET_FILE');
	}
	// Pull HD derivation fields so the SDK reconstructs the SAME identity
	// the wallet was created with — without these the nametag binding (and
	// any tracked addresses) won't be found.
	return {
		mnemonic,
		masterKey: parsed.wallet?.masterPrivateKey,
		chainCode: parsed.wallet?.chainCode,
		derivationMode: parsed.derivationMode,
		basePath: parsed.wallet?.descriptorPath,
	};
}

/** UCT has 18 decimals on Unicity. Used as a fallback when the SDK's
 *  Token payload doesn't surface the decimals field. */
const UCT_DECIMALS = 18;

/**
 * The only coin the game ledger denominates in.
 *
 * This is the TESTNET2 id, taken from the network's own registry
 * (unicity-ids.testnet2.json). The id Boxy-Run carried before —
 * 455ad8720656b08e8dbd5bac1f3c73eeea5431565f6c1c3af742b1aa12d41d89 — is the v1
 * testnet coin and does not appear in the testnet2 registry at all, so keying
 * anything on it matches nothing that can actually arrive here.
 */
const UCT_SYMBOL = 'UCT';
const UCT_COIN_ID_HEX = 'f581d30f593e4b369d684a4563b5246f07b1d265f7178a2c0a82b81f39c24dc0';

/** True when an incoming token entry is the coin this ledger accounts in. */
function isUct(tk: { coinId?: string; symbol?: string }): boolean {
	if (typeof tk.coinId === 'string' && tk.coinId.length > 0) {
		return tk.coinId.toLowerCase() === UCT_COIN_ID_HEX;
	}
	// No coinId (older payloads): fall back to the registry-resolved symbol.
	return tk.symbol === UCT_SYMBOL;
}

/**
 * Sum the UCT carried by a transfer, in whole tokens.
 *
 * WHY THE COIN FILTER — `IncomingTransfer.tokens` is NOT a list of tokens: it is
 * one entry PER ASSET carried by the token, and every entry repeats the same
 * `id` (see Receive.ts, `record.assets.map(toUiToken)`). Summing it blindly
 * credits any other coin that happened to ride along as if it were UCT, at UCT's
 * decimals. Under the old delivery rail the array was always `[token]`, which is
 * why this went unnoticed.
 */
function sumIncomingAmount(transfer: IncomingTransfer): number {
	// Accumulate in BASE UNITS and divide ONCE at the end. Dividing per entry
	// floors each one separately, and a single 10 UCT send routinely arrives as
	// several tokens of arbitrary size (only the split leg is exact; direct legs
	// are whatever the sender's inventory happened to hold) — so 3.5 + 6.5 would
	// credit 3 + 6 = 9 and quietly eat a whole UCT.
	let baseUnits = 0n;
	let decimals = UCT_DECIMALS;
	for (const t of transfer.tokens) {
		const tk = t as { coinId?: string; symbol?: string; amount?: string; decimals?: number };
		if (!isUct(tk)) {
			console.log(
				`[arena-watcher] transfer ${transfer.id} carries non-UCT asset ` +
				`(coinId=${tk.coinId ?? '?'} symbol=${tk.symbol ?? '?'}) — not credited`,
			);
			continue;
		}
		// Decimals: prefer what the token says, fall back to UCT's 18 if it is
		// missing or 0. A cold TokenRegistry reports 0 for a coin it has not
		// fetched yet, and taking that literally would credit raw base units as
		// whole UCT — a 10^18x over-credit.
		if (typeof tk.decimals === 'number' && tk.decimals > 0) decimals = tk.decimals;
		const raw = String(tk.amount ?? '0');
		try {
			baseUnits += BigInt(raw);
		} catch (e) {
			console.warn('[arena-watcher] could not parse token amount', { raw, token: tk }, e);
		}
	}
	if (baseUnits === 0n) return 0;
	const divisor = 10n ** BigInt(decimals);
	const whole = Number(baseUnits / divisor);
	const remainder = baseUnits % divisor;
	if (remainder !== 0n) {
		// The ledger's amount column is INTEGER, so a fractional tail cannot be
		// stored. Log it rather than lose it silently — it is real money.
		console.warn(
			`[arena-watcher] transfer ${transfer.id} has a fractional remainder ` +
			`${remainder.toString()} base units (${decimals} decimals) that the INTEGER ` +
			`ledger cannot hold — credited ${whole} UCT`,
		);
	}
	return whole;
}

/**
 * Persist a confirmed incoming transfer to the local ledger.
 * Returns `true` if a new row was written, `false` if it was already
 * recorded (duplicate transfer.id) or skipped.
 */
async function recordIncomingTransfer(transfer: IncomingTransfer): Promise<boolean> {
	const senderNametag = transfer.senderNametag;
	if (!senderNametag) {
		// No way to credit a sender without a nametag (we'd have nowhere to
		// show the balance). Log so the operator can manually credit if a
		// claim turns up later.
		console.warn(
			`[arena-watcher] transfer ${transfer.id} has no senderNametag — skipping ` +
			`(senderPubkey=${transfer.senderPubkey})`,
		);
		return false;
	}
	const amount = sumIncomingAmount(transfer);
	if (amount <= 0) {
		console.warn(`[arena-watcher] transfer ${transfer.id} resolved to amount=${amount} — skipping`);
		return false;
	}

	await ensureSchema();
	const db = getDb();
	const ts = new Date(transfer.receivedAt || Date.now()).toISOString();
	try {
		await db.execute({
			sql: `INSERT INTO player_transactions
			      (nametag, amount, type, memo, timestamp, tx_id)
			      VALUES (?, ?, ?, ?, ?, ?)`,
			args: [senderNametag, amount, 'deposit', `on-chain transfer ${transfer.id}`, ts, transfer.id],
		});
		console.log(`[arena-watcher] credited @${senderNametag} +${amount} UCT (tx=${transfer.id})`);
		return true;
	} catch (err: any) {
		// UNIQUE conflict on tx_id = duplicate event, ignore
		if (String(err?.message || '').includes('UNIQUE')) {
			console.log(`[arena-watcher] tx ${transfer.id} already recorded — skipping`);
			return false;
		}
		console.error(`[arena-watcher] failed to insert ledger row for tx=${transfer.id}`, err);
		throw err;
	}
}

/** A row of `sphere.payments.history()` (the SDK's HistoryEntry), re-declared
 *  for the same reason as IncomingTransfer above. */
type HistoryEntry = {
	readonly type: 'SENT' | 'RECEIVED' | 'MINT';
	readonly tokenId?: string;
	readonly coinId: string;
	readonly amount: string;
	/** Set only when the token carried more than one asset. Despite the name,
	 *  each `id` is a COIN id. */
	readonly tokenIds?: ReadonlyArray<{ id: string; amount: string }>;
	readonly senderPubkey?: string;
	readonly senderNametag?: string;
	readonly memo?: string;
	readonly timestamp: number;
};

/** wallet-api's history page maximum; larger values are clamped to it. */
const HISTORY_PAGE_LIMIT = 500;

/**
 * Credit every RECEIVED history row the ledger does not have yet.
 *
 * WHY: the live `transfer:incoming` listener cannot see every arrival.
 * `Sphere.import` starts the payments vertical before it returns, and the
 * wallet-api socket's first open triggers a mailbox drain that nothing awaits.
 * A deposit that arrived while this process was down can therefore be stored,
 * acked and announced before the listener below exists, and that event is
 * gone. The SDK writes the arrival to the server-side history BEFORE it emits
 * the event, so this pass recovers it. It also recovers a credit whose insert
 * failed (a DB error, say) after the mailbox entry was already acked.
 *
 * Keyed exactly like the live path: `tx_id` is the token id. History lowercases
 * it, and wallet-api accepts only lowercase-hex token ids, so the live id is
 * lowercase too. A row both paths see is inserted once (`tx_id` is UNIQUE).
 *
 * Only rows at or after `sinceMs` are considered (see reconcileFloor). The
 * history reaches back further than this ledger does: past a ledger reset, and
 * to deposits keyed `v2_<tokenId>` before the 0.15.0 bump. Replaying those
 * would credit deposits a second time, or without the game debits they paid
 * for. History is served newest first, so the walk stops at the first row
 * older than the floor.
 *
 * Remaining gap: the SDK's history POST is best-effort. If that POST failed
 * AND the event fired before the listener existed, neither path sees the
 * arrival.
 */
export async function reconcileFromHistory(s: any, sinceMs: number): Promise<void> {
	await ensureSchema();
	const known = new Set<string>(
		(await getDb().execute('SELECT tx_id FROM player_transactions WHERE tx_id IS NOT NULL'))
			.rows.map((r: any) => String(r.tx_id)),
	);
	let before: string | undefined;
	let checked = 0;
	let credited = 0;
	walk: do {
		const page = await s.payments.history({
			limit: HISTORY_PAGE_LIMIT,
			...(before !== undefined ? { before } : {}),
		});
		for (const e of page.entries as HistoryEntry[]) {
			// No usable timestamp: cannot tell which side of the floor it is on,
			// so never credit it — but do not let it end the walk either.
			if (!Number.isFinite(e.timestamp)) continue;
			if (e.timestamp < sinceMs) break walk;
			if (e.type !== 'RECEIVED' || !e.tokenId || known.has(e.tokenId)) continue;
			const tokens = (e.tokenIds ?? [{ id: e.coinId, amount: e.amount }])
				.map((a) => ({ coinId: a.id, amount: a.amount }));
			// Nothing here this ledger accounts in (another coin, or coinless).
			if (!tokens.some(isUct)) continue;
			checked++;
			const wrote = await recordIncomingTransfer({
				id: e.tokenId,
				senderPubkey: e.senderPubkey ?? '',
				...(e.senderNametag !== undefined ? { senderNametag: e.senderNametag } : {}),
				tokens,
				...(e.memo !== undefined ? { memo: e.memo } : {}),
				receivedAt: e.timestamp,
			});
			if (wrote) credited++;
		}
		before = page.more && page.cursor ? page.cursor : undefined;
	} while (before !== undefined);
	console.log(
		`[arena-watcher] history reconcile since ${new Date(sinceMs).toISOString()}: ` +
		`${checked} uncredited UCT arrival(s) found, ${credited} credited`,
	);
}

/**
 * The history reconcile's floor, in epoch ms: the start of the first boot
 * against THIS ledger, recorded in the DB, so it resets together with the
 * ledger. `bootStartedAt` must be taken before `Sphere.import`. Arrivals
 * drained during the import are timestamped after it, so the first boot's own
 * window is covered.
 */
export async function reconcileFloor(bootStartedAt: number): Promise<number> {
	await ensureSchema();
	const db = getDb();
	await db.execute({
		sql: `INSERT OR IGNORE INTO arena_watcher_state (key, value) VALUES ('reconcile_since', ?)`,
		args: [String(bootStartedAt)],
	});
	const res = await db.execute(`SELECT value FROM arena_watcher_state WHERE key = 'reconcile_since'`);
	return Number(res.rows[0].value);
}

/**
 * Boot the watcher. Idempotent — calling more than once is a no-op.
 * Throws if ARENA_WALLET_FILE is missing or malformed; the server should
 * decide whether that's fatal.
 */
export async function startArenaWatcher(): Promise<void> {
	if (sphere) return;

	const wallet = readWalletFile();
	// Resolve the network ONCE and reuse the same string for the base providers,
	// the wallet-api config and Sphere.import. That is load-bearing, not tidiness:
	// resolvePaymentsV2Composition() string-compares walletApi.network against the
	// Sphere network and throws INVALID_CONFIG on any difference, and the
	// wallet-api auth challenge embeds the backend's own network name which the
	// SDK verifies against ours. 'testnet2' is what both deployed backends issue.
	// Only testnet2 is wired up here: the relay, the aggregator key default and
	// UCT_COIN_ID_HEX are all testnet2's.
	const network = (process.env.SPHERE_NETWORK || 'testnet2') as 'testnet' | 'testnet2';
	const dataDir = process.env.SPHERE_DATA_DIR || '/data/arena-sphere';
	if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

	// Server custody: without this the wallet has nowhere to hold tokens and
	// Sphere.import refuses to boot. Default to production — that is the backend
	// the deployed Sphere wallet uses, so it is where players' sends deposit.
	const walletApiUrl = process.env.WALLET_API_URL || 'https://wallet-api.unicity.network';
	// Documented non-secret for testnet2; override for any network where it isn't.
	const aggregatorApiKey = process.env.AGGREGATOR_API_KEY || 'sk_ddc3cfcc001e4a28ac3fad7407f99590';
	const deviceId = process.env.WALLET_API_DEVICE_ID || `boxyrun-arena-${network}`;

	// Stick to the Unicity-operated relay — adding public Nostr relays
	// (damus.io, nos.lol) can hang the boot when one of them returns 503 or 5xx,
	// because the SDK awaits every transport handshake. Nostr now carries only
	// DMs and nametag bindings; no asset traffic rides it.
	const testnetRelays = ['wss://nostr-relay.testnet.unicity.network'];

	console.log(
		`[arena-watcher] booting Sphere (network=${network} dataDir=${dataDir} walletApi=${walletApiUrl})`,
	);
	// Dynamic import so esbuild's CJS bundle doesn't try to `require()`
	// the ESM-only SDK at module load time.
	const sdk = await import('@unicitylabs/sphere-sdk');
	const sdkNode = await import('@unicitylabs/sphere-sdk/impl/nodejs' as any);
	const sdkWalletApi = await import('@unicitylabs/sphere-sdk/impl/shared/wallet-api' as any);
	// `tokensDir` is gone: token custody moved to the backend, so there is no
	// local token store to point at. The oracle apiKey is now required — the SDK
	// ships no bundled default, and the token engine (which verifies every
	// incoming token before it counts) needs the gateway.
	const base = sdkNode.createNodeProviders({
		network,
		dataDir,
		oracle: { apiKey: aggregatorApiKey },
		transport: { relays: testnetRelays },
	});
	// Attaches the plain `walletApi` transport config the payments vertical is
	// composed from. Node >= 22 supplies global fetch + WebSocket, so no
	// injected factories are needed.
	const providers = sdkWalletApi.createWalletApiProviders(base, {
		baseUrl: walletApiUrl,
		network,
		deviceId,
	});
	// Stash for the auth module's nametag → chainPubkey resolver.
	transport = providers.transport;

	// Use `import` (not `init`). `import` is the only entry point that ACCEPTS
	// `basePath`, and the deployed wallet file may carry a descriptorPath; the
	// same mnemonic under a different derivation is a DIFFERENT identity holding
	// no money, so the entry point is not a detail to trade away for tidiness.
	//
	// Be precise about what actually applies, though: on the MNEMONIC path
	// `Sphere.import` ignores `derivationMode` entirely (storeMnemonic hard-sets
	// 'bip32'; options.derivationMode is only read on the masterKey path). It is
	// still passed below so the masterKey path stays correct if this ever grows
	// one, but do not read its presence as proof the mode is being honoured.
	//
	// `overwrite: true` is required, not optional. Since sphere-sdk 0.17.4,
	// `Sphere.import` refuses with ALREADY_INITIALIZED over a storage that
	// already holds a wallet, and `dataDir` sits on the Fly volume, so without
	// it every boot after the first dies. Replacing rather than `load`ing keeps
	// ARENA_WALLET_FILE authoritative: a rotated secret takes effect on the next
	// boot instead of the old wallet on the volume being silently watched.
	//
	// Known cost: the overwrite clears the whole store, so each boot drops the
	// scoped KV (refresh token, receive seen-set, delivery journal) and re-runs
	// the challenge sign-in. Harmless here: this wallet only receives, so there
	// are no outgoing intents in that journal to lose, the server is the record,
	// and `tx_id` is UNIQUE, so a replayed credit is a no-op insert.
	//
	// `network` MUST be passed: it is compared against walletApi.network, and
	// omitting it (as this call used to) is an immediate INVALID_CONFIG.
	//
	// The import drains the mailbox before the listener below exists, so the
	// reconcile floor has to be taken BEFORE it (see reconcileFloor).
	const bootStartedAt = Date.now();
	sphere = await sdk.Sphere.import({
		mnemonic: wallet.mnemonic,
		network,
		overwrite: true,
		...(wallet.derivationMode ? { derivationMode: wallet.derivationMode } : {}),
		...(wallet.basePath ? { basePath: wallet.basePath } : {}),
		...providers,
	});
	const id = sphere.identity;
	console.log(
		`[arena-watcher] Sphere ready — nametag=${id?.nametag ? '@' + id.nametag : '(none)'} ` +
		`directAddress=${id?.directAddress || '?'}`,
	);

	// Subscribe to incoming transfers. The SDK emits this event after the
	// inclusion proof has been verified — i.e., the tokens have actually
	// arrived at our wallet on-chain.
	sphere.on('transfer:incoming', (transfer: IncomingTransfer) => {
		// Fire-and-forget; recordIncomingTransfer logs its own outcome.
		recordIncomingTransfer(transfer).catch(err => {
			console.error('[arena-watcher] handler crashed', err);
		});
	});
	console.log('[arena-watcher] subscribed to transfer:incoming');

	// AFTER the listener is attached, so nothing falls between the two: an
	// arrival announced from now on reaches the listener, and anything announced
	// earlier is already in the history. See reconcileFromHistory for why this
	// pass is needed. Its failure must not take the live listener down with it.
	await reconcileFloor(bootStartedAt)
		.then((since) => reconcileFromHistory(sphere, since))
		.catch((err) => {
			console.error('[arena-watcher] history reconcile failed — arrivals announced during boot may be uncredited', err);
		});
}

export async function stopArenaWatcher(): Promise<void> {
	if (!sphere) return;
	try { await (sphere as any).destroy?.(); } catch {}
	sphere = null;
}
