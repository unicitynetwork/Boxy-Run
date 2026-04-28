/**
 * Babylon.js scene — Nordic winter forest theme.
 *
 * Cold blue-grey sky, snow-covered ground, frosted mountains,
 * falling snow particles, muted winter lighting.
 */

import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { Vector3, Color3, Color4 } from '@babylonjs/core/Maths/math';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { GlowLayer } from '@babylonjs/core/Layers/glowLayer';
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';

import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import '@babylonjs/core/Rendering/depthRendererSceneComponent';

export interface SceneHandle {
	canvas: HTMLCanvasElement;
	engine: Engine;
	scene: Scene;
	camera: FreeCamera;
	shadowGenerator: ShadowGenerator;
	glowLayer: GlowLayer;
	sunLight: DirectionalLight;
	flameLightLeft: PointLight;
	flameLightRight: PointLight;
	speedLines: Mesh[];
}

export function createScene(container?: HTMLElement | null): SceneHandle {
	const parent = container || document.getElementById('world');
	if (!parent) throw new Error('No #world container found');

	const canvas = document.createElement('canvas');
	canvas.style.width = '100%';
	canvas.style.height = '100%';
	canvas.style.display = 'block';
	parent.appendChild(canvas);

	const engine = new Engine(canvas, true, {
		// preserveDrawingBuffer:true so we can drawImage(scene.canvas, ...)
		// onto a 2D composite canvas for video recording.
		preserveDrawingBuffer: true,
		stencil: true,
		antialias: true,
	});
	engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio, 2));

	const scene = new Scene(engine);

	// ── Winter sky — pale cold blue ──────────────────────────────
	scene.clearColor = new Color4(0.72, 0.78, 0.85, 1);
	scene.ambientColor = new Color3(0.45, 0.48, 0.55);

	// Fog — pale blue-white mist
	scene.fogMode = Scene.FOGMODE_EXP2;
	scene.fogDensity = 0.000015;
	scene.fogColor = new Color3(0.70, 0.76, 0.84);

	// ── Camera ─────────────────────────────────────────────────────
	const camera = new FreeCamera('cam', new Vector3(0, 1800, -1500), scene);
	camera.setTarget(new Vector3(0, 400, -6000));
	camera.minZ = 10;
	camera.maxZ = 150000;
	camera.fov = 1.1;
	camera.inputs.clear();
	camera.detachControl();

	// ── Lighting — cold, muted winter light ────────────────────
	const hemiLight = new HemisphericLight('hemi', new Vector3(0.1, 1, -0.2), scene);
	hemiLight.intensity = 0.85;
	hemiLight.diffuse = new Color3(0.90, 0.92, 1.0); // bright cold white
	hemiLight.groundColor = new Color3(0.35, 0.40, 0.50);

	// Low winter sun — warm golden accent
	const sunLight = new DirectionalLight('sun', new Vector3(-0.4, -0.5, -0.7), scene);
	sunLight.intensity = 0.7;
	sunLight.diffuse = new Color3(1.0, 0.88, 0.70);
	sunLight.position = new Vector3(8000, 6000, 2000);

	// Shadows
	const shadowGenerator = new ShadowGenerator(2048, sunLight);
	shadowGenerator.useBlurExponentialShadowMap = true;
	shadowGenerator.blurKernel = 32;
	shadowGenerator.darkness = 0.5;
	shadowGenerator.frustumEdgeFalloff = 1.0;

	// Flame lights
	const flameLightLeft = new PointLight('flameL', new Vector3(-300, 400, -4500), scene);
	flameLightLeft.intensity = 0;
	flameLightLeft.diffuse = new Color3(1, 0.5, 0);
	flameLightLeft.range = 3000;
	const flameLightRight = new PointLight('flameR', new Vector3(300, 400, -4500), scene);
	flameLightRight.intensity = 0;
	flameLightRight.diffuse = new Color3(1, 0.3, 0);
	flameLightRight.range = 3000;

	// ── Glow Layer ─────────────────────────────────────────────
	const glowLayer = new GlowLayer('glow', scene, {
		mainTextureFixedSize: 512,
		blurKernelSize: 64,
	});
	glowLayer.intensity = 0.6;
	// Only glow coins/powerups — exclude everything else
	glowLayer.customEmissiveColorSelector = (mesh, subMesh, material, result) => {
		if (mesh.name.startsWith('coin') || mesh.name.startsWith('flame') || mesh.name.startsWith('sun')) {
			result.set(
				material.emissiveColor.r,
				material.emissiveColor.g,
				material.emissiveColor.b,
				1,
			);
		} else {
			result.set(0, 0, 0, 0);
		}
	};

	// ── Ground ──────────────────────────────────────────────────
	createGround(scene, shadowGenerator);

	// Mountains removed — just open sky + sun

	// ── Scenery (rocks, frost bushes, snow mounds) ──────────────
	import('./scenery').then(({ createSideScenery, createSun }) => {
		createSideScenery(scene);
		createSun(scene);
	});


	// ── Post-processing ────────────────────────────────────────
	const pipeline = new DefaultRenderingPipeline('pipeline', true, scene, [camera]);
	pipeline.bloomEnabled = true;
	pipeline.bloomThreshold = 0.7;
	pipeline.bloomWeight = 0.3;
	pipeline.bloomKernel = 64;
	pipeline.bloomScale = 0.5;
	pipeline.chromaticAberrationEnabled = true;
	pipeline.chromaticAberration.aberrationAmount = 6;
	pipeline.chromaticAberration.radialIntensity = 0.4;
	pipeline.sharpenEnabled = true;
	pipeline.sharpen.edgeAmount = 0.15;
	pipeline.fxaaEnabled = true;

	const speedLines: Mesh[] = [];

	const onResize = () => engine.resize();
	window.addEventListener('resize', onResize);
	// iOS Safari collapses/expands the URL bar via visualViewport without
	// firing a window resize. Listen there too so the canvas backing
	// buffer stays in sync with the actually-visible area.
	const vv = (window as any).visualViewport;
	if (vv) {
		vv.addEventListener('resize', onResize);
		vv.addEventListener('scroll', onResize);
	}
	// Also catch orientation changes immediately (some Safari versions
	// delay the resize event)
	window.addEventListener('orientationchange', () => setTimeout(onResize, 100));
	scene.preventDefaultOnPointerDown = false;

	return {
		canvas, engine, scene, camera, shadowGenerator, glowLayer,
		sunLight, flameLightLeft, flameLightRight, speedLines,
	};
}


