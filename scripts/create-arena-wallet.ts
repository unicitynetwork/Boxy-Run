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
 *     [--nametag=BoxyRunArena] [--network=mainnet] [--data-dir=./arena-data]
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

type NetworkType = 'mainnet' | 'testnet' | 'dev';

function parseArg(name: string, fallback: string): string {
	const prefix = `--${name}=`;
	for (const arg of process.argv.slice(2)) {
		if (arg.startsWith(prefix)) return arg.slice(prefix.length);
	}
	return fallback;
}

async function main() {
	const nametag = parseArg('nametag', 'boxyrunarena');
	const network = parseArg('network', 'mainnet') as NetworkType;
	const dataDir = resolve(parseArg('data-dir', './arena-data'));
	const outFile = resolve(parseArg('out', './arena-wallet.json'));
	const confirm = process.env.CONFIRM === 'yes';

	console.log('');
	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
	console.log('  Arena wallet creation');
	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
	console.log(`  Nametag:   @${nametag}`);
	console.log(`  Network:   ${network}`);
	console.log(`  Data dir:  ${dataDir}`);
	console.log(`  Output:    ${outFile}`);
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
	// SDK's default relay list (wss://relay.unicity.network) is stale / NXDOMAIN.
	// Use the relays that actually resolve.
	const mainnetRelays = [
		'wss://sphere-relay.unicity.network',
		'wss://relay.damus.io',
		'wss://nos.lol',
	];
	const testnetRelays = ['wss://nostr-relay.testnet.unicity.network'];
	const providers = createNodeProviders({
		network,
		dataDir,
		tokensDir: `${dataDir}/tokens`,
		transport: {
			relays: network === 'testnet' ? testnetRelays : mainnetRelays,
		},
	});

	console.log(`→ Creating wallet + registering @${nametag}… (this hits the chain, may take a minute)`);
	const sphere = await Sphere.create({
		mnemonic,
		nametag,
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
		l1Address: identity.l1Address,
		chainPubkey: (identity as any).chainPubkey ?? null,
		// The secret: anyone with this mnemonic controls every token in @BoxyRunArena.
		mnemonic,
	};

	writeFileSync(outFile, JSON.stringify(record, null, 2), { mode: 0o600 });

	console.log('');
	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
	console.log('  ✓ Wallet created');
	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
	console.log(`  Nametag:    @${nametag}`);
	console.log(`  L1 address: ${identity.l1Address}`);
	console.log(`  Saved to:   ${outFile}`);
	console.log('');
	console.log('IMPORTANT — NEXT STEPS:');
	console.log(`  1. Open ${outFile}, copy the mnemonic to a password manager / hardware`);
	console.log(`     backup. If you lose it, the tokens are gone.`);
	console.log(`  2. Delete ${outFile} once backed up:`);
	console.log(`       shred -u ${outFile}`);
	console.log(`     (Leaving it on disk means anyone with file access controls the wallet.)`);
	console.log(`  3. Set ARENA_WALLET=@${nametag} in your deployment env.`);
	console.log('');

	// Clean shutdown (closes Nostr relay sockets etc.)
	try { await (sphere as any).destroy?.(); } catch {}
	process.exit(0);
}

main().catch((err) => {
	console.error('✗ Fatal:', err?.stack || err?.message || err);
	process.exit(1);
});
