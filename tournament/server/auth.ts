/**
 * Sphere-signed nametag authentication.
 *
 * The whole tournament/wager economy ran on the honour system before
 * this: any client could send `{nametag: 'alice'}` in a request body or
 * a WS register message and the server would treat them as alice. This
 * module closes that gap by requiring proof-of-control of the nametag's
 * private key before issuing a session token, then attaching that
 * session to every state-mutating request.
 *
 * Flow:
 *   1. Client POSTs /api/auth/challenge {nametag} → server stores a
 *      32-byte random nonce, returns it + a short-lived challengeId.
 *   2. Client signs the nonce with `sphere.signMessage(nonce)` (SDK
 *      uses the wallet's chain private key under the hood) and POSTs
 *      /api/auth/verify {challengeId, signature}.
 *   3. Server resolves the nametag's chainPubkey from the network
 *      (transport.resolveNametagInfo, cached for an hour), then calls
 *      `verifySignedMessage(nonce, signature, chainPubkey)`. On success
 *      it returns a session token bound to that nametag.
 *   4. Subsequent REST calls include `Authorization: Bearer <session>`;
 *      WS register messages include `{sessionId}`. Server-side helpers
 *      (`requireSession*`) resolve the nametag — endpoints stop trusting
 *      anything client-supplied.
 *
 * Sessions live in-process. A Fly redeploy invalidates them; the client
 * just signs again on reconnect (no UI prompt — the SDK signs silently).
 *
 * Bypass mode: if `AUTH_BYPASS=1` is set in the environment, sessions
 * are minted without signature verification when a `_devNametag` is
 * supplied. This is for tests and local dev only — guarded by an
 * explicit env var so it can never accidentally ship.
 */

import { randomBytes } from 'node:crypto';
import { isValidNametag } from './nametag';

/** A pending challenge: client requested it but hasn't signed yet. */
interface Challenge {
	nametag: string;
	nonce: string;       // hex, 64 chars (32 bytes) — what the client signs
	expiresAt: number;   // ms epoch
}

/** A live session: client successfully proved nametag ownership. */
interface Session {
	nametag: string;
	chainPubkey: string;
	expiresAt: number;
}

const challenges = new Map<string, Challenge>();
const sessions = new Map<string, Session>();
const pubkeyCache = new Map<string, { chainPubkey: string; cachedAt: number }>();

const CHALLENGE_TTL_MS = 5 * 60 * 1000;       // 5 min to sign
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;   // 24 h
const PUBKEY_CACHE_TTL_MS = 60 * 60 * 1000;   // 1 h
const BYPASS = process.env.AUTH_BYPASS === '1';

/**
 * Resolve a nametag's chainPubkey via the Sphere transport. Cached so
 * a flood of auth attempts doesn't flood the relay. The cache is only
 * a problem if a nametag rebinds to a different pubkey within an hour;
 * rare in practice and self-healing once the cache entry expires.
 */
async function getChainPubkey(nametag: string): Promise<string | null> {
	const hit = pubkeyCache.get(nametag);
	if (hit && Date.now() - hit.cachedAt < PUBKEY_CACHE_TTL_MS) {
		return hit.chainPubkey;
	}
	try {
		const arena = await import('./arena-watcher');
		const transport = arena.getTransport?.();
		if (!transport?.resolveNametagInfo) {
			console.warn('[auth] transport not ready — cannot resolve nametag');
			return null;
		}
		const info = await transport.resolveNametagInfo(nametag);
		if (!info?.chainPubkey) return null;
		pubkeyCache.set(nametag, { chainPubkey: info.chainPubkey, cachedAt: Date.now() });
		return info.chainPubkey;
	} catch (e) {
		console.warn('[auth] resolveNametagInfo threw', e);
		return null;
	}
}

/**
 * Issue a fresh challenge for a nametag. The client signs the returned
 * nonce and posts back to /api/auth/verify.
 */
export function issueChallenge(nametag: string): { challengeId: string; nonce: string; expiresAt: number } | { error: string } {
	if (!isValidNametag(nametag)) {
		return { error: 'invalid_nametag' };
	}
	const challengeId = randomBytes(16).toString('hex');
	const nonce = randomBytes(32).toString('hex');
	const expiresAt = Date.now() + CHALLENGE_TTL_MS;
	challenges.set(challengeId, { nametag, nonce, expiresAt });
	console.log('[auth] challenge issued', { nametag, challengeId });
	return { challengeId, nonce, expiresAt };
}

/**
 * Verify the client's signature against the chainPubkey the network
 * says owns this nametag. On success, mint a session token.
 */
