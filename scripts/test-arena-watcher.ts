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
 *
 * Then, from a different Sphere wallet, send some UCT to @boxyrunstaging.
 * If the watcher is wired correctly, you'll see:
 *   [test] transfer:incoming  ...full payload...
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

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

	const network = (process.env.SPHERE_NETWORK || 'mainnet') as 'mainnet' | 'testnet' | 'dev';
	console.log(`→ Initializing Node providers (network=${network})…`);
	const providers = createNodeProviders({
		network,
		dataDir,
		tokensDir: `${dataDir}/tokens`,
		// Mainnet default `wss://relay.unicity.network` NXDOMAINs.
		// Testnet uses `wss://nostr-relay.testnet.unicity.network`.
		transport: network === 'testnet'
			? { relays: ['wss://nostr-relay.testnet.unicity.network'] }
			: { relays: ['wss://sphere-relay.unicity.network', 'wss://nos.lol'] },
	});

	console.log('→ Importing wallet from mnemonic…');
	const sphere = await Sphere.import({
		mnemonic,
		...(parsed.derivationMode ? { derivationMode: parsed.derivationMode } : {}),
		...(parsed.wallet?.descriptorPath ? { basePath: parsed.wallet.descriptorPath } : {}),
		...providers,
	});

	const id = sphere.identity;
	console.log('');
	console.log('✓ Sphere ready');
	console.log(`  nametag:    ${id?.nametag ? '@' + id.nametag : '(none)'}`);
	console.log(`  l1Address:  ${id?.l1Address || '(none)'}`);
	console.log(`  pubkey:     ${(id as any)?.chainPubkey || (id as any)?.pubkey || '(none)'}`);
	console.log('');

	// Now that the transport is connected, ask the network: who owns @boxyrunstaging?
	// If the answer's pubkey/l1Address matches ours, we've derived the same
	// identity but the binding lookup just isn't being applied. If it differs,
	// our derivation is wrong — the wallet UI used a different path / mode.
	console.log('→ Resolving @boxyrunstaging on the network (post-connect)…');
	try {
		const transport: any = providers.transport;
		const info = await transport.resolveNametagInfo?.('boxyrunstaging');
		if (info) {
			console.log('  network says @boxyrunstaging =');
			console.log(`    chainPubkey:     ${info.chainPubkey}`);
			console.log(`    l1Address:       ${info.l1Address}`);
			console.log(`    directAddress:   ${info.directAddress}`);
			console.log(`    transportPubkey: ${info.transportPubkey}`);
			const ourPubkey = (id as any)?.chainPubkey;
			console.log(`  match? chainPubkey: ${info.chainPubkey === ourPubkey ? 'YES' : 'NO'}`);
			console.log(`  match? l1Address:   ${info.l1Address === id?.l1Address ? 'YES' : 'NO'}`);
		} else {
			console.log('  (not found on the network — nametag may not be registered)');
		}
	} catch (e: any) {
		console.log('  resolveNametagInfo threw:', e?.message || e);
	}
	console.log('');

	// If no nametag is bound, run address discovery — this scans the
	// transport (Nostr) and L1 for HD addresses owned by this wallet,
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
			console.log(`    [${addr.index}] ${addr.l1Address}  nametag=${addr.nametag || '(none)'}  l1Balance=${addr.l1Balance}`);
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
	sphere.on('transfer:confirmed', (r: any) => {
		console.log('━━ transfer:confirmed ━━', r?.id, r?.status);
	});
	sphere.on('transfer:failed', (r: any) => {
		console.log('━━ transfer:failed ━━', r?.id, r?.error);
	});
	sphere.on('nametag:registered', (e: any) => {
		console.log('━━ nametag:registered ━━', e);
	});
	sphere.on('nametag:recovered', (e: any) => {
		console.log('━━ nametag:recovered ━━', e);
	});
	sphere.on('sync:completed', (e: any) => {
		console.log('━━ sync:completed ━━', e);
	});
	sphere.on('sync:error', (e: any) => {
		console.log('━━ sync:error ━━', e);
	});
	sphere.on('connection:changed', (e: any) => {
		console.log('━━ connection:changed ━━', JSON.stringify(e));
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
