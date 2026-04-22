/**
 * Renderer abstraction layer. main.ts imports from here.
 * Currently using Babylon.js.
 */

// ── Babylon.js renderer ─────────────────────────────────────────

export {
	createScene,
	renderFrame,
	type SceneHandle,
} from '../render-babylon/scene';

export {
	addOpponentMesh,
	createRenderState,
	removeOpponentMesh,
	syncOpponent,
	syncRender,
	type RenderState,
} from '../render-babylon/sync';
