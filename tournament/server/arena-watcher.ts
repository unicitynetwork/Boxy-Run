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
 * Configuration (Fly secrets):
 *   ARENA_WALLET_FILE      JSON exported from a Sphere wallet (contains
 *                          `mnemonic` field). The full file body is set
 *                          as the secret value. Required.
 *   ARENA_WALLET_NAMETAG   Display nametag, e.g. '@boxyrunarena'. Used
 *                          for log/diag output only — the SDK derives
 *                          identity from the mnemonic.
 *   SPHERE_NETWORK         'mainnet' | 'testnet' | 'dev'. Defaults to
 *                          'mainnet'.
 *   SPHERE_DATA_DIR        Where Sphere caches its state. Defaults to
 *                          '/data/arena-sphere' (on the Fly volume so
 *                          the cache survives restarts).
 *
 * Idempotency: each `IncomingTransfer.id` becomes the `tx_id` on the
 * inserted row. The column has UNIQUE so duplicate firings (after a
 * reconnect, sync replay, etc.) silently no-op.
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
	readonly tokens: ReadonlyArray<{ amount?: string; decimals?: number }>;
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

/** Sum UCT (or whatever the configured coin is) across the transfer's tokens. */
function sumIncomingAmount(transfer: IncomingTransfer): number {
	let total = 0;
	for (const t of transfer.tokens) {
		const tk = t as any;
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
	const network = (process.env.SPHERE_NETWORK || 'mainnet') as 'mainnet' | 'testnet' | 'dev';
	const dataDir = process.env.SPHERE_DATA_DIR || '/data/arena-sphere';
	if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

	// Stick to the Unicity-operated relay for each network — adding public
	// Nostr relays (damus.io, nos.lol) can hang the boot when one of them
	// returns 503 or 5xx, because the SDK awaits every transport handshake.
	// `wss://relay.unicity.network` (in the SDK's mainnet defaults)
	// currently NXDOMAINs — use the sphere-relay variant instead.
	const mainnetRelays = ['wss://sphere-relay.unicity.network'];
	const testnetRelays = ['wss://nostr-relay.testnet.unicity.network'];

	console.log(`[arena-watcher] booting Sphere (network=${network} dataDir=${dataDir})`);
	// Dynamic import so esbuild's CJS bundle doesn't try to `require()`
	// the ESM-only SDK at module load time.
	const sdk = await import('@unicitylabs/sphere-sdk');
	const sdkNode = await import('@unicitylabs/sphere-sdk/impl/nodejs' as any);
	const providers = sdkNode.createNodeProviders({
		network,
		dataDir,
		tokensDir: `${dataDir}/tokens`,
		transport: {
			relays: network === 'testnet' ? testnetRelays : mainnetRelays,
		},
	});
	// Stash for the auth module's nametag → chainPubkey resolver.
	transport = providers.transport;

	// Use `import` (not `load`) — we only have the mnemonic + derivation
	// fields, not a populated storage. Pass through `derivationMode` and
	// `basePath` from the wallet file so the SDK reconstructs the SAME
	// identity (including the nametag binding) the wallet was created with.
	// Without these, the same mnemonic derives a different identity and
	// `@boxyrunstaging` won't be associated with this Sphere instance.
	sphere = await sdk.Sphere.import({
		mnemonic: wallet.mnemonic,
		...(wallet.derivationMode ? { derivationMode: wallet.derivationMode } : {}),
		...(wallet.basePath ? { basePath: wallet.basePath } : {}),
		...providers,
	});
	const id = sphere.identity;
	console.log(
		`[arena-watcher] Sphere ready — nametag=${id?.nametag ? '@' + id.nametag : '(none)'} ` +
		`l1Address=${id?.l1Address || '?'}`,
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
