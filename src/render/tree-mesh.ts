/**
 * Tree mesh pool. Maintains a 1:1 mapping from sim TreeState objects to
 * Three.js meshes using object identity as the key. Each frame's sync
 * creates meshes for newly-spawned trees and removes meshes whose sim
 * entries have been culled off-screen.
 *
 * Using object identity (Map<TreeState, mesh>) works because the sim
 * mutates trees in place and preserves references when filtering —
 * `state.trees.filter(t => t.z < 0)` keeps the same TreeState instances,
 * just drops some of them.
 */

import type { TreeState } from '../sim/state';
import { Colors } from './colors';

/** Per-pool state: the scene to write into and the active mesh map. */
export interface TreeMeshPool {
	readonly scene: any;
	readonly meshes: Map<TreeState, any>;
}

export function createTreeMeshPool(scene: any): TreeMeshPool {
	return { scene, meshes: new Map() };
}

/** Internal helper: build a single tree mesh matching the original Tree class. */
function createTreeMesh(tree: TreeState): any {
	const mesh = new THREE.Object3D();
	const top = makeCylinder(1, 300, 300, 4, Colors.green, 0, 1000, 0);
	const mid = makeCylinder(1, 400, 400, 4, Colors.green, 0, 800, 0);
	const bottom = makeCylinder(1, 500, 500, 4, Colors.green, 0, 500, 0);
	const trunk = makeCylinder(100, 100, 250, 32, Colors.brownDark, 0, 125, 0);
	mesh.add(top);
	mesh.add(mid);
	mesh.add(bottom);
	mesh.add(trunk);
	mesh.position.set(tree.x, tree.y, tree.z);
	mesh.scale.set(tree.scale, tree.scale, tree.scale);
	return mesh;
}

function makeCylinder(
	radiusTop: number,
	radiusBottom: number,
	height: number,
	radialSegments: number,
	color: number,
	x: number,
	y: number,
	z: number,
): any {
	const geom = new THREE.CylinderGeometry(
		radiusTop,
		radiusBottom,
		height,
		radialSegments,
	);
	const mat = new THREE.MeshPhongMaterial({ color, flatShading: true });
	const cyl = new THREE.Mesh(geom, mat);
	cyl.castShadow = true;
	cyl.receiveShadow = true;
	cyl.position.set(x, y, z);
	return cyl;
}

/**
 * Sync the pool's meshes to match the given TreeState array. Adds
 * meshes for new trees, updates positions for existing trees, removes
 * meshes for trees that are no longer in the array.
 */
export function syncTreeMeshes(pool: TreeMeshPool, trees: TreeState[]): void {
	// Build a set of currently-live trees for O(1) membership lookup.
	const live = new Set<TreeState>(trees);

	// Remove meshes whose sim entries are gone.
	for (const [tree, mesh] of pool.meshes) {
		if (!live.has(tree)) {
			pool.scene.remove(mesh);
			pool.meshes.delete(tree);
		}
	}

	// Add or update meshes for each live tree.
	for (const tree of trees) {
		const existing = pool.meshes.get(tree);
		if (!existing) {
			const mesh = createTreeMesh(tree);
			pool.meshes.set(tree, mesh);
			pool.scene.add(mesh);
		} else {
			existing.position.set(tree.x, tree.y, tree.z);
		}
	}
}
