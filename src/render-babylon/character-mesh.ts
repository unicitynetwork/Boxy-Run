/**
 * Babylon.js character — refined boxy humanoid with better proportions,
 * eyes, and shadow-casting parts.
 */

import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { sinusoid } from '../sim/math';
import type { GameConfig, GameState } from '../sim/state';
import { TICK_SECONDS } from '../sim/state';

export interface CharacterColors {
	skin?: number;
	hair?: number;
	shirt?: number;
	shorts?: number;
}

export interface CharacterMesh {
	root: TransformNode;
	head: TransformNode;
	torso: Mesh;
	leftArm: TransformNode;
	rightArm: TransformNode;
	leftLowerArm: Mesh;
	rightLowerArm: Mesh;
	leftLeg: TransformNode;
	rightLeg: TransformNode;
	leftLowerLeg: Mesh;
	rightLowerLeg: Mesh;
}

function hex(h: number): Color3 {
	return new Color3(((h >> 16) & 0xff) / 255, ((h >> 8) & 0xff) / 255, (h & 0xff) / 255);
}

function mat(scene: Scene, name: string, color: number, spec = 0.1): StandardMaterial {
	const m = new StandardMaterial(name, scene);
	m.diffuseColor = hex(color);
	m.specularColor = new Color3(spec, spec, spec);
	return m;
}

export function createCharacterMesh(
	scene: Scene,
	shadowGen?: ShadowGenerator,
	colorOverrides?: CharacterColors,
): CharacterMesh {
	const skin = colorOverrides?.skin ?? 0x59332e;
	const hair = colorOverrides?.hair ?? 0x000000;
	const shirt = colorOverrides?.shirt ?? 0xffff00;
	const shorts = colorOverrides?.shorts ?? 0x556b2f;

	const root = new TransformNode('char', scene);
	root.position = new Vector3(0, 0, -4000);

	// ── Head ──────────────────────────────────────────────────────
	const head = new TransformNode('head', scene);
	head.parent = root;
	head.position = new Vector3(0, 260, -25);

	const face = MeshBuilder.CreateBox('face', { width: 100, height: 100, depth: 60 }, scene);
	face.parent = head;
	face.material = mat(scene, 'skinMat', skin, 0.15);
	if (shadowGen) shadowGen.addShadowCaster(face);

	// Eyes
	const eyeMat = mat(scene, 'eyeMat', 0xffffff, 0.3);
	const pupilMat = mat(scene, 'pupilMat', 0x222222);
	for (const side of [-1, 1]) {
		const eye = MeshBuilder.CreateBox('eye', { width: 18, height: 16, depth: 6 }, scene);
		eye.parent = head;
		eye.position = new Vector3(side * 22, 10, -33);
		eye.material = eyeMat;

		const pupil = MeshBuilder.CreateBox('pupil', { width: 8, height: 10, depth: 4 }, scene);
		pupil.parent = head;
		pupil.position = new Vector3(side * 22, 8, -36);
		pupil.material = pupilMat;
	}

	// Hair
	const hairMesh = MeshBuilder.CreateBox('hair', { width: 108, height: 25, depth: 68 }, scene);
	hairMesh.parent = head;
	hairMesh.position.y = 52;
	hairMesh.material = mat(scene, 'hairMat', hair);

	// ── Torso ─────────────────────────────────────────────────────
	const torso = MeshBuilder.CreateBox('torso', { width: 150, height: 190, depth: 45 }, scene);
	torso.parent = root;
	torso.position = new Vector3(0, 100, 0);
	torso.material = mat(scene, 'shirtMat', shirt, 0.15);
	if (shadowGen) shadowGen.addShadowCaster(torso);

	// Shirt collar detail
	const collar = MeshBuilder.CreateBox('collar', { width: 80, height: 12, depth: 48 }, scene);
	collar.parent = root;
	collar.position = new Vector3(0, 200, 0);
	collar.material = mat(scene, 'collarMat', shirt);

	// ── Arms ──────────────────────────────────────────────────────
	const { upper: leftArm, lower: leftLowerArm } = createLimb(
		scene, 'lArm', root, new Vector3(-100, 190, -10),
		{ w: 32, h: 130, d: 36 }, shirt,
		{ w: 24, h: 110, d: 28 }, skin, shadowGen,
	);
	const { upper: rightArm, lower: rightLowerArm } = createLimb(
		scene, 'rArm', root, new Vector3(100, 190, -10),
		{ w: 32, h: 130, d: 36 }, shirt,
		{ w: 24, h: 110, d: 28 }, skin, shadowGen,
	);

	// ── Legs ──────────────────────────────────────────────────────
	const { upper: leftLeg, lower: leftLowerLeg } = createLimb(
		scene, 'lLeg', root, new Vector3(-50, -10, 30),
		{ w: 50, h: 160, d: 50 }, shorts,
		{ w: 42, h: 190, d: 42 }, skin, shadowGen,
	);
	const { upper: rightLeg, lower: rightLowerLeg } = createLimb(
		scene, 'rLeg', root, new Vector3(50, -10, 30),
		{ w: 50, h: 160, d: 50 }, shorts,
		{ w: 42, h: 190, d: 42 }, skin, shadowGen,
	);

	// Shoes
	const shoeMat = mat(scene, 'shoeMat', 0x333333, 0.2);
	for (const [leg, side] of [[leftLeg, -1], [rightLeg, 1]] as const) {
		const shoe = MeshBuilder.CreateBox('shoe', { width: 50, height: 30, depth: 60 }, scene);
		shoe.parent = leg;
		shoe.position = new Vector3(0, -355, -10);
		shoe.material = shoeMat;
		if (shadowGen) shadowGen.addShadowCaster(shoe);
	}

	return {
		root, head, torso,
		leftArm, rightArm, leftLowerArm, rightLowerArm,
		leftLeg, rightLeg, leftLowerLeg, rightLowerLeg,
	};
}