function createGround(scene: Scene, shadowGen: ShadowGenerator): void {
	// Snow-covered runway
	const ground = MeshBuilder.CreateBox('ground', {
		width: 3200, height: 30, depth: 140000,
	}, scene);
	ground.position = new Vector3(0, -415, -70000);
	ground.receiveShadows = true;

	// Procedural snowy ground texture
	const tex = new DynamicTexture('groundTex', { width: 512, height: 512 }, scene);
	const ctx = tex.getContext();
	// Base snow — bright white
	ctx.fillStyle = '#e8edf2';
	ctx.fillRect(0, 0, 512, 512);
	// Dirt path in center (trodden snow/ice)
	ctx.fillStyle = '#b0a898';
	ctx.fillRect(60, 0, 392, 512);
	// Subtle lane lines (ice tracks)
	ctx.strokeStyle = 'rgba(180,200,220,0.3)';
	ctx.lineWidth = 3;
	for (const x of [170, 341]) {
		ctx.beginPath();
		ctx.moveTo(x, 0);
		ctx.lineTo(x, 512);
		ctx.stroke();
	}
	// Snow speckles on dirt
	for (let i = 0; i < 300; i++) {
		const sx = 60 + Math.random() * 392;
		const sy = Math.random() * 512;
		ctx.fillStyle = `rgba(200, 210, 220, ${0.2 + Math.random() * 0.3})`;
		ctx.fillRect(sx, sy, 2 + Math.random() * 4, 2 + Math.random() * 4);
	}
	tex.update();

	const groundMat = new StandardMaterial('groundMat', scene);
	groundMat.diffuseTexture = tex;
	(groundMat.diffuseTexture as DynamicTexture).uScale = 4;
	(groundMat.diffuseTexture as DynamicTexture).vScale = 200;
	groundMat.specularColor = new Color3(0.15, 0.15, 0.2);
	ground.material = groundMat;

	// Snow fields on sides
	for (const side of [-1, 1]) {
		const snow = MeshBuilder.CreateBox('snowField', {
			width: 12000, height: 20, depth: 140000,
		}, scene);
		snow.position = new Vector3(side * 7600, -420, -70000);
		snow.receiveShadows = true;
		const snowMat = new StandardMaterial('snowMat', scene);
		snowMat.diffuseColor = new Color3(0.95, 0.96, 0.98);
		snowMat.specularColor = new Color3(0.25, 0.25, 0.3);
		snow.material = snowMat;
	}
}

export function renderFrame(handle: SceneHandle): void {
	handle.scene.render();
}

/** Dispose the entire Babylon engine and free GPU resources. */
export function disposeScene(handle: SceneHandle): void {
	handle.scene.dispose();
	handle.engine.dispose();
}

export function syncFog(handle: SceneHandle, fogDistance: number): void {
	handle.scene.fogDensity = 2.5 / Math.max(fogDistance, 1000);
}
