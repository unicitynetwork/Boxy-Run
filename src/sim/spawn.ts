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

import type { GameConfig, GameState } from './state';
import { rngNext } from './rng';

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
			state.coins.push({
				x: lane * config.laneWidth,
				y: COIN_Y,
				z,
				collected: false,
			});
		}
	}
}
