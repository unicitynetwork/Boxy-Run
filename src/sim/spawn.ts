/**
 * Tree and coin row spawning. Pure state mutation — each call consumes
 * some RNG state and pushes zero or more entities onto the state arrays.
 *
 * Used by init.ts (to pre-populate the world at game start) and tick.ts
 * (to spawn new rows as old ones move off-screen). Both entry points
 * must share the same helpers so the pre-populated and runtime-spawned
 * rows are generated identically — otherwise replays with the same seed
 * would diverge between init and later ticks.
 */

import type { CoinTier, GameConfig, GameState } from './state';
import { rngNext } from './rng';

/** Vertical position of a powerup's center. Slightly higher than coins. */
const POWERUP_Y = 350;

/** Vertical position of a tree's base. Hardcoded in the original game. */
const TREE_Y = -400;
/** Vertical position of a coin's center. Hardcoded in the original game. */
const COIN_Y = 200;

/**
 * Spawn a row of trees at the given z. Each of the three lanes
 * independently rolls for tree presence and (if present) a random
 * scale in [minScale, maxScale].
 *
 * Consumes 1 rng() call per lane unconditionally, plus 1 extra per
 * lane that spawned a tree. This per-lane call pattern is load-bearing
 * for determinism — any change breaks existing (seed, inputs) replays.
 */
export function spawnTreeRow(
	state: GameState,
	config: GameConfig,
	z: number,
	probability: number,
	minScale: number,
	maxScale: number,
): void {
	for (let lane = -1; lane <= 1; lane++) {
		if (rngNext(state) < probability) {
			const scale = minScale + (maxScale - minScale) * rngNext(state);
			state.trees.push({
				x: lane * config.laneWidth,
				y: TREE_Y,
				z,
				scale,
			});
		}
	}
}

/**
 * Spawn a row of coins at the given z. Same per-lane structure as
 * trees: 1 rng() call per lane, unconditional.
 */
export function spawnCoinRow(
	state: GameState,
	config: GameConfig,
	z: number,
	probability: number,
): void {
	for (let lane = -1; lane <= 1; lane++) {
		if (rngNext(state) < probability) {
			// Tier roll: 80% gold, 15% blue, 5% red
			const tierRoll = rngNext(state);
			const tier: CoinTier = tierRoll < 0.05 ? 'red' : tierRoll < 0.20 ? 'blue' : 'gold';
			state.coins.push({
				x: lane * config.laneWidth,
				y: COIN_Y,
				z,
				tier,
				collected: false,
			});
		}
	}
}

/**
 * Maybe spawn a flamethrower powerup at the given z.
 * Consumes 2 rng calls unconditionally for determinism.
 */
export function maybeSpawnPowerup(
	state: GameState,
	config: GameConfig,
	z: number,
): void {
	const roll = rngNext(state);
	const lane = Math.floor(rngNext(state) * 3) - 1; // -1, 0, or 1
	// ~3% chance per eligible spawn point
	if (roll < 0.03) {
		state.powerups.push({
			x: (lane as -1 | 0 | 1) * config.laneWidth,
			y: POWERUP_Y,
			z,
			collected: false,
		});
	}
}
