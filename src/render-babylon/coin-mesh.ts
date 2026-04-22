/**
 * Babylon.js coin mesh pool — glowing spinning coins with tier-based
 * colors, emissive glow, and size variation.
 */

import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { GlowLayer } from '@babylonjs/core/Layers/glowLayer';
import type { CoinState, CoinTier } from '../sim/state';
import { TICK_SECONDS } from '../sim/state';

const TIER_CONFIG: Record<CoinTier, {
	color: number; emissive: number; scale: number; glowIntensity: number;
}> = {
	gold: { color: 0xffd700, emissive: 0x997700, scale: 1.0, glowIntensity: 0.4 },
	blue: { color: 0x00bfff, emissive: 0x0066aa, scale: 1.15, glowIntensity: 0.7 },
	red:  { color: 0xff2050, emissive: 0xaa1030, scale: 1.35, glowIntensity: 1.0 },
};

function hex(h: number): Color3 {
	return new Color3(((h >> 16) & 0xff) / 255, ((h >> 8) & 0xff) / 255, (h & 0xff) / 255);
}

export interface CoinMeshPool {
	scene: Scene;
	pool: Map<CoinState, Mesh>;
	materials: Record<CoinTier, StandardMaterial>;
}

export function createCoinMeshPool(scene: Scene): CoinMeshPool {
	const materials = {} as Record<CoinTier, StandardMaterial>;
	for (const tier of ['gold', 'blue', 'red'] as CoinTier[]) {
		const cfg = TIER_CONFIG[tier];
		const m = new StandardMaterial(`coin_${tier}`, scene);
		m.diffuseColor = hex(cfg.color);
		m.emissiveColor = hex(cfg.emissive);
		m.specularColor = new Color3(0.8, 0.8, 0.8);
		m.specularPower = 64;
		materials[tier] = m;
	}
	return { scene, pool: new Map(), materials };
}

export function syncCoinMeshes(pool: CoinMeshPool, coins: CoinState[], tick: number): void {
	const alive = new Set(coins);
	const spin = tick * 1.5 * TICK_SECONDS; // slightly faster spin
	const bob = Math.sin(tick * TICK_SECONDS * 3) * 30; // gentle float

	for (const [state, mesh] of pool.pool) {
		if (!alive.has(state)) {
			mesh.dispose();
			pool.pool.delete(state);
		}
	}

	for (const coin of coins) {
		if (coin.collected) continue;
		let mesh = pool.pool.get(coin);
		if (!mesh) {
			const cfg = TIER_CONFIG[coin.tier];
			mesh = MeshBuilder.CreateCylinder(`coin`, {
				diameter: 160 * cfg.scale,
				height: 20 * cfg.scale,
				tessellation: 24, // smoother circles
			}, pool.scene);
			mesh.material = pool.materials[coin.tier];
			pool.pool.set(coin, mesh);
		}
		mesh.position.set(-coin.x, coin.y + 220 + bob, coin.z);
		mesh.rotation.x = Math.PI / 2;
		mesh.rotation.y = spin;
	}
}