function createLimb(
	scene: Scene, name: string, parent: TransformNode,
	pos: Vector3,
	upper: { w: number; h: number; d: number }, upperColor: number,
	lower: { w: number; h: number; d: number }, lowerColor: number,
	shadowGen?: ShadowGenerator,
): { upper: TransformNode; lower: Mesh } {
	const pivot = new TransformNode(name, scene);
	pivot.parent = parent;
	pivot.position = pos;

	const upperMesh = MeshBuilder.CreateBox(name + 'U', {
		width: upper.w, height: upper.h, depth: upper.d,
	}, scene);
	upperMesh.parent = pivot;
	upperMesh.position.y = -upper.h / 2;
	upperMesh.material = mat(scene, name + 'UM', upperColor);
	if (shadowGen) shadowGen.addShadowCaster(upperMesh);

	const lowerMesh = MeshBuilder.CreateBox(name + 'L', {
		width: lower.w, height: lower.h, depth: lower.d,
	}, scene);
	lowerMesh.parent = pivot;
	lowerMesh.position.y = -upper.h - lower.h / 2;
	lowerMesh.material = mat(scene, name + 'LM', lowerColor);
	if (shadowGen) shadowGen.addShadowCaster(lowerMesh);

	return { upper: pivot, lower: lowerMesh };
}

const DEG = Math.PI / 180;

export function syncCharacterMesh(
	mesh: CharacterMesh, state: GameState, config: GameConfig,
): void {
	const char = state.character;
	// Babylon uses left-handed coords — negate X so left/right match screen
	mesh.root.position.x = -char.x;
	mesh.root.position.y = char.y;

	if (!char.isJumping) {
		const f = config.characterStepFreq;
		const t = (state.tick - char.runningStartTick) * TICK_SECONDS;

		mesh.head.rotation.x = sinusoid(2 * f, -10, -5, 0, t) * DEG;
		mesh.torso.rotation.x = sinusoid(2 * f, -10, -5, 180, t) * DEG;
		mesh.leftArm.rotation.x = sinusoid(f, -70, 50, 180, t) * DEG;
		mesh.rightArm.rotation.x = sinusoid(f, -70, 50, 0, t) * DEG;
		mesh.leftLowerArm.rotation.x = sinusoid(f, 70, 140, 180, t) * DEG;
		mesh.rightLowerArm.rotation.x = sinusoid(f, 70, 140, 0, t) * DEG;
		mesh.leftLeg.rotation.x = sinusoid(f, -20, 80, 0, t) * DEG;
		mesh.rightLeg.rotation.x = sinusoid(f, -20, 80, 180, t) * DEG;
		mesh.leftLowerLeg.rotation.x = sinusoid(f, -130, 5, 240, t) * DEG;
		mesh.rightLowerLeg.rotation.x = sinusoid(f, -130, 5, 60, t) * DEG;
	}
}

export function makeGhostly(mesh: CharacterMesh): void {
	mesh.root.getChildMeshes().forEach(m => {
		if (m.material && 'alpha' in m.material) {
			(m.material as StandardMaterial).alpha = 0.18;
			(m.material as StandardMaterial).emissiveColor = new Color3(0, 0.8, 1);
		}
	});
}
