/**
 * Character mesh creation and per-frame sync. Builds the body-part
 * hierarchy (head, torso, arms, legs) that matches the original
 * Character class in game.js, and writes limb rotations based on the
 * sim's tick clock.
 *
 * Limb rotations are only updated while the character is not jumping,
 * matching the original behavior where the else-branch in
 * Character.update() (the running animation) was skipped during a jump,
 * leaving limbs visually "frozen" mid-stride. Three.js mesh rotation
 * state persists across frames, so the stateless renderer plus the
 * isJumping gate reproduces this exactly.
 */

import { sinusoid } from '../sim/math';
import type { GameConfig, GameState } from '../sim/state';
import { TICK_HZ } from '../sim/state';
import { Colors } from './colors';

const DEG_TO_RAD = Math.PI / 180;

/** References to the character's mesh parts, held so we can rotate them. */
export interface CharacterMesh {
	root: any;
	head: any;
	torso: any;
	leftArm: any;
	rightArm: any;
	leftLowerArm: any;
	rightLowerArm: any;
	leftLeg: any;
	rightLeg: any;
	leftLowerLeg: any;
	rightLowerLeg: any;
	label: any | null;
}

/** Internal helper: create a box mesh with the given dimensions and color. */
function createBox(
	dx: number,
	dy: number,
	dz: number,
	color: number,
	x: number,
	y: number,
	z: number,
): any {
	const geom = new THREE.BoxGeometry(dx, dy, dz);
	const mat = new THREE.MeshPhongMaterial({ color, flatShading: true });
	const box = new THREE.Mesh(geom, mat);
	box.castShadow = true;
	box.receiveShadow = true;
	box.position.set(x, y, z);
	return box;
}

/** Internal helper: create an empty group at the given position. */
function createGroup(x: number, y: number, z: number): any {
	const group = new THREE.Group();
	group.position.set(x, y, z);
	return group;
}

/**
 * Internal helper: create a limb with an axis of rotation at the top.
 * The box that represents the limb is offset downward so rotating the
 * parent group pivots it around the shoulder/hip joint.
 */
function createLimb(
	dx: number,
	dy: number,
	dz: number,
	color: number,
	x: number,
	y: number,
	z: number,
): any {
	const limb = createGroup(x, y, z);
	const offset = -1 * (Math.max(dx, dz) / 2 + dy / 2);
	const limbBox = createBox(dx, dy, dz, color, 0, offset, 0);
	limb.add(limbBox);
	return limb;
}

/**
 * Build the character mesh hierarchy and add its root to the scene.
 * Returns references to every part that gets animated so the per-frame
 * sync can rotate them without needing to traverse the scene graph.
 *
 * Body-part dimensions, positions, and colors are copied verbatim from
 * the Character class in the original game.js.
 */
/**
 * Make a character mesh ghostly — semi-transparent with an ethereal
 * tint. Traverses all child meshes and updates their materials.
 */
export function makeGhostly(mesh: CharacterMesh): void {
	mesh.root.traverse((child: any) => {
		if (child.isMesh && child.material) {
			child.material = child.material.clone();
			child.material.transparent = true;
			child.material.opacity = 0.35;
			child.material.depthWrite = false;
			// Add a slight emissive glow in the shirt color
			if (child.material.emissive) {
				child.material.emissive.setHex(child.material.color.getHex());
				child.material.emissiveIntensity = 0.3;
			}
		}
	});
	// Make the label more transparent too
	if (mesh.label) {
		mesh.label.material.opacity = 0.5;
	}
}

/** Optional color overrides for creating opponent / alternate characters. */
export interface CharacterColors {
	skin?: number;
	hair?: number;
	shirt?: number;
	shorts?: number;
}

/**
 * Create a floating text sprite to display above a character's head.
 * Uses a canvas texture so it renders as a 3D billboard that always
 * faces the camera.
 */
function createTextLabel(text: string, color: string): any {
	const canvas = document.createElement('canvas');
	const size = 256;
	canvas.width = size;
	canvas.height = 64;
	const ctx = canvas.getContext('2d')!;

	ctx.clearRect(0, 0, size, 64);
	ctx.font = 'bold 36px monospace';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	// Outline for readability against any background
	ctx.strokeStyle = 'rgba(0,0,0,0.7)';
	ctx.lineWidth = 5;
	ctx.strokeText(text, size / 2, 32);
	ctx.fillStyle = color;
	ctx.fillText(text, size / 2, 32);

	const texture = new THREE.CanvasTexture(canvas);
	texture.needsUpdate = true;
	const material = new THREE.SpriteMaterial({
		map: texture,
		transparent: true,
		depthTest: false,
	});
	const sprite = new THREE.Sprite(material);
	sprite.scale.set(600, 150, 1);
	sprite.position.set(0, 500, 0); // above the head
	return sprite;
}

