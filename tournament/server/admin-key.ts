/**
 * Single source of truth for the admin key.
 *
 * Previously every callsite had its own `process.env.ADMIN_KEY ||
 * 'boxyrun-admin-2024'` fallback — meaning a deployment that forgot to
 * set the env var was protected by a key that was literally in the
 * public source. Anyone with curl could pay out prizes, mint UCT,
 * wipe leaderboards.
 *
 * This module now insists `ADMIN_KEY` be set at boot. The boot path
 * crashes loudly if it isn't; better an obvious deploy failure than a
 * silent backdoor. For local dev / tests, set `ADMIN_KEY=dev-...` in
 * the env or use the existing `TEST_ADMIN_KEY` constant in the test
 * harness (which sets the env before booting the server).
 */

const ADMIN_KEY = process.env.ADMIN_KEY;
if (!ADMIN_KEY || ADMIN_KEY.length < 16) {
	console.error(
		'[admin-key] FATAL: ADMIN_KEY env var must be set to a string of ' +
		'at least 16 characters. Refusing to boot with default fallback.',
	);
	process.exit(1);
}

export function getAdminKey(): string {
	return ADMIN_KEY!;
}

export function isAdminRequest(req: { headers: Record<string, string | string[] | undefined> }): boolean {
	const supplied = req.headers['x-admin-key'];
	if (typeof supplied !== 'string') return false;
	// Constant-time comparison to defeat timing attacks. For a 16-char
	// key the timing channel is tiny, but free.
	return constantTimeEqual(supplied, ADMIN_KEY!);
}

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}
