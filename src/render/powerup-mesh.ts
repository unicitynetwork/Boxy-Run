/**
 * Flamethrower powerup mesh pool. Renders as a spinning orange/red
 * flame-like object that floats above the ground.
 */

import type { PowerupState } from '../sim/state';
import { TICK_SECONDS } from '../sim/state';

const SPIN_RATE = 2.0;

export interface PowerupMeshPool {
	readonly scene: any;
	readonly meshes: Map<PowerupState, any>;
}

export function createPowerupMeshPool(scene: any): PowerupMeshPool {
	return { scene, meshes: new Map() };
}

function createPowerupMesh(p: PowerupState): any {
	const group = new THREE.Object3D();

	// Outer flame: tall pointed cone (teardrop-like)
	const outerGeom = new THREE.ConeGeometry(80, 240, 8, 1);
	const outerMat = new THREE.MeshPhongMaterial({
		color: 0xff6600,
		emissive: 0xff3300,
		emissiveIntensity: 0.7,
		flatShading: true,
		transparent: true,
		opacity: 0.85,
	});
	const outer = new THREE.Mesh(outerGeom, outerMat);
	outer.castShadow = true;
	outer.position.y = 60; // base sits near origin, tip points up
	group.add(outer);

	// Middle flame: yellow inner cone
	const midGeom = new THREE.ConeGeometry(50, 180, 8, 1);
	const midMat = new THREE.MeshPhongMaterial({
		color: 0xffaa00,
		emissive: 0xffaa00,
		emissiveIntensity: 0.9,
		flatShading: true,
		transparent: true,
		opacity: 0.9,
	});
	const mid = new THREE.Mesh(midGeom, midMat);
	mid.position.y = 50;
	group.add(mid);

	// Hot core: small white-yellow cone
	const coreGeom = new THREE.ConeGeometry(25, 110, 6, 1);
	const coreMat = new THREE.MeshPhongMaterial({
		color: 0xffffaa,
		emissive: 0xffff66,
		emissiveIntensity: 1.0,
		flatShading: true,
	});
	const core = new THREE.Mesh(coreGeom, coreMat);
	core.position.y = 40;
	group.add(core);

	group.position.set(p.x, p.y, p.z);
	return group;
}

export function syncPowerupMeshes(
	pool: PowerupMeshPool,
	powerups: PowerupState[],
	tick: number,
): void {
	const live = new Set<PowerupState>(powerups);

	for (const [p, mesh] of pool.meshes) {
		if (!live.has(p)) {
			pool.scene.remove(mesh);
			pool.meshes.delete(p);
		}
	}

	const t = tick * TICK_SECONDS;
	const bob = Math.sin(t * 3) * 30;
	const flicker = 1 + Math.sin(t * 12) * 0.08 + Math.sin(t * 27) * 0.04;
	const slowSpin = t * 0.8;
	for (const p of powerups) {
		const existing = pool.meshes.get(p);
		if (!existing) {
			const mesh = createPowerupMesh(p);
			pool.meshes.set(p, mesh);
			pool.scene.add(mesh);
			mesh.position.y = p.y + bob;
			mesh.rotation.y = slowSpin;
			mesh.scale.set(1, flicker, 1);
		} else {
			existing.position.set(p.x, p.y + bob, p.z);
			existing.rotation.y = slowSpin;
			existing.scale.set(1, flicker, 1);
		}
	}
}
