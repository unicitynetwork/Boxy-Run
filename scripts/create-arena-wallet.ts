/**
 * One-shot script to create the @BoxyRunArena wallet on Unicity.
 *
 * What it does:
 *   1. Generates a BIP-39 mnemonic (the wallet's root secret).
 *   2. Boots Node.js Sphere providers against the configured network.
 *   3. Calls Sphere.create() which registers the nametag on-chain.
 *   4. Writes credentials to arena-wallet.json (gitignored).
 *
 * CRITICAL: The mnemonic in arena-wallet.json is the root secret for
 * every UCT the game holds. Back it up offline and delete the file
 * once backed up. Do NOT commit it.
 *
 * Usage:
 *   CONFIRM=yes npx tsx scripts/create-arena-wallet.ts
 *     [--nametag=BoxyRunArena] [--network=testnet2] [--data-dir=./arena-data]
 *     [--wallet-api=https://wallet-api.unicity.network]
 *
 * Env: WALLET_API_URL, AGGREGATOR_API_KEY (both have defaults, see below).
 *
 * Without CONFIRM=yes, the script prints the plan and exits without
 * touching the chain. This is a dry-run by default.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { webcrypto } from 'node:crypto';

// Polyfill globals the SDK expects (it was authored for browsers).
// `crypto` (Web Crypto) is the bigger one — without it, key derivation
// inside Sphere.create / registerNametag throws "crypto is not defined".
if (typeof (globalThis as any).crypto === 'undefined') {
	(globalThis as any).crypto = webcrypto;
}
// `WebSocket` lands in Node 22 natively but is missing on 20.
if (typeof (globalThis as any).WebSocket === 'undefined') {
	(globalThis as any).WebSocket = require('ws');
}

import { Sphere, generateMnemonic } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

// mainnet/dev ship no embedded trust base and are refused at provider creation.
type NetworkType = 'testnet' | 'testnet2';

// See tournament/server/arena-watcher.ts for why these three must agree and why
// the network string has to be the backend's exact name, not an alias.
const DEFAULT_WALLET_API_URL = 'https://wallet-api.unicity.network';
const DEFAULT_AGGREGATOR_API_KEY = 'sk_ddc3cfcc001e4a28ac3fad7407f99590';

function parseArg(name: string, fallback: string): string {
	const prefix = `--${name}=`;
	for (const arg of process.argv.slice(2)) {
		if (arg.startsWith(prefix)) return arg.slice(prefix.length);
	}
	return fallback;
}

async function main() {
	const nametag = parseArg('nametag', 'boxyrunarena');
	// 'testnet2' is the name the deployed wallet-api backends put in the auth
	// challenge; the SDK verifies ours against it, so the alias 'testnet' fails
	// sign-in even though it resolves to the same gateway everywhere else.
	const network = parseArg('network', 'testnet2') as NetworkType;
	const dataDir = resolve(parseArg('data-dir', './arena-data'));
	const outFile = resolve(parseArg('out', './arena-wallet.json'));
	const walletApiUrl = parseArg('wallet-api', process.env.WALLET_API_URL || DEFAULT_WALLET_API_URL);
	const aggregatorApiKey = process.env.AGGREGATOR_API_KEY || DEFAULT_AGGREGATOR_API_KEY;
	const confirm = process.env.CONFIRM === 'yes';

	console.log('');
	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
	console.log('  Arena wallet creation');
	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
	console.log(`  Nametag:    @${nametag}`);
	console.log(`  Network:    ${network}`);
	console.log(`  wallet-api: ${walletApiUrl}`);
	console.log(`  Data dir:   ${dataDir}`);
	console.log(`  Output:     ${outFile}`);
	console.log('');

	if (existsSync(outFile)) {
		console.error(`✗ ${outFile} already exists. Refusing to overwrite.`);
		console.error(`  If you truly want a new wallet, move the old file first:`);
		console.error(`    mv ${outFile} ${outFile}.bak`);
		process.exit(2);
	}

	if (!confirm) {
		console.log('DRY RUN. Set CONFIRM=yes to actually create the wallet on-chain.');
		console.log('');
		console.log('Example:');
		console.log(`  CONFIRM=yes npx tsx scripts/create-arena-wallet.ts`);
		console.log('');
		console.log('This will:');
		console.log(`  • Generate a new 24-word BIP-39 mnemonic`);
		console.log(`  • Register @${nametag} on Unicity ${network}`);
		console.log(`  • Write the mnemonic + address to ${outFile}`);
		console.log('');
		process.exit(0);
	}

	if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

	console.log('→ Generating mnemonic…');
	const mnemonic = generateMnemonic(256); // 24 words
	console.log(`  (${mnemonic.split(' ').length} words generated)`);

	console.log(`→ Initializing ${network} providers…`);
	// Only the Unicity-operated relay: public relays returning 5xx can hang the
	// boot, because the SDK awaits every transport handshake.
	const testnetRelays = ['wss://nostr-relay.testnet.unicity.network'];
	// `tokensDir` is gone — token custody is the wallet-api backend now. The
	// oracle apiKey has no bundled default and the token engine needs it.
	const base = createNodeProviders({
		network,
		dataDir,
		oracle: { apiKey: aggregatorApiKey },
		transport: { relays: testnetRelays },
	});
	// Sphere.create is fail-closed without a wallet-api composition: it throws
	// INVALID_CONFIG before writing anything. The wallet must be created against
	// the SAME backend the watcher will later read its mailbox from.
	const providers = createWalletApiProviders(base, {
		baseUrl: walletApiUrl,
		network,
		deviceId: `boxyrun-arena-create-${network}`,
	});

	console.log(`→ Creating wallet + registering @${nametag}… (this hits the chain, may take a minute)`);
	const sphere = await Sphere.create({
		mnemonic,
		nametag,
		network,
		...providers,
	});

	const identity = sphere.identity;
	if (!identity) {
		console.error('✗ Sphere.create succeeded but no identity returned');
		process.exit(3);
	}

	const record = {
		createdAt: new Date().toISOString(),
		network,
		nametag: `@${nametag}`,
		// The L3 DIRECT address is the on-chain address (the L1 layer left
		// Identity in the v2 engine cutover). Informational only — the watcher
		// re-derives identity from the mnemonic, it never reads this field back.
		directAddress: identity.directAddress ?? null,
		chainPubkey: identity.chainPubkey,
		// The secret: anyone with this mnemonic controls every token in @BoxyRunArena.
		mnemonic,
	};

	writeFileSync(outFile, JSON.stringify(record, null, 2), { mode: 0o600 });

	console.log('');
	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
	console.log('  ✓ Wallet created');
	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
	console.log(`  Nametag:        @${nametag}`);
	console.log(`  Direct address: ${identity.directAddress ?? '(none)'}`);
	console.log(`  Saved to:       ${outFile}`);
	console.log('');
	console.log('IMPORTANT — NEXT STEPS:');
	console.log(`  1. Open ${outFile}, copy the mnemonic to a password manager / hardware`);
	console.log(`     backup. If you lose it, the tokens are gone.`);
	console.log(`  2. Delete ${outFile} once backed up:`);
	console.log(`       shred -u ${outFile}`);
	console.log(`     (Leaving it on disk means anyone with file access controls the wallet.)`);
	console.log(`  3. Set ARENA_WALLET=@${nametag} in your deployment env.`);
	console.log(`  4. Point the watcher at the SAME backend: WALLET_API_URL=${walletApiUrl}`);
	console.log(`     and the same network: SPHERE_NETWORK=${network}`);
	console.log('');

	// Clean shutdown (closes Nostr relay sockets etc.)
	try { await (sphere as any).destroy?.(); } catch {}
	process.exit(0);
}

main().catch((err) => {
	console.error('✗ Fatal:', err?.stack || err?.message || err);
	process.exit(1);
});
