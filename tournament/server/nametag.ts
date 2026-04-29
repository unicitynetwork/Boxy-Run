/**
 * Nametag validation. Sphere doesn't strictly enforce a syntax in our
 * stored data, so we apply our own to keep impersonation surface low
 * (no whitespace, no HTML chars, length-bounded so logs and UI don't
 * get hijacked by clever names).
 *
 * Mirrors common Sphere conventions: lowercase letters, digits, dot,
 * underscore, hyphen. 1–32 chars. Strip a leading `@` if present.
 */
export function normalizeNametag(input: unknown): string {
	if (typeof input !== 'string') return '';
	let s = input.trim().toLowerCase();
	if (s.startsWith('@')) s = s.slice(1);
	return s;
}

const NAMETAG_RE = /^[a-z0-9._-]{1,32}$/;

export function isValidNametag(s: string): boolean {
	return typeof s === 'string' && NAMETAG_RE.test(s);
}
