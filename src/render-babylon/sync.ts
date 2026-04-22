/**
 * Top-level render sync — ties game state to Babylon.js meshes,
 * particles, camera dynamics, and lighting effects.
 */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { ParticleSystem } from '@babylonjs/core/Particles/particleSystem';
import {
	createCharacterMesh,
	syncCharacterMesh,
	makeGhostly,
	type CharacterMesh,
} from './character-mesh';
import {
	createTreeMeshPool,
	syncTreeMeshes,
	type TreeMeshPool,
} from './tree-mesh';
import {
	createCoinMeshPool,
	syncCoinMeshes,
	type CoinMeshPool,
} from './coin-mesh';
import {
	createPowerupMeshPool,
	syncPowerupMeshes,
	type PowerupMeshPool,
} from './powerup-mesh';
import {
	createDustTrail,
	emitCoinBurst,
	emitFlameBlast,
} from './particles';
import { syncFog, type SceneHandle } from './scene';
import { updateHud } from '../render/hud';
import { startAmbientMusic, setMusicIntensity, stopAmbientMusic, createMusicToggle, isMusicMuted } from '../render/ambient-music';
import type { GameConfig, GameState } from '../sim/state';
import type { CharacterSkin } from '../render/skins';

export interface RenderState {
	character: CharacterMesh;
	trees: TreeMeshPool;
	coins: CoinMeshPool;
	powerups: PowerupMeshPool;
	opponent: CharacterMesh | null;
	playerSkin: CharacterSkin;
	// Particles
	dustTrail: ParticleSystem | null;
	// Camera tracking
	prevLane: number;
	cameraRollTarget: number;
	cameraRoll: number;
	cameraBobPhase: number;
	// Previous state for detecting events
	prevCoinCount: number;
	prevFlameTicks: number;
	musicStarted: boolean;
	// Scene handle ref for particles
	sceneHandle: SceneHandle;
}

export function createRenderState(
	handle: SceneHandle,
	playerSkin: CharacterSkin,
): RenderState {
	const character = createCharacterMesh(
		handle.scene,
		handle.shadowGenerator,
		playerSkin.colors,
	);
	const trees = createTreeMeshPool(handle.scene, handle.shadowGenerator);
	const coins = createCoinMeshPool(handle.scene);
	const powerups = createPowerupMeshPool(handle.scene);

	// Dust trail behind character
	const dustTrail = createDustTrail(handle.scene, character.root);

	return {
		character, trees, coins, powerups,
		opponent: null, playerSkin,
		dustTrail,
		prevLane: 0, cameraRollTarget: 0, cameraRoll: 0, cameraBobPhase: 0,
		prevCoinCount: 0, prevFlameTicks: 0, musicStarted: false,
		sceneHandle: handle,
	};
}

export function addOpponentMesh(
	render: RenderState,
	handle: SceneHandle,
): void {
	if (render.opponent) return;
	const oppColors = render.playerSkin.name === 'Crimson'
		? { skin: 0x59332e, hair: 0x000000, shirt: 0xffff00, shorts: 0x556b2f }
		: { skin: 0xffdab9, hair: 0x000000, shirt: 0xe35d6a, shorts: 0x1a1a2e };
	render.opponent = createCharacterMesh(handle.scene, undefined, oppColors);
	makeGhostly(render.opponent);
}

export function removeOpponentMesh(render: RenderState): void {
	if (render.opponent) {
		render.opponent.root.dispose();
		render.opponent = null;
	}
}

