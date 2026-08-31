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

/** The only coin the game ledger denominates in. */
const UCT_SYMBOL = 'UCT';
const UCT_COIN_ID_HEX = '455ad8720656b08e8dbd5bac1f3c73eeea5431565f6c1c3af742b1aa12d41d89';

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
	let total = 0;
	for (const t of transfer.tokens) {
		const tk = t as { coinId?: string; symbol?: string; amount?: string; decimals?: number };
		if (!isUct(tk)) {
			console.log(
				`[arena-watcher] transfer ${transfer.id} carries non-UCT asset ` +
				`(coinId=${tk.coinId ?? '?'} symbol=${tk.symbol ?? '?'}) — not credited`,
			);
			continue;
		}
		// Decimals: prefer what the token says, fall back to UCT's 18 if
		// it's missing or 0 (we don't yet support multi-token economies and
		// the SDK has been inconsistent about populating this field).
		const decimals: number = (typeof tk.decimals === 'number' && tk.decimals > 0) ? tk.decimals : UCT_DECIMALS;
		const raw = String(tk.amount ?? '0');
		try {
			const big = BigInt(raw);
			const divisor = BigInt(10) ** BigInt(decimals);
			const whole = Number(big / divisor);
			total += whole;
		} catch (e) {
			console.warn('[arena-watcher] could not parse token amount', { raw, decimals, token: tk }, e);
		}
	}
	return total;
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
	// mainnet/dev have no embedded trust base and are refused at provider
	// creation.
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

	// Use `import` (not `init`) — it is the ONLY entry point that honours
	// `derivationMode` / `basePath`, and the deployed wallet file may carry them.
	// The same mnemonic under a different derivation is a DIFFERENT identity
	// holding no money, so this is not a detail to trade away for tidiness.
	//
	// Known cost: `Sphere.import` clears existing storage first, so each boot
	// drops the scoped KV (refresh token, receive seen-set, delivery journal)
	// and re-runs the challenge sign-in. Harmless here because the server is the
	// record and `tx_id` is UNIQUE, so a replayed credit is a no-op insert.
	//
	// `network` MUST be passed: it is compared against walletApi.network, and
	// omitting it (as this call used to) is an immediate INVALID_CONFIG.
	sphere = await sdk.Sphere.import({
		mnemonic: wallet.mnemonic,
		network,
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
}

export async function stopArenaWatcher(): Promise<void> {
	if (!sphere) return;
	try { await (sphere as any).destroy?.(); } catch {}
	sphere = null;
}
