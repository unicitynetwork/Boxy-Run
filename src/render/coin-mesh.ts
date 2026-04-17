/**
 * Coin mesh pool. Same identity-keyed pattern as the tree pool.
 * Coins additionally get a Y-rotation driven by sim tick count so
 * they spin at ~1.2 rad/sec like the original. Computing spin from
 * state.tick (rather than per-coin state) means all coins spin in
 * sync, which is a negligible visual difference from the original's
 * per-coin phase and saves us from carrying spin state.
 */

import type { CoinState, CoinTier } from '../sim/state';
import { TICK_SECONDS } from '../sim/state';

/** Coin spin speed in radians per second, matching the original. */
const COIN_SPIN_RATE = 1.2;

export interface CoinMeshPool {
	readonly scene: any;
	readonly meshes: Map<CoinState, any>;
}

export function createCoinMeshPool(scene: any): CoinMeshPool {
	return { scene, meshes: new Map() };
}

const TIER_COLORS: Record<CoinTier, number> = {
	gold: 0xffd700,
	blue: 0x00bfff,
	red: 0xff2050,
};

const TIER_EMISSIVE: Record<CoinTier, number> = {
	gold: 0x000000,
	blue: 0x003366,
	red: 0x330000,
};

const TIER_SCALE: Record<CoinTier, number> = {
	gold: 1.0,
	blue: 1.15,
	red: 1.35,
};

/** Internal helper: build a single coin mesh matching the original Coin class. */
function createCoinMesh(coin: CoinState): any {
	const tier = coin.tier || 'gold';
	const s = TIER_SCALE[tier];
	const mesh = new THREE.Object3D();
	const geom = new THREE.CylinderGeometry(80 * s, 80 * s, 20 * s, 32);
	const mat = new THREE.MeshPhongMaterial({
		color: TIER_COLORS[tier],
		emissive: TIER_EMISSIVE[tier],
		flatShading: true,
	});
	const inner = new THREE.Mesh(geom, mat);
	inner.rotation.z = Math.PI / 2;
	inner.castShadow = true;
	inner.receiveShadow = true;
	mesh.add(inner);
	mesh.position.set(coin.x, coin.y, coin.z);
	return mesh;
}

/**
 * Sync coin meshes to the given CoinState array. Removes meshes for
 * collected/culled coins, creates new ones, updates positions, and
 * sets all rotations to the tick-driven sync spin angle.
 */
export function syncCoinMeshes(
	pool: CoinMeshPool,
	coins: CoinState[],
	tick: number,
): void {
	const live = new Set<CoinState>(coins);

	for (const [coin, mesh] of pool.meshes) {
		if (!live.has(coin)) {
			pool.scene.remove(mesh);
			pool.meshes.delete(coin);
		}
	}

	const spin = tick * COIN_SPIN_RATE * TICK_SECONDS;
	for (const coin of coins) {
		const existing = pool.meshes.get(coin);
		if (!existing) {
			const mesh = createCoinMesh(coin);
			pool.meshes.set(coin, mesh);
			pool.scene.add(mesh);
			mesh.rotation.y = spin;
		} else {
			existing.position.set(coin.x, coin.y, coin.z);
			existing.rotation.y = spin;
		}
	}
}