export function syncRender(
	state: GameState,
	render: RenderState,
	handle: SceneHandle,
	config: GameConfig,
): void {
	// Sync meshes
	syncCharacterMesh(render.character, state, config);
	syncTreeMeshes(render.trees, state.trees);
	syncCoinMeshes(render.coins, state.coins, state.tick);
	syncPowerupMeshes(render.powerups, state.powerups, state.tick);
	syncFog(handle, state.fogDistance);

	// ── Sun dims with fog ──────────────────────────────────────
	// fogDistance 60K = full sun, 8K = very dim
	const fogNorm = Math.min(1, Math.max(0, (state.fogDistance - 8000) / 52000));
	handle.sunLight.intensity = 0.3 + fogNorm * 0.5;
	// Sky darkens too
	const skyR = 0.50 + fogNorm * 0.22;
	const skyG = 0.55 + fogNorm * 0.23;
	const skyB = 0.62 + fogNorm * 0.23;
	handle.scene.clearColor.set(skyR, skyG, skyB, 1);

	updateHud(state);

	// ── Ambient music ──────────────────────────────────────────
	// Call every frame — startAmbientMusic is idempotent and retries
	// until the AudioContext is ready and the mp3 is loaded.
	if (state.tick > 0) {
		startAmbientMusic();
		if (!render.musicStarted) {
			render.musicStarted = true;
			createMusicToggle();
		}
	}
	if (state.gameOver || state.finished) {
		setMusicIntensity(0);
	} else {
		const intensity = Math.min(state.score / 30000, 1);
		setMusicIntensity(intensity);
	}

	// ── Dust trail ─────────────────────────────────────────────
	if (render.dustTrail) {
		if (state.gameOver || state.finished) {
			render.dustTrail.emitRate = 0;
		} else if (state.character.isJumping) {
			render.dustTrail.emitRate = 5; // less dust in air
		} else {
			render.dustTrail.emitRate = 40;
		}
	}

	// ── Coin collect particles ─────────────────────────────────
	if (state.coinCount > render.prevCoinCount) {
		const tier = state.lastCollectedTier || 'gold';
		const pos = new Vector3(
			-state.character.x,
			state.character.y + 200,
			state.character.z,
		);
		emitCoinBurst(handle.scene, pos, tier);
	}
	render.prevCoinCount = state.coinCount;

	// ── Flamethrower effects ──────────────────────────────────
	if (state.flameTicks > 0 && render.prevFlameTicks === 0) {
		// Just fired — emit blast
		const pos = new Vector3(
			-state.character.x,
			state.character.y + 200,
			state.character.z - 1000,
		);
		emitFlameBlast(handle.scene, pos);
	}
	// Dynamic flame lights
	const flameIntensity = state.flameTicks > 0 ? 2.0 : 0;
	handle.flameLightLeft.intensity = flameIntensity;
	handle.flameLightRight.intensity = flameIntensity;
	if (state.flameTicks > 0) {
		handle.flameLightLeft.position.set(
			-state.character.x - 200, 400, state.character.z - 2000,
		);
		handle.flameLightRight.position.set(
			-state.character.x + 200, 400, state.character.z - 2000,
		);
	}
	render.prevFlameTicks = state.flameTicks;

	// ── Dynamic camera ────────────────────────────────────────
	const currentLane = state.character.currentLane;

	// Roll on lane switch
	if (currentLane !== render.prevLane) {
		const dir = currentLane - render.prevLane;
		render.cameraRollTarget = dir * 0.035; // tilt toward the turn (flipped for LH coords)
	} else {
		render.cameraRollTarget = 0;
	}
	render.prevLane = currentLane;

	// Smooth roll interpolation
	render.cameraRoll += (render.cameraRollTarget - render.cameraRoll) * 0.08;
	handle.camera.rotation.z = render.cameraRoll;

	// Subtle camera bob while running
	if (!state.gameOver && !state.finished) {
		render.cameraBobPhase += 0.05;
		const bobY = Math.sin(render.cameraBobPhase * 2) * 8;
		const bobX = Math.sin(render.cameraBobPhase) * 4;
		handle.camera.position.y = 1800 + bobY;
		handle.camera.position.x = -state.character.x * 0.15 + bobX;
	}

	// Camera follows character x slightly
	const targetX = -state.character.x * 0.2;
	handle.camera.position.x += (targetX - handle.camera.position.x) * 0.05;

	// Chromatic aberration increases with score (sense of speed)
	const pipeline = handle.scene.postProcessRenderPipelineManager
		.supportedPipelines.find((p: any) => p.name === 'pipeline') as any;
	if (pipeline?.chromaticAberration) {
		const speedFactor = Math.min(state.score / 30000, 1);
		pipeline.chromaticAberration.aberrationAmount = 5 + speedFactor * 25;
	}
}

export function syncOpponent(
	opponentState: GameState,
	render: RenderState,
	config: GameConfig,
): void {
	if (render.opponent) {
		syncCharacterMesh(render.opponent, opponentState, config);
	}
}
