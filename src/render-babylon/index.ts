/**
 * Barrel export — matches the import surface of src/render/ so
 * main.ts can swap renderers by changing one import path.
 */

export { createScene, renderFrame, syncFog, type SceneHandle } from './scene';
export {
	createRenderState,
	addOpponentMesh,
	removeOpponentMesh,
	syncRender,
	syncOpponent,
	type RenderState,
} from './sync';
export { createCharacterMesh, syncCharacterMesh, type CharacterMesh } from './character-mesh';
export { emitCoinBurst, emitFlameBlast, emitNearMiss, createDustTrail } from './particles';

// Re-export shared modules that don't depend on the renderer
export { getSkin, getOpponentSkin, type CharacterSkin } from '../render/skins';
export {
	initAudio, resumeAudio,
	playBeep, playCoinCollect, playCrash, playFlameActivate,
	playGameStart, playJump, playLaneSwitch, playPowerupCollect,
} from '../render/audio';
export { updateHud } from '../render/hud';
export {
	showOverlay, hideOverlay,
	showDeathBanner, removeDeathBanner,
	installTouchControls,
	updateOpponentHud, removeOpponentHud,
} from '../game/ui';
