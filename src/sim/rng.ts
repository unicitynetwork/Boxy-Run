/**
 * Deterministic mulberry32 PRNG. The state is a single 32-bit integer
 * carried explicitly on whatever object owns it — in practice, GameState.
 *
 * Making the state an explicit field (rather than a closure) lets us
 * snapshot and restore the RNG as part of GameState, which is essential
 * for replay tests and tournament-mode hash agreement: two clients that
 * start from the same seed and apply the same inputs must converge on
 * bit-identical rng state.
 *
 * This file intentionally avoids a factory-with-closure API. The narrow
 * `HasRngState` interface exists so `rngNext` doesn't need to import
 * the full GameState type — avoiding a circular import between state.ts
 * and rng.ts. Any object with a mutable `rngState: number` field works.
 */

export interface HasRngState {
	rngState: number;
}

/**
 * Seed a GameState-shaped object's rngState field from a 32-bit integer.
 * Equivalent to the initial `state = seed >>> 0` in a closure-based API.
 */
export function seedRng(target: HasRngState, seed: number): void {
	target.rngState = seed >>> 0;
}

/**
 * Advance the RNG by one step and return a float in [0, 1).
 * Mutates `target.rngState` in place.
 *
 * Bit-exact port of the closure-based mulberry32 previously in game.js.
 * Must stay bit-identical to that implementation, or matches played
 * across the old and new sim will produce diverging hashes.
 */
export function rngNext(target: HasRngState): number {
	target.rngState = (target.rngState + 0x6d2b79f5) >>> 0;
	let t = target.rngState;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
