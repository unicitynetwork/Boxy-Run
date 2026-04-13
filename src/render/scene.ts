/**
 * Three.js scene setup. Creates the renderer, scene, camera, lights,
 * fog, and ground plane. Does NOT add any gameplay objects (trees,
 * coins, character) — those are owned by per-entity modules that sync
 * from sim state each frame.
 *
 * The numeric constants (camera position, fog color, ground size) are
 * copied verbatim from the original game.js init() so the visual feel
 * is preserved exactly.
 */

import { Colors } from './colors';

/** Opaque handle to the renderer's long-lived Three.js objects. */
export interface SceneHandle {
	element: HTMLElement;
	renderer: any;
	scene: any;
	camera: any;
	fog: any;
}

/**
 * Build the scene, attach the renderer's canvas to the given element
 * (or #world by default). Returns a handle for subsequent rendering.
 */
export function createScene(container?: HTMLElement): SceneHandle {
	const element = container || document.getElementById('world');
	if (!element) {
		throw new Error('createScene: no container element found');
	}

	const renderer = new THREE.WebGLRenderer({
		alpha: true,
		antialias: true,
	});
	renderer.setSize(element.clientWidth, element.clientHeight);
	renderer.shadowMap.enabled = true;
	element.appendChild(renderer.domElement);

	const scene = new THREE.Scene();
	const fog = new THREE.Fog(0xbadbe4, 1, 60000);
	scene.fog = fog;

	const camera = new THREE.PerspectiveCamera(
		60,
		element.clientWidth / element.clientHeight,
		1,
		120000,
	);
	camera.position.set(0, 1500, -2000);
	camera.lookAt(new THREE.Vector3(0, 600, -5000));
	// Expose camera on window for legacy compatibility with existing code
	// that pokes at window.camera (sphere-connect, debug panels).
	(window as any).camera = camera;

	const light = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
	scene.add(light);

	// Ground plane: sand-colored box, 3000×20×120000, centered under
	// the character at y=-400 and extending into the distance.
	const groundGeom = new THREE.BoxGeometry(3000, 20, 120000);
	const groundMat = new THREE.MeshPhongMaterial({
		color: Colors.sand,
		flatShading: true,
	});
	const ground = new THREE.Mesh(groundGeom, groundMat);
	ground.position.set(0, -400, -60000);
	ground.castShadow = true;
	ground.receiveShadow = true;
	scene.add(ground);

	// Handle window resizes.
	window.addEventListener(
		'resize',
		() => {
			renderer.setSize(element.clientWidth, element.clientHeight);
			camera.aspect = element.clientWidth / element.clientHeight;
			camera.updateProjectionMatrix();
		},
		false,
	);

	return { element, renderer, scene, camera, fog };
}

/** Draw one frame. Call once per rAF. */
export function renderFrame(handle: SceneHandle): void {
	handle.renderer.render(handle.scene, handle.camera);
}

/** Update the scene's fog distance to match sim state. */
export function syncFog(handle: SceneHandle, fogDistance: number): void {
	handle.fog.far = fogDistance;
}