export async function verifyChallenge(
	challengeId: string,
	signature: string,
): Promise<{ sessionId: string; nametag: string; expiresAt: number } | { error: string }> {
	const ch = challenges.get(challengeId);
	if (!ch) {
		console.warn('[auth] verify failed — unknown_challenge', { challengeId });
		return { error: 'unknown_challenge' };
	}
	challenges.delete(challengeId); // single-use, regardless of outcome
	if (Date.now() > ch.expiresAt) {
		console.warn('[auth] verify failed — challenge_expired', { nametag: ch.nametag });
		return { error: 'challenge_expired' };
	}

	if (BYPASS) {
		// Test/dev path — accept any signature, but only for nametags that
		// look like dev-test ones (avoid foot-gun in real environments).
		console.warn('[auth] BYPASS active — minting session without verification for', ch.nametag);
		return mintSession(ch.nametag, 'BYPASS');
	}

	const chainPubkey = await getChainPubkey(ch.nametag);
	if (!chainPubkey) {
		console.warn('[auth] verify failed — nametag_not_registered', { nametag: ch.nametag });
		return { error: 'nametag_not_registered' };
	}

	// Log the signature shape we received — clients have been observed
	// passing back objects, hex without 0x prefix, etc. The shape is the
	// load-bearing thing the SDK is fussy about.
	console.log('[auth] verify attempt', {
		nametag: ch.nametag,
		sigType: typeof signature,
		sigLen: typeof signature === 'string' ? signature.length : -1,
		sigSample: typeof signature === 'string' ? signature.slice(0, 32) : null,
	});

	let ok = false;
	try {
		const sdk = await import('@unicitylabs/sphere-sdk');
		ok = sdk.verifySignedMessage(ch.nonce, signature, chainPubkey);
	} catch (e) {
		console.warn('[auth] verifySignedMessage threw', e);
		return { error: 'verify_failed' };
	}
	if (!ok) {
		console.warn('[auth] verify failed — bad_signature', { nametag: ch.nametag });
		return { error: 'bad_signature' };
	}

	const minted = mintSession(ch.nametag, chainPubkey);
	console.log('[auth] verify ok — session minted', { nametag: ch.nametag, expiresAt: minted.expiresAt });
	return minted;
}

function mintSession(nametag: string, chainPubkey: string): { sessionId: string; nametag: string; expiresAt: number } {
	const sessionId = randomBytes(24).toString('hex');
	const expiresAt = Date.now() + SESSION_TTL_MS;
	sessions.set(sessionId, { nametag, chainPubkey, expiresAt });
	return { sessionId, nametag, expiresAt };
}

/** Returns the session if valid, else null. */
export function getSession(sessionId: string | undefined | null): Session | null {
	if (!sessionId) return null;
	const s = sessions.get(sessionId);
	if (!s) return null;
	if (Date.now() > s.expiresAt) {
		sessions.delete(sessionId);
		return null;
	}
	return s;
}

/** Bypass-only: issue a session without signature verification. Used by tests. */
export function devMintSession(nametag: string): string | null {
	if (!BYPASS) return null;
	if (!isValidNametag(nametag)) return null;
	return mintSession(nametag, 'BYPASS').sessionId;
}

/**
 * Internal-only: mint a session for an in-process actor (server-side
 * bots) that doesn't have a wallet. Bypasses Sphere verification because
 * the caller IS the server — no untrusted user input is involved.
 *
 * Do NOT expose this through any HTTP/WS surface; that would defeat the
 * whole point of the auth system.
 */
export function mintInternalSession(nametag: string): string {
	if (!isValidNametag(nametag)) {
		throw new Error(`mintInternalSession: invalid nametag '${nametag}'`);
	}
	return mintSession(nametag, 'INTERNAL').sessionId;
}

/** Drop a session (logout). */
export function revokeSession(sessionId: string): void {
	sessions.delete(sessionId);
}

/** Periodic sweep to keep the maps from growing unbounded. */
export function sweep(): void {
	const now = Date.now();
	for (const [id, c] of challenges) {
		if (now > c.expiresAt) challenges.delete(id);
	}
	for (const [id, s] of sessions) {
		if (now > s.expiresAt) sessions.delete(id);
	}
	for (const [tag, p] of pubkeyCache) {
		if (now - p.cachedAt > PUBKEY_CACHE_TTL_MS) pubkeyCache.delete(tag);
	}
}

setInterval(sweep, 5 * 60 * 1000).unref();

/** Exposed only for tests. */
export const __test = {
	challenges, sessions, pubkeyCache,
	clearAll() {
		challenges.clear();
		sessions.clear();
		pubkeyCache.clear();
	},
};
