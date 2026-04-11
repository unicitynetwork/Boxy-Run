/**
 * Main sim update. One call = one 1/60-second advance of game state.
 * Mutates state in place. Pure — no Three.js, no DOM, no side effects
 * outside the state parameter.
 *
 * The sequence, ordering, and RNG-call pattern are load-bearing: they
 * must match the Phase-0 game.js tick() exactly so that a run produced
 * by the old code and a run produced by the new sim (same seed, same
 * inputs) yield bit-identical state. Changing any part of this will
 * invalidate every recorded (seed, inputs) replay.
 */

import { updateCharacter } from './character';
import {
	aabbIntersect,
	characterBox,
	coinBox,
	treeBox,
} from './collision';
import { rngNext } from './rng';
import { spawnCoinRow, spawnTreeRow } from './spawn';
import type { GameConfig, GameState } from './state';
import { TICK_SECONDS } from './state';

/** Number of difficulty increments per "level". */
const LEVEL_LENGTH = 30;
/** Z position at which new tree rows are spawned (far ahead of character). */
const NEW_ROW_SPAWN_Z = -120000;
/** Offset from tree row at which the coin row spawns. */
const COIN_ROW_Z_OFFSET = 1500;

/**
 * Advance the simulation by one tick. No-op if state.gameOver is
 * already true. Call once per 1/60 second of game time.
 */
export function tick(state: GameState, config: GameConfig): void {
	if (state.gameOver) return;

	// --- 1. Spawn a new tree row if the previous one has moved far
	// enough, or if the world is empty. Difficulty ticks up on spawn.
	let shouldSpawnNewRow = false;
	if (state.trees.length === 0) {
		shouldSpawnNewRow = true;
	} else {
		const lastTree = state.trees[state.trees.length - 1];
		if (lastTree.z > state.lastTreeRowZ + config.spawnDistance) {
			shouldSpawnNewRow = true;
		}
	}

	if (shouldSpawnNewRow) {
		state.difficulty += 1;

		// Level transitions: adjust tree density and max size. Ported
		// verbatim from the original level progression.
		if (state.difficulty % LEVEL_LENGTH === 0) {
			const level = state.difficulty / LEVEL_LENGTH;
			switch (level) {
				case 1:
					state.treePresenceProb = 0.35;
					state.maxTreeSize = 0.5;
					break;
				case 2:
					state.treePresenceProb = 0.35;
					state.maxTreeSize = 0.85;
					break;
				case 3:
					state.treePresenceProb = 0.5;
					state.maxTreeSize = 0.85;
					break;
				case 4:
					state.treePresenceProb = 0.5;
					state.maxTreeSize = 1.1;
					break;
				case 5:
					state.treePresenceProb = 0.5;
					state.maxTreeSize = 1.1;
					break;
				case 6:
					state.treePresenceProb = 0.55;
					state.maxTreeSize = 1.1;
					break;
				default:
					state.treePresenceProb = 0.55;
					state.maxTreeSize = 1.25;
			}
		}

		// Fog closes in during levels 5 and 8 of difficulty.
		if (
			state.difficulty >= 5 * LEVEL_LENGTH &&
			state.difficulty < 6 * LEVEL_LENGTH
		) {
			state.fogDistance -= 15000 / LEVEL_LENGTH;
		} else if (
			state.difficulty >= 8 * LEVEL_LENGTH &&
			state.difficulty < 9 * LEVEL_LENGTH
		) {
			state.fogDistance -= 3000 / LEVEL_LENGTH;
		}

		spawnTreeRow(
			state,
			config,
			NEW_ROW_SPAWN_Z,
			state.treePresenceProb,
			0.5,
			state.maxTreeSize,
		);
		state.lastTreeRowZ = NEW_ROW_SPAWN_Z;

		// Coin rows spawn on ~half of tree rows. The single rngNext
		// call before spawnCoinRow must stay on this branch unconditionally
		// or downstream rng consumers will desync.
		if (rngNext(state) < 0.5) {
			spawnCoinRow(
				state,
				config,
				NEW_ROW_SPAWN_Z + COIN_ROW_Z_OFFSET,
				0.2,
			);
		}
	}

	// --- 2. Move all world objects toward the character.
	const moveDistance = config.moveSpeed * TICK_SECONDS;
	for (const tree of state.trees) {
		tree.z += moveDistance;
	}
	for (const coin of state.coins) {
		coin.z += moveDistance;
	}

	// --- 3. Cull off-screen entities. Both arrays are re-assigned
	// because splice-in-place would change indices mid-loop.
	state.trees = state.trees.filter((t) => t.z < 0);
	state.coins = state.coins.filter((c) => c.z < 0);

	// --- 4. Character physics (jump / lane switch / bob).
	updateCharacter(state, config);

	// --- 5. Coin collection. Iterate in reverse so splicing is safe.
	const charBox = characterBox(state.character);
	for (let i = state.coins.length - 1; i >= 0; i--) {
		const coin = state.coins[i];
		if (coin.collected) continue;
		if (aabbIntersect(charBox, coinBox(coin))) {
			coin.collected = true;
			state.coinCount += 1;
			state.coins.splice(i, 1);
		}
	}

	// --- 6. Tree collision. Set gameOver on first hit but still fall
	// through to the score/tick increment below, matching the behaviour
	// of the Phase-0 game.js where score updates lived outside the
	// collision branch.
	for (const tree of state.trees) {
		if (aabbIntersect(charBox, treeBox(tree))) {
			state.gameOver = true;
			break;
		}
	}

	// --- 7. Advance score and tick counter.
	state.score += config.scorePerTick;
	state.tick += 1;
}
