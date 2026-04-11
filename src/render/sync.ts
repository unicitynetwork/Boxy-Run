/**
 * Top-level renderer handle and per-frame sync. Wires together the
 * character, tree, and coin meshes plus HUD and fog updates.
 *
 * Usage:
 *   const scene = createScene();
 *   const render = createRenderState(scene);
 *   // ...
 *   function frame() {
 *     tick(simState, config);
 *     syncRender(simState, render, scene, config);
 *     renderFrame(scene);
 *     requestAnimationFrame(frame);
 *   }
 */

import type { GameConfig, GameState } from '../sim/state';
import {
	createCharacterMesh,
	syncCharacterMesh,
	type CharacterMesh,
} from './character-mesh';
import {
	createCoinMeshPool,
	syncCoinMeshes,
	type CoinMeshPool,
} from './coin-mesh';
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
}

/** Create mesh pools for all entity types. Adds the character to the scene immediately. */
export function createRenderState(scene: SceneHandle): RenderState {
	return {
		character: createCharacterMesh(scene.scene),
		trees: createTreeMeshPool(scene.scene),
		coins: createCoinMeshPool(scene.scene),
	};
}

/**
 * One-frame sync: copy sim state to mesh state, update fog, update HUD.
 * Call once per rendered frame (typically inside requestAnimationFrame)
 * after any pending tick() calls have advanced the sim.
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