export function createCharacterMesh(
	scene: any,
	colorOverrides?: CharacterColors,
	label?: string,
	labelColor?: string,
): CharacterMesh {
	const skin = colorOverrides?.skin ?? Colors.brown;
	const hair = colorOverrides?.hair ?? Colors.black;
	const shirt = colorOverrides?.shirt ?? Colors.yellow;
	const shorts = colorOverrides?.shorts ?? Colors.olive;

	const face = createBox(100, 100, 60, skin, 0, 0, 0);
	const hairBox = createBox(105, 20, 65, hair, 0, 50, 0);
	const head = createGroup(0, 260, -25);
	head.add(face);
	head.add(hairBox);

	const torso = createBox(150, 190, 40, shirt, 0, 100, 0);

	const leftLowerArm = createLimb(20, 120, 30, skin, 0, -170, 0);
	const leftArm = createLimb(30, 140, 40, skin, -100, 190, -10);
	leftArm.add(leftLowerArm);

	const rightLowerArm = createLimb(20, 120, 30, skin, 0, -170, 0);
	const rightArm = createLimb(30, 140, 40, skin, 100, 190, -10);
	rightArm.add(rightLowerArm);

	const leftLowerLeg = createLimb(40, 200, 40, skin, 0, -200, 0);
	const leftLeg = createLimb(50, 170, 50, shorts, -50, -10, 30);
	leftLeg.add(leftLowerLeg);

	const rightLowerLeg = createLimb(40, 200, 40, skin, 0, -200, 0);
	const rightLeg = createLimb(50, 170, 50, shorts, 50, -10, 30);
	rightLeg.add(rightLowerLeg);

	const root = createGroup(0, 0, -4000);
	root.add(head);
	root.add(torso);
	root.add(leftArm);
	root.add(rightArm);
	root.add(leftLeg);
	root.add(rightLeg);

	let labelSprite: any = null;
	if (label) {
		labelSprite = createTextLabel(label, labelColor ?? '#ffffff');
		root.add(labelSprite);
	}

	scene.add(root);

	return {
		root,
		head,
		torso,
		leftArm,
		rightArm,
		leftLowerArm,
		rightLowerArm,
		leftLeg,
		rightLeg,
		leftLowerLeg,
		rightLowerLeg,
		label: labelSprite,
	};
}

/**
 * Sync mesh position and limb rotations from sim state. Position is
 * written every frame; limb rotations only while not jumping.
 */
export function syncCharacterMesh(
	mesh: CharacterMesh,
	state: GameState,
	config: GameConfig,
): void {
	const char = state.character;
	mesh.root.position.set(char.x, char.y, char.z);

	if (char.isJumping) {
		return;
	}

	const runningClock = (state.tick - char.runningStartTick) / TICK_HZ;
	const f = config.characterStepFreq;

	mesh.head.rotation.x =
		sinusoid(2 * f, -10, -5, 0, runningClock) * DEG_TO_RAD;
	mesh.torso.rotation.x =
		sinusoid(2 * f, -10, -5, 180, runningClock) * DEG_TO_RAD;
	mesh.leftArm.rotation.x =
		sinusoid(f, -70, 50, 180, runningClock) * DEG_TO_RAD;
	mesh.rightArm.rotation.x =
		sinusoid(f, -70, 50, 0, runningClock) * DEG_TO_RAD;
	mesh.leftLowerArm.rotation.x =
		sinusoid(f, 70, 140, 180, runningClock) * DEG_TO_RAD;
	mesh.rightLowerArm.rotation.x =
		sinusoid(f, 70, 140, 0, runningClock) * DEG_TO_RAD;
	mesh.leftLeg.rotation.x =
		sinusoid(f, -20, 80, 0, runningClock) * DEG_TO_RAD;
	mesh.rightLeg.rotation.x =
		sinusoid(f, -20, 80, 180, runningClock) * DEG_TO_RAD;
	mesh.leftLowerLeg.rotation.x =
		sinusoid(f, -130, 5, 240, runningClock) * DEG_TO_RAD;
	mesh.rightLowerLeg.rotation.x =
		sinusoid(f, -130, 5, 60, runningClock) * DEG_TO_RAD;
}
