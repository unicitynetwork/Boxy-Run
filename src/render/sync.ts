/**
 * Top-level renderer handle and per-frame sync. Wires together the
 * character, tree, and coin meshes plus HUD and fog updates.
 *
 * Supports an optional opponent character mesh for tournament mode.
 * When present, the opponent is rendered from a second GameState
 * running in lockstep with the player's own sim.
 */

import type { GameConfig, GameState } from '../sim/state';
import {
	createCharacterMesh,
	syncCharacterMesh,
	type CharacterColors,
	type CharacterMesh,
} from './character-mesh';
import {
	createCoinMeshPool,
	syncCoinMeshes,
	type CoinMeshPool,
} from './coin-mesh';
import { Colors } from './colors';
import { updateHud } from './hud';
import { syncFog, type SceneHandle } from './scene';
import {
	createTreeMeshPool,
	syncTreeMeshes,
	type TreeMeshPool,
} from './tree-mesh';

/** Owns all per-entity mesh state. Created once per game. */
export interface RenderState {
	readonly character: CharacterMesh;
	readonly trees: TreeMeshPool;
	readonly coins: CoinMeshPool;
	opponent: CharacterMesh | null;
}

/** Create mesh pools for all entity types. Adds the character to the scene immediately. */
export function createRenderState(scene: SceneHandle): RenderState {
	return {
		character: createCharacterMesh(scene.scene),
		trees: createTreeMeshPool(scene.scene),
		coins: createCoinMeshPool(scene.scene),
		opponent: null,
	};
}

/** Opponent character colors — cherry red shirt, blue shorts. */
const OPPONENT_COLORS: CharacterColors = {
	skin: Colors.peach,
	hair: Colors.black,
	shirt: Colors.cherry,
	shorts: Colors.blue,
};

/**
 * Add an opponent character mesh to the scene. Call once when a
 * tournament match starts.
 */
export function addOpponentMesh(render: RenderState, scene: SceneHandle): void {
	if (render.opponent) return;
	render.opponent = createCharacterMesh(scene.scene, OPPONENT_COLORS);
}

/**
 * Remove the opponent character mesh from the scene. Call when the
 * match ends or when returning to single-player.
 */
export function removeOpponentMesh(render: RenderState, scene: SceneHandle): void {
	if (!render.opponent) return;
	scene.scene.remove(render.opponent.root);
	render.opponent = null;
}

/**
 * One-frame sync: copy sim state to mesh state, update fog, update HUD.
 * Call once per rendered frame after any pending tick() calls.
 */
export function syncRender(
	state: GameState,
	render: RenderState,
	scene: SceneHandle,
	config: GameConfig,
): void {
	syncCharacterMesh(render.character, state, config);
	syncTreeMeshes(render.trees, state.trees);
	syncCoinMeshes(render.coins, state.coins, state.tick);
	syncFog(scene, state.fogDistance);
	updateHud(state);
}

/**
 * Sync the opponent character mesh from the opponent's GameState.
 * Only updates position + limb animation; world meshes (trees/coins)
 * are shared from the player's sim since both sims produce the same
 * world from the same seed.
 */
export function syncOpponent(
	opponentState: GameState,
	render: RenderState,
	config: GameConfig,
): void {
	if (!render.opponent) return;
	syncCharacterMesh(render.opponent, opponentState, config);
}
