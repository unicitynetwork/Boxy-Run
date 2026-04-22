/**
 * Babylon.js powerup mesh pool — flame-shaped pickups with bob + spin.
 */

import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Scene } from '@babylonjs/core/scene';
import type { PowerupState } from '../sim/state';
import { TICK_SECONDS } from '../sim/state';

export interface PowerupMeshPool {
	scene: Scene;
	pool: Map<PowerupState, TransformNode>;
}

export function createPowerupMeshPool(scene: Scene): PowerupMeshPool {
	return { scene, pool: new Map() };
}

function createPowerupMesh(scene: Scene): TransformNode {
	const root = new TransformNode('powerup', scene);

	// 3-layer flame
	const layers = [
		{ diam: 160, h: 240, y: 60, color: 0xff6600, emissive: 0xff3300, alpha: 0.85 },
		{ diam: 100, h: 180, y: 50, color: 0xffaa00, emissive: 0xffaa00, alpha: 0.9 },
		{ diam: 50,  h: 110, y: 40, color: 0xffffaa, emissive: 0xffff66, alpha: 1.0 },
	];

	for (const l of layers) {
		const cone = MeshBuilder.CreateCylinder('flame', {
			diameterTop: 0, diameterBottom: l.diam, height: l.h, tessellation: 8,
		}, scene);
		cone.parent = root;
		cone.position.y = l.y;
		const mat = new StandardMaterial('flameMat', scene);
		mat.diffuseColor = new Color3(
			((l.color >> 16) & 0xff) / 255,
			((l.color >> 8) & 0xff) / 255,
			(l.color & 0xff) / 255,
		);
		mat.emissiveColor = new Color3(
			((l.emissive >> 16) & 0xff) / 255,
			((l.emissive >> 8) & 0xff) / 255,
			(l.emissive & 0xff) / 255,
		);
		mat.alpha = l.alpha;
		cone.material = mat;
	}

	return root;
}

export function syncPowerupMeshes(
	pool: PowerupMeshPool,
	powerups: PowerupState[],
	tick: number,
): void {
	const alive = new Set(powerups);
	const t = tick * TICK_SECONDS;

	for (const [state, mesh] of pool.pool) {
		if (!alive.has(state)) {
			mesh.dispose();
			pool.pool.delete(state);
		}
	}

	for (const p of powerups) {
		if (p.collected) continue;
		let mesh = pool.pool.get(p);
		if (!mesh) {
			mesh = createPowerupMesh(pool.scene);
			pool.pool.set(p, mesh);
		}
		const bob = Math.sin(t * 3) * 30;
		mesh.position.set(-p.x, p.y + 200 + bob, p.z);
		mesh.rotation.y = t * 0.8;
		const flicker = 1 + Math.sin(t * 7) * 0.08 + Math.sin(t * 13) * 0.04;
		mesh.scaling.y = flicker;
	}
}
