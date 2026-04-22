/**
 * Babylon.js tree mesh pool — Nordic winter pines with snow-dusted
 * foliage and dark trunks.
 */

import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Scene } from '@babylonjs/core/scene';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import type { TreeState } from '../sim/state';

export interface TreeMeshPool {
	scene: Scene;
	shadowGen?: ShadowGenerator;
	pool: Map<TreeState, TransformNode>;
	foliageMats: StandardMaterial[];
	snowMat: StandardMaterial;
	trunkMat: StandardMaterial;
}

export function createTreeMeshPool(scene: Scene, shadowGen?: ShadowGenerator): TreeMeshPool {
	// Dark winter pine greens
	const greens = [
		new Color3(0.12, 0.28, 0.18),
		new Color3(0.15, 0.32, 0.20),
		new Color3(0.10, 0.25, 0.16),
		new Color3(0.18, 0.30, 0.22),
	];
	const foliageMats = greens.map((c, i) => {
		const m = new StandardMaterial(`foliage${i}`, scene);
		m.diffuseColor = c;
		m.specularColor = new Color3(0.03, 0.05, 0.03);
		return m;
	});

	const snowMat = new StandardMaterial('treeSnow', scene);
	snowMat.diffuseColor = new Color3(0.93, 0.95, 0.98);
	snowMat.specularColor = new Color3(0.2, 0.2, 0.25);

	const trunkMat = new StandardMaterial('trunk', scene);
	trunkMat.diffuseColor = new Color3(0.22, 0.15, 0.10);
	trunkMat.specularColor = new Color3(0.05, 0.05, 0.05);

	return { scene, shadowGen, pool: new Map(), foliageMats, snowMat, trunkMat };
}

let treeCounter = 0;

function createTreeMesh(pool: TreeMeshPool): TransformNode {
	const { scene, foliageMats, snowMat, trunkMat, shadowGen } = pool;
	const id = treeCounter++;
	const root = new TransformNode(`tree${id}`, scene);

	const fMat = foliageMats[id % foliageMats.length];

	// 3 foliage cones
	const cones = [
		{ dBot: 250, h: 350, y: 1050 },
		{ dBot: 360, h: 380, y: 780 },
		{ dBot: 460, h: 420, y: 470 },
	];
	for (const c of cones) {
		const cone = MeshBuilder.CreateCylinder(`f${id}`, {
			diameterTop: 8, diameterBottom: c.dBot, height: c.h, tessellation: 6,
		}, scene);
		cone.parent = root;
		cone.position.y = c.y;
		cone.material = fMat;
		cone.receiveShadows = true;
		if (shadowGen) shadowGen.addShadowCaster(cone);

		// Snow on top of each cone layer
		const snowCap = MeshBuilder.CreateCylinder(`s${id}`, {
			diameterTop: 5, diameterBottom: c.dBot * 0.7, height: c.h * 0.2, tessellation: 6,
		}, scene);
		snowCap.parent = root;
		snowCap.position.y = c.y + c.h * 0.35;
		snowCap.material = snowMat;
	}

	// Trunk
	const trunk = MeshBuilder.CreateCylinder(`t${id}`, {
		diameterTop: 100, diameterBottom: 160, height: 300, tessellation: 8,
	}, scene);
	trunk.parent = root;
	trunk.position.y = 150;
	trunk.material = trunkMat;
	trunk.receiveShadows = true;
	if (shadowGen) shadowGen.addShadowCaster(trunk);

	// Slight random tilt
	root.rotation.z = (Math.random() - 0.5) * 0.04;
	root.rotation.x = (Math.random() - 0.5) * 0.02;

	return root;
}

export function syncTreeMeshes(pool: TreeMeshPool, trees: TreeState[]): void {
	const alive = new Set(trees);

	for (const [state, mesh] of pool.pool) {
		if (!alive.has(state)) {
			mesh.dispose();
			pool.pool.delete(state);
		}
	}

	for (const tree of trees) {
		let mesh = pool.pool.get(tree);
		if (!mesh) {
			mesh = createTreeMesh(pool);
			pool.pool.set(tree, mesh);
		}
		mesh.position.set(-tree.x, tree.y, tree.z);
		mesh.scaling.setAll(tree.scale);
	}
}
