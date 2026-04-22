/**
 * Particle effects for the Babylon.js renderer.
 *
 * - Dust trail behind running character
 * - Coin collect burst (per tier color)
 * - Flamethrower fire blast
 * - Speed lines at screen edges (high speed)
 */

import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';

/** Create a small white circle texture for particles. */
function makeParticleTexture(scene: Scene): Texture {
	const tex = new DynamicTexture('particleTex', 64, scene);
	const ctx = tex.getContext();
	const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
	g.addColorStop(0, 'rgba(255,255,255,1)');
	g.addColorStop(0.4, 'rgba(255,255,255,0.6)');
	g.addColorStop(1, 'rgba(255,255,255,0)');
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, 64, 64);
	tex.update();
	tex.hasAlpha = true;
	return tex;
}

let sharedTex: Texture | null = null;
function getTex(scene: Scene): Texture {
	if (!sharedTex) sharedTex = makeParticleTexture(scene);
	return sharedTex;
}

// ── Dust Trail ─────────────────────────────────────────────────────

export function createDustTrail(scene: Scene, emitter: TransformNode): ParticleSystem {
	const dust = new ParticleSystem('dust', 100, scene);
	dust.particleTexture = getTex(scene);
	dust.emitter = emitter;
	dust.minEmitBox = new Vector3(-80, -350, 100);
	dust.maxEmitBox = new Vector3(80, -350, 300);

	dust.color1 = new Color4(0.7, 0.6, 0.5, 0.4);
	dust.color2 = new Color4(0.6, 0.55, 0.45, 0.3);
	dust.colorDead = new Color4(0.5, 0.5, 0.5, 0);

	dust.minSize = 30;
	dust.maxSize = 80;
	dust.minLifeTime = 0.3;
	dust.maxLifeTime = 0.8;

	dust.emitRate = 30;
	dust.direction1 = new Vector3(-50, 50, 200);
	dust.direction2 = new Vector3(50, 150, 400);
	dust.gravity = new Vector3(0, -200, 0);

	dust.minEmitPower = 50;
	dust.maxEmitPower = 150;

	dust.blendMode = ParticleSystem.BLENDMODE_STANDARD;
	dust.start();
	return dust;
}

// ── Coin Collect Burst ─────────────────────────────────────────────

const TIER_COLORS: Record<string, { c1: Color4; c2: Color4 }> = {
	gold: { c1: new Color4(1, 0.85, 0, 1), c2: new Color4(1, 0.65, 0, 0.6) },
	blue: { c1: new Color4(0, 0.75, 1, 1), c2: new Color4(0, 0.4, 1, 0.6) },
	red:  { c1: new Color4(1, 0.15, 0.3, 1), c2: new Color4(1, 0.5, 0, 0.6) },
};

export function emitCoinBurst(
	scene: Scene,
	position: Vector3,
	tier: string,
): void {
	const colors = TIER_COLORS[tier] || TIER_COLORS.gold;
	const burst = new ParticleSystem('coinBurst', 40, scene);
	burst.particleTexture = getTex(scene);
	burst.emitter = position.clone();

	burst.color1 = colors.c1;
	burst.color2 = colors.c2;
	burst.colorDead = new Color4(1, 1, 1, 0);

	burst.minSize = 20;
	burst.maxSize = 60;
	burst.minLifeTime = 0.2;
	burst.maxLifeTime = 0.5;

	burst.emitRate = 0; // manual burst
	burst.manualEmitCount = 30;
	burst.direction1 = new Vector3(-300, 300, -300);
	burst.direction2 = new Vector3(300, 500, 300);
	burst.gravity = new Vector3(0, -800, 0);

	burst.minEmitPower = 200;
	burst.maxEmitPower = 500;

	burst.blendMode = ParticleSystem.BLENDMODE_ADD;
	burst.targetStopDuration = 0.5;
	burst.disposeOnStop = true;
	burst.start();
}

// ── Flamethrower Blast ─────────────────────────────────────────────

export function emitFlameBlast(
	scene: Scene,
	position: Vector3,
): void {
	const flame = new ParticleSystem('flame', 200, scene);
	flame.particleTexture = getTex(scene);
	flame.emitter = position.clone();

	flame.color1 = new Color4(1, 0.6, 0, 1);
	flame.color2 = new Color4(1, 0.2, 0, 0.8);
	flame.colorDead = new Color4(0.3, 0.1, 0, 0);

	flame.minSize = 40;
	flame.maxSize = 150;
	flame.minLifeTime = 0.15;
	flame.maxLifeTime = 0.5;

	flame.emitRate = 0;
	flame.manualEmitCount = 150;
	flame.direction1 = new Vector3(-200, 100, -2000);
	flame.direction2 = new Vector3(200, 400, -5000);
	flame.gravity = new Vector3(0, 300, 0);

	flame.minEmitPower = 500;
	flame.maxEmitPower = 2000;

	flame.blendMode = ParticleSystem.BLENDMODE_ADD;
	flame.targetStopDuration = 0.6;
	flame.disposeOnStop = true;
	flame.start();
}

// ── Near-miss sparks ───────────────────────────────────────────────

export function emitNearMiss(scene: Scene, position: Vector3): void {
	const sparks = new ParticleSystem('nearMiss', 20, scene);
	sparks.particleTexture = getTex(scene);
	sparks.emitter = position.clone();

	sparks.color1 = new Color4(1, 1, 1, 0.8);
	sparks.color2 = new Color4(0.8, 0.9, 1, 0.5);
	sparks.colorDead = new Color4(1, 1, 1, 0);

	sparks.minSize = 5;
	sparks.maxSize = 15;
	sparks.minLifeTime = 0.1;
	sparks.maxLifeTime = 0.3;

	sparks.emitRate = 0;
	sparks.manualEmitCount = 15;
	sparks.direction1 = new Vector3(-200, 200, -100);
	sparks.direction2 = new Vector3(200, 400, 100);

	sparks.minEmitPower = 100;
	sparks.maxEmitPower = 300;

	sparks.blendMode = ParticleSystem.BLENDMODE_ADD;
	sparks.targetStopDuration = 0.3;
	sparks.disposeOnStop = true;
	sparks.start();
}
