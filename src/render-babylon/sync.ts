/**
 * Top-level render sync — ties game state to Babylon.js meshes,
 * particles, camera dynamics, and lighting effects.
 */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import type { Scene } from '@babylonjs/core/scene';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
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
import { TICK_SECONDS, type GameConfig, type GameState } from '../sim/state';
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
	musicStopped: boolean;
	// Scene handle ref for particles
	sceneHandle: SceneHandle;
	// Finish line (level mode only)
	finishLine: TransformNode | null;
	finishLineSpawnTick: number | null;
}

const FINISH_SPAWN_Z = -120000;

function createFinishLine(scene: Scene): TransformNode {
	const root = new TransformNode('finishLineRoot', scene);

	// Checkered banner across the road
	const bannerWidth = 4200;
	const bannerHeight = 280;
	const banner = MeshBuilder.CreatePlane('finishBanner', { width: bannerWidth, height: bannerHeight }, scene);
	banner.position.set(0, 380, 0);
	banner.parent = root;
	// Make double-sided so it shows from both directions
	(banner as any).material = null;
	(banner as Mesh).isPickable = false;

	// Checkered texture
	const tex = new DynamicTexture('finishTex', { width: 1024, height: 64 }, scene, false);
	const ctx = tex.getContext() as CanvasRenderingContext2D;
	const cellW = 64;
	const cellH = 32;
	for (let x = 0; x < 1024; x += cellW) {
		for (let y = 0; y < 64; y += cellH) {
			const isBlack = ((x / cellW) + (y / cellH)) % 2 === 0;
			ctx.fillStyle = isBlack ? '#0a0a0a' : '#ffffff';
			ctx.fillRect(x, y, cellW, cellH);
		}
	}
	tex.update();
	const mat = new StandardMaterial('finishMat', scene);
	mat.diffuseTexture = tex;
	mat.emissiveTexture = tex;
	mat.specularColor = new Color3(0, 0, 0);
	mat.backFaceCulling = false;
	banner.material = mat;

	// "FINISH" label above the banner
	const labelTex = new DynamicTexture('finishLabel', { width: 1024, height: 256 }, scene, false);
	const lctx = labelTex.getContext() as CanvasRenderingContext2D;
	lctx.fillStyle = 'rgba(0,0,0,0)';
	lctx.fillRect(0, 0, 1024, 256);
	lctx.font = 'bold 200px Orbitron, monospace';
	lctx.fillStyle = '#5feaff';
	lctx.textAlign = 'center';
	lctx.textBaseline = 'middle';
	lctx.shadowColor = 'rgba(0,0,0,0.85)';
	lctx.shadowBlur = 18;
	lctx.fillText('FINISH', 512, 128);
	labelTex.update();
	labelTex.hasAlpha = true;
	const label = MeshBuilder.CreatePlane('finishLabelPlane', { width: 3000, height: 750 }, scene);
	label.position.set(0, 880, 0);
	label.rotation.y = Math.PI; // face the camera in the left-handed scene
	label.parent = root;
	const lmat = new StandardMaterial('finishLabelMat', scene);
	lmat.diffuseTexture = labelTex;
	lmat.emissiveTexture = labelTex;
	lmat.opacityTexture = labelTex;
	lmat.specularColor = new Color3(0, 0, 0);
	lmat.disableLighting = true;
	lmat.backFaceCulling = false;
	label.material = lmat;

	// Two flagpole posts on either side
	const poleHeight = 1100;
	for (const side of [-1, 1]) {
		const pole = MeshBuilder.CreateBox('finishPole', { width: 70, height: poleHeight, depth: 70 }, scene);
		pole.position.set(side * (bannerWidth / 2 - 35), poleHeight / 2, 0);
		pole.parent = root;
		const pmat = new StandardMaterial('finishPoleMat', scene);
		pmat.diffuseColor = new Color3(0.18, 0.20, 0.24);
		pmat.emissiveColor = new Color3(0.05, 0.08, 0.10);
		pole.material = pmat;
	}

	return root;
}

function disposeFinishLine(node: TransformNode): void {
	const meshes = node.getChildMeshes();
	for (const m of meshes) {
		if (m.material) {
			(m.material as StandardMaterial).diffuseTexture?.dispose();
			m.material.dispose();
		}
		m.dispose();
	}
	node.dispose();
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
		prevCoinCount: 0, prevFlameTicks: 0, musicStarted: false, musicStopped: false,
		sceneHandle: handle,
		finishLine: null, finishLineSpawnTick: null,
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

	// ── Finish line ─────────────────────────────────────────────
	// Only shown when caller stashes an explicit z position on state — i.e.,
	// during replay/recording, where the exact end tick is known. Live
	// gameplay leaves this null because the finish point isn't determined
	// in advance (depends on player skill, coin pickups, etc.).
	const finishZ = (state as any).__finishLineZ as number | undefined;
	if (typeof finishZ === 'number') {
		if (!render.finishLine && finishZ < 5000) {
			render.finishLine = createFinishLine(handle.scene);
		}
		if (render.finishLine) {
			render.finishLine.position.z = finishZ;
			render.finishLine.position.x = 0;
			if (finishZ > 5000) {
				disposeFinishLine(render.finishLine);
				render.finishLine = null;
			}
		}
	} else if (render.finishLine) {
		disposeFinishLine(render.finishLine);
		render.finishLine = null;
		render.finishLineSpawnTick = null;
	}

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
	// Music: start when playing, stop when dead/finished.
	// Replay sets __forceMusic so the soundtrack keeps playing even after
	// the recorded gameOver/finished tick is reached.
	const forceMusic = (state as any).__forceMusic === true;
	if ((state.gameOver || state.finished) && !forceMusic) {
		if (!render.musicStopped) {
			render.musicStopped = true;
			setMusicIntensity(0);
			stopAmbientMusic();
		}
	} else if (state.tick > 0 || forceMusic) {
		startAmbientMusic();
		if (!render.musicStarted) {
			render.musicStarted = true;
			createMusicToggle();
		}
		// Floor at 0.2 so the soundtrack stays audible from tick 1.
		// Without it, score=0 maps to intensity=0 which the gain
		// fader in setMusicIntensity treats as "off", silencing the
		// track within ~12 frames of game start. Score still drives
		// the upper end (0.2 → 1.0).
		const intensity = Math.max(0.2, Math.min(state.score / 30000, 1));
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
