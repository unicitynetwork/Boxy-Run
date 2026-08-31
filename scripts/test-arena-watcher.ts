/**
 * Local test for the arena watcher.
 *
 * Loads the staging wallet from boxyrunstaging.json, boots a Sphere
 * instance, prints the identity it resolved, and subscribes to incoming
 * transfers. Stays running until you Ctrl-C.
 *
 * Usage:
 *   npx tsx scripts/test-arena-watcher.ts
 *
 * Environment overrides (optional):
 *   ARENA_WALLET_PATH   path to the wallet JSON (default: ./boxyrunstaging.json)
 *   SPHERE_DATA_DIR     where Sphere caches state    (default: ./arena-test-data)
 *   SPHERE_NETWORK      default 'testnet2' (must match the backend exactly)
 *   WALLET_API_URL      default the STAGING backend — this is a test script, so
 *                       it points somewhere you can safely churn sign-ins
 *   AGGREGATOR_API_KEY  default the non-secret testnet2 gateway key
 *
 * Then, from a different Sphere wallet, send some UCT to @boxyrunstaging.
 * If the watcher is wired correctly, you'll see:
 *   [test] transfer:incoming  ...full payload...
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

// Polyfill global WebSocket for Node 20 (added natively in Node 22).
if (typeof (globalThis as any).WebSocket === 'undefined') {
	// `ws` is already a dep
	(globalThis as any).WebSocket = require('ws');
}

const walletPath = resolve(process.env.ARENA_WALLET_PATH || './boxyrunstaging.json');
const dataDir = resolve(process.env.SPHERE_DATA_DIR || './arena-test-data');

async function main() {
	if (!existsSync(walletPath)) {
		console.error(`✗ Wallet file not found at ${walletPath}`);
		process.exit(2);
	}
	if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

	const raw = readFileSync(walletPath, 'utf8');
	const parsed = JSON.parse(raw);
	const mnemonic = parsed.mnemonic;
	if (!mnemonic) {
		console.error('✗ wallet file has no mnemonic field');
		process.exit(3);
	}

	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
	console.log('  Arena watcher local test');
	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
	console.log(`  walletPath:    ${walletPath}`);
	console.log(`  dataDir:       ${dataDir}`);
	console.log(`  mnemonicLen:   ${mnemonic.split(/\s+/).length} words`);
	console.log(`  derivationMode: ${parsed.derivationMode || '(none)'}`);
	console.log(`  basePath:       ${parsed.wallet?.descriptorPath || '(none)'}`);
	console.log('');

	// Must be the backend's exact network name — the SDK verifies it against the
	// name embedded in the auth challenge, so the 'testnet' alias fails sign-in.
	const network = (process.env.SPHERE_NETWORK || 'testnet2') as 'testnet' | 'testnet2';
	const walletApiUrl = process.env.WALLET_API_URL || 'https://wallet-api.staging.unicity.network';
	const aggregatorApiKey = process.env.AGGREGATOR_API_KEY || 'sk_ddc3cfcc001e4a28ac3fad7407f99590';
	console.log(`→ Initializing Node providers (network=${network} walletApi=${walletApiUrl})…`);
	// No `tokensDir` — token custody is the wallet-api backend now — and the
	// oracle apiKey has no bundled default.
	const base = createNodeProviders({
		network,
		dataDir,
		oracle: { apiKey: aggregatorApiKey },
		transport: { relays: ['wss://nostr-relay.testnet.unicity.network'] },
	});
	const providers = createWalletApiProviders(base, {
		baseUrl: walletApiUrl,
		network,
		deviceId: `boxyrun-arena-test-${network}`,
	});

	console.log('→ Importing wallet from mnemonic…');
	const sphere = await Sphere.import({
		mnemonic,
		network,
		...(parsed.derivationMode ? { derivationMode: parsed.derivationMode } : {}),
		...(parsed.wallet?.descriptorPath ? { basePath: parsed.wallet.descriptorPath } : {}),
		...providers,
	});

	const id = sphere.identity;
	console.log('');
	console.log('✓ Sphere ready');
	console.log(`  nametag:       ${id?.nametag ? '@' + id.nametag : '(none)'}`);
	console.log(`  directAddress: ${id?.directAddress || '(none)'}`);
	console.log(`  pubkey:        ${(id as any)?.chainPubkey || (id as any)?.pubkey || '(none)'}`);
	console.log('');

	// Now that the transport is connected, ask the network: who owns @boxyrunstaging?
	// If the answer's pubkey/directAddress matches ours, we've derived the same
	// identity but the binding lookup just isn't being applied. If it differs,
	// our derivation is wrong — the wallet UI used a different path / mode.
	console.log('→ Resolving @boxyrunstaging on the network (post-connect)…');
	try {
		const transport: any = providers.transport;
		const info = await transport.resolveNametagInfo?.('boxyrunstaging');
		if (info) {
			console.log('  network says @boxyrunstaging =');
			console.log(`    chainPubkey:     ${info.chainPubkey}`);
			console.log(`    directAddress:   ${info.directAddress}`);
			console.log(`    transportPubkey: ${info.transportPubkey}`);
			const ourPubkey = (id as any)?.chainPubkey;
			console.log(`  match? chainPubkey:   ${info.chainPubkey === ourPubkey ? 'YES' : 'NO'}`);
			console.log(`  match? directAddress: ${info.directAddress === id?.directAddress ? 'YES' : 'NO'}`);
		} else {
			console.log('  (not found on the network — nametag may not be registered)');
		}
	} catch (e: any) {
		console.log('  resolveNametagInfo threw:', e?.message || e);
	}
	console.log('');

	// If no nametag is bound, run address discovery — this scans the
	// transport (Nostr) for HD addresses owned by this wallet,
	// including any nametag bindings.
	if (!id?.nametag) {
		console.log('  ⚠ No nametag bound after import. Running discoverAddresses()…');
		const result: any = await (sphere as any).discoverAddresses({
			autoTrack: true,
			maxAddresses: 20,
			gapLimit: 10,
			onProgress: (p: any) => console.log('    progress:', JSON.stringify(p)),
		});
		console.log(`  → scanned ${result.scannedCount} indices, found ${result.addresses?.length || 0} addresses`);
		for (const addr of result.addresses || []) {
			console.log(`    [${addr.index}] ${addr.directAddress}  nametag=${addr.nametag || '(none)'}  chainPubkey=${addr.chainPubkey}`);
		}
		const id2 = sphere.identity;
		console.log(`  identity after discovery → nametag=${id2?.nametag ? '@' + id2.nametag : '(none)'}`);
		console.log('');
	}

	// Subscribe to all transfer-related events.
	sphere.on('transfer:incoming', (transfer: any) => {
		console.log('━━ transfer:incoming ━━');
		console.log(JSON.stringify({
			id: transfer.id,
			senderPubkey: transfer.senderPubkey,
			senderNametag: transfer.senderNametag,
			tokens: transfer.tokens?.map((t: any) => ({
				symbol: t.symbol,
				amount: t.amount,
				decimals: t.decimals,
				status: t.status,
			})),
			memo: transfer.memo,
			receivedAt: new Date(transfer.receivedAt).toISOString(),
		}, null, 2));
	});
	// The pre-flip event names (transfer:confirmed / transfer:failed / sync:* /
	// connection:changed) were REMOVED from the public event map. Subscribing to
	// them is not an error — `on()` accepts any name — it just silently never
	// fires, which is exactly how a diagnostic script lies to you. These are the
	// v2 names.
	sphere.on('transfer:updated', (r: any) => {
		console.log('━━ transfer:updated ━━', r?.id, r?.status, r?.error ?? '', r?.deliveryState ?? '');
	});
	sphere.on('transfer:attention', (e: any) => {
		console.log('━━ transfer:attention ━━', JSON.stringify(e));
	});
	sphere.on('inventory:updated', () => {
		console.log('━━ inventory:updated ━━');
	});
	sphere.on('history:updated', (e: any) => {
		console.log('━━ history:updated ━━', JSON.stringify(e));
	});
	sphere.on('connection:status', (e: any) => {
		console.log('━━ connection:status ━━', JSON.stringify(e));
	});
	sphere.on('nametag:registered', (e: any) => {
		console.log('━━ nametag:registered ━━', e);
	});
	sphere.on('nametag:recovered', (e: any) => {
		console.log('━━ nametag:recovered ━━', e);
	});

	console.log('→ Subscribed to transfer:incoming + related events.');
	console.log('→ Now send some UCT from another wallet to @boxyrunstaging');
	console.log('  (or to whichever nametag this wallet actually owns).');
	console.log('  Press Ctrl-C to exit.');
	console.log('');

	process.on('SIGINT', async () => {
		console.log('\n→ Shutting down…');
		try { await (sphere as any).destroy?.(); } catch {}
		process.exit(0);
	});

	// Keep the process alive
	await new Promise(() => {});
}

main().catch((err) => {
	console.error('✗ Fatal:', err?.stack || err?.message || err);
	process.exit(1);
});
