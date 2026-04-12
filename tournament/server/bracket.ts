/**
 * Pure single-elimination bracket generation. Given a list of player
 * nametags and a deterministic seed, produce a rounds[][] structure
 * matching the BracketSlot wire shape.
 *
 * Handles non-power-of-2 player counts by padding with nulls in round
 * 1; a match with a null opponent is treated as a bye (the non-null
 * player auto-advances). All subsequent rounds are initially filled
 * with null/null slots that will be populated as matches resolve.
 *
 * Determinism: shuffling uses a local mulberry32 instance seeded from
 * the tournamentId hash so that replaying the same tournament produces
 * the same bracket. No external dependencies.
 */

import type { BracketSlot } from '../protocol/messages';

/** Local mulberry32 — a 6-line PRNG to avoid cross-package deps. */
function mulberry32(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** 32-bit FNV-1a hash of a string. Good enough for bracket seeding. */
export function hashString(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** Fisher-Yates shuffle of the input array using the given RNG. */
function shuffle<T>(items: T[], rng: () => number): T[] {
	const out = items.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/** Returns the smallest power of 2 greater than or equal to n (n >= 1). */
export function nextPowerOfTwo(n: number): number {
	if (n < 1) return 1;
	let p = 1;
	while (p < n) p *= 2;
	return p;
}

/**
 * Generate a single-elimination bracket. Round 0 is the first round;
 * the final is at index rounds.length - 1. Each round halves the
 * number of slots, so rounds.length = log2(nextPowerOfTwo(players.length)).
 *
 * Byes are represented by a match where one of the players is null.
 * The server is expected to auto-resolve such matches at bracket-
 * generation time (advance the non-null player to the next round
 * slot without going through the live-match state machine).
 */
export function generateBracket(
	players: string[],
	tournamentId: string,
): BracketSlot[][] {
	if (players.length < 2) {
		throw new Error(`generateBracket: need at least 2 players, got ${players.length}`);
	}

	const rng = mulberry32(hashString(tournamentId));
	const shuffled = shuffle(players, rng);

	const n = shuffled.length;
	const size = nextPowerOfTwo(n);
	const byeCount = size - n;

	// Round 0 layout:
	//   - First `byeCount` slots are (realPlayer, null) bye matches.
	//     This guarantees we never produce a (null, null) match, which
	//     would be degenerate. Simple deterministic placement; real
	//     seeding would distribute byes to top seeds, but our random
	//     shuffle already has no notion of seeding.
	//   - Remaining slots pair up the leftover real players.
	const rounds: BracketSlot[][] = [];
	const round0: BracketSlot[] = [];
	for (let i = 0; i < byeCount; i++) {
		round0.push({
			matchId: `R0M${round0.length}`,
			playerA: shuffled[i],
			playerB: null,
		});
	}
	for (let i = byeCount; i < n; i += 2) {
		round0.push({
			matchId: `R0M${round0.length}`,
			playerA: shuffled[i],
			playerB: shuffled[i + 1],
		});
	}
	rounds.push(round0);

	// Subsequent rounds: TBD slots, halving each round until 1 match remains.
	let matchesInRound = round0.length / 2;
	let roundIdx = 1;
	while (matchesInRound >= 1) {
		const round: BracketSlot[] = [];
		for (let i = 0; i < matchesInRound; i++) {
			round.push({
				matchId: `R${roundIdx}M${i}`,
				playerA: null,
				playerB: null,
			});
		}
		rounds.push(round);
		if (matchesInRound === 1) break;
		matchesInRound /= 2;
		roundIdx++;
	}

	return rounds;
}
