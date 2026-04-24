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
	powerupBox,
	treeBox,
} from './collision';
import { rngNext } from './rng';
import { maybeSpawnPowerup, spawnCoinRow, spawnTreeRow } from './spawn';
import type { GameConfig, GameState } from './state';
import { COIN_TIER_VALUES, TICK_SECONDS } from './state';

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
	if (state.gameOver || state.finished) return;

	// --- 1. Spawn a new tree row if the previous one has moved far
	// enough, or if the world is empty. Difficulty ticks up on spawn.
	// In level mode (maxRows set), stop spawning once the cap is hit.
	const spawnCapped = state.maxRows !== null && state.difficulty >= state.maxRows;
	let shouldSpawnNewRow = false;
	if (!spawnCapped) {
		if (state.trees.length === 0) {
			shouldSpawnNewRow = true;
		} else {
			const lastTree = state.trees[state.trees.length - 1];
			if (lastTree.z > state.lastTreeRowZ + config.spawnDistance) {
				shouldSpawnNewRow = true;
			}
		}
	}

	if (shouldSpawnNewRow) {
		state.difficulty += 1;

		// Level transitions: adjust tree density and max size.
		// In level mode (maxRows set), skip — the level's initial
		// values define the difficulty for the entire run.
		if (state.maxRows === null && state.difficulty % LEVEL_LENGTH === 0) {
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

		// Fog wave system — deterministic in/out cycle.
		// Consumes 1 RNG call per row unconditionally (determinism).
		// After row 60, fog follows a wave: clear → dense → hold → clear.
		// Wave period controlled by RNG (varies between 20-40 rows).
		const fogRoll = rngNext(state); // always consumed
		if (state.maxRows === null && state.difficulty >= 60) {
			// Wave cycle: period = 20-40 rows (~9-18 seconds)
			// Dense floor gets deeper as difficulty increases
			const fogMin = Math.max(6000, 20000 - state.difficulty * 50);
			const fogMax = 60000;
			// Use difficulty as the wave position within a cycle
			const cycle = 30; // rows per full wave
			const pos = state.difficulty % cycle;
			let t: number;
			if (pos < 10) {
				// Rows 0-9 of cycle: ramp IN (clear → dense)
				t = pos / 10; // 0 → 1
			} else if (pos < 14) {
				// Rows 10-13: HOLD at dense (4 rows ≈ 1.8 seconds)
				t = 1;
			} else {
				// Rows 14-29: ramp OUT (dense → clear)
				t = 1 - (pos - 14) / 16; // 1 → 0
			}
			// Smooth the ramp with ease-in-out
			const smooth = t * t * (3 - 2 * t);
			state.fogTarget = fogMax - (fogMax - fogMin) * smooth;
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
		// Maybe spawn flamethrower powerup
		maybeSpawnPowerup(state, config, NEW_ROW_SPAWN_Z + COIN_ROW_Z_OFFSET);

		// Scripted spawns — inject specific items at specific rows.
		// No RNG calls, so normal-mode replays are unaffected.
		for (let i = state.scriptedSpawns.length - 1; i >= 0; i--) {
			const s = state.scriptedSpawns[i];
			if (s.atRow === state.difficulty) {
				const z = NEW_ROW_SPAWN_Z + COIN_ROW_Z_OFFSET;
				if (s.type === 'coin') {
					state.coins.push({
						x: s.lane * config.laneWidth,
						y: 200, z,
						tier: s.tier || 'gold',
						collected: false,
					});
				} else if (s.type === 'powerup') {
					state.powerups.push({
						x: s.lane * config.laneWidth,
						y: 350, z,
						collected: false,
					});
				}
				state.scriptedSpawns.splice(i, 1);
			}
		}
	}

	// --- 1b. Smooth fog weather transitions.
	if (state.fogTarget !== state.fogDistance) {
		const diff = state.fogTarget - state.fogDistance;
		// Lerp at ~4% per tick — fog rolls in over ~25 ticks (~0.4s)
		state.fogDistance += diff * 0.08; // fast transition — fog snaps in/out
		if (Math.abs(diff) < 200) state.fogDistance = state.fogTarget;
	}

	// --- 2. Move all world objects toward the character.
	const moveDistance = config.moveSpeed * TICK_SECONDS;
	for (const tree of state.trees) {
		tree.z += moveDistance;
	}
	for (const coin of state.coins) {
		coin.z += moveDistance;
	}
	for (const p of state.powerups) {
		p.z += moveDistance;
	}

	// --- 3. Cull off-screen entities.
	state.trees = state.trees.filter((t) => t.z < 0);
	state.coins = state.coins.filter((c) => c.z < 0);
	state.powerups = state.powerups.filter((p) => p.z < 0);

	// --- 4. Character physics (jump / lane switch / bob).
	updateCharacter(state, config);

	// --- 5. Coin collection. Iterate in reverse so splicing is safe.
	state.lastCollectedTier = null;
	const charBox = characterBox(state.character);
	for (let i = state.coins.length - 1; i >= 0; i--) {
		const coin = state.coins[i];
		if (coin.collected) continue;
		if (aabbIntersect(charBox, coinBox(coin))) {
			coin.collected = true;
			state.coinCount += 1;
			state.score += COIN_TIER_VALUES[coin.tier] ?? config.coinScoreBonus;
			state.lastCollectedTier = coin.tier;
			if (coin.tier === 'gold') state.goldCollected++;
			else if (coin.tier === 'blue') state.blueCollected++;
			else if (coin.tier === 'red') state.redCollected++;
			state.coins.splice(i, 1);
		}
	}

	// --- 5b. Powerup collection.
	for (let i = state.powerups.length - 1; i >= 0; i--) {
		const p = state.powerups[i];
		if (p.collected) continue;
		if (aabbIntersect(charBox, powerupBox(p))) {
			p.collected = true;
			state.flamethrowerCharges++;
			state.powerups.splice(i, 1);
		}
	}

	// --- 5c. Flamethrower effect: burn the nearest trees ahead.
	if (state.flameTicks > 0) {
		state.flameTicks--;
		const charZ = state.character.z;
		// Burn range: only the next ~5000 units ahead (roughly one row)
		state.trees = state.trees.filter(t => {
			if (t.z < charZ && t.z > charZ - 5000) return false;
			return true;
		});
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

	// --- 8. Level finish detection: all rows spawned + world cleared.
	if (spawnCapped && state.trees.length === 0 && !state.gameOver) {
		state.finished = true;
	}
}
