/**
 * Build a fresh GameState from a seed. Mirrors the init sequence in the
 * original game.js: 30 pre-populated tree rows at 3000-unit intervals
 * ahead of the character, with coins on every other row.
 */

import { DEFAULT_CONFIG, type GameConfig, type GameState } from './state';
import { seedRng } from './rng';
import { spawnCoinRow, spawnTreeRow } from './spawn';

/** Fixed depth position of the character throughout a run. */
const CHARACTER_Z = -4000;

/** Initial difficulty parameters, copied from the original init(). */
const INITIAL_TREE_PROB = 0.2;
const INITIAL_MAX_TREE_SIZE = 0.5;
const INITIAL_FOG_DISTANCE = 60000;

/**
 * Construct a deterministic initial state. Both clients of a tournament
 * match must call this with the same `seed` and `config` or their hashes
 * will diverge immediately. `config` defaults to DEFAULT_CONFIG; passing
 * a custom config is primarily useful for tests (e.g., faster moveSpeed
 * for quicker replays).
 */
export function makeInitialState(
	seed: number,
	config: GameConfig = DEFAULT_CONFIG,
): GameState {
	const state: GameState = {
		seed: seed >>> 0,
		rngState: 0, // seeded below by seedRng
		tick: 0,
		score: 0,
		coinCount: 0,
		gameOver: false,
		difficulty: 0,
		treePresenceProb: INITIAL_TREE_PROB,
		maxTreeSize: INITIAL_MAX_TREE_SIZE,
		fogDistance: INITIAL_FOG_DISTANCE,
		lastTreeRowZ: -120000,
		trees: [],
		coins: [],
		character: {
			x: 0,
			y: 0,
			z: CHARACTER_Z,
			isJumping: false,
			isSwitchingLeft: false,
			isSwitchingRight: false,
			currentLane: 0,
			runningStartTick: 0,
			jumpStartTick: 0,
			queuedActions: [],
		},
	};

	seedRng(state, state.seed);

	// Pre-populate 30 tree rows (i = 10..39) with coins on every other
	// row. Z positions match the original init loop exactly, including
	// the +1500 coin offset.
	for (let i = 10; i < 40; i++) {
		spawnTreeRow(
			state,
			config,
			i * -3000,
			state.treePresenceProb,
			0.5,
			state.maxTreeSize,
		);
		if (i % 2 === 0) {
			spawnCoinRow(state, config, i * -3000 + 1500, 0.3);
		}
	}

	return state;
}
