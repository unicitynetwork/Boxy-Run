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
	makeGhostly,
	syncCharacterMesh,
	type CharacterMesh,
} from './character-mesh';
import { Colors } from './colors';
import {
	createCoinMeshPool,
	syncCoinMeshes,
	type CoinMeshPool,
} from './coin-mesh';
import { updateHud } from './hud';
import { syncFog, type SceneHandle } from './scene';
import { type CharacterSkin, getOpponentSkin, SKINS } from './skins';
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
	playerSkin: CharacterSkin;
}

/**
 * Create mesh pools for all entity types. The player's skin determines
 * their character's appearance and (by contrast) the opponent's.
 */
export function createRenderState(
	scene: SceneHandle,
	playerSkin: CharacterSkin = SKINS[0],
	tournament = false,
): RenderState {
	const shirtHex = '#' + (playerSkin.colors.shirt ?? Colors.yellow).toString(16).padStart(6, '0');
	return {
		character: createCharacterMesh(
			scene.scene,
			playerSkin.colors,
			tournament ? 'YOU' : undefined,
			tournament ? shirtHex : undefined,
		),
		trees: createTreeMeshPool(scene.scene),
		coins: createCoinMeshPool(scene.scene),
		opponent: null,
		playerSkin,
	};
}

/**
 * Add an opponent character mesh to the scene. The opponent's skin
 * auto-contrasts with the player's selection. Labeled "OPP" in
 * the opponent's shirt color.
 */
export function addOpponentMesh(render: RenderState, scene: SceneHandle): void {
	if (render.opponent) return;
	const oppSkin = getOpponentSkin(render.playerSkin);
	const oppShirtHex = '#' + (oppSkin.colors.shirt ?? Colors.cherry).toString(16).padStart(6, '0');
	render.opponent = createCharacterMesh(scene.scene, oppSkin.colors, 'OPP', oppShirtHex);
	makeGhostly(render.opponent);
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
