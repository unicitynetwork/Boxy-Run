/**
 * Nordic winter side scenery — snow-covered rocks, frost bushes,
 * snow mounds, ice patches, and a low winter sun.
 */

import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';

function hex(h: number): Color3 {
	return new Color3(((h >> 16) & 0xff) / 255, ((h >> 8) & 0xff) / 255, (h & 0xff) / 255);
}

export function createSideScenery(scene: Scene): void {
	const snowRockMats = [
		makeMat(scene, 'sr1', 0x6b6e72, 0.15),
		makeMat(scene, 'sr2', 0x5a5d62, 0.15),
		makeMat(scene, 'sr3', 0x787b80, 0.1),
	];
	const frostBushMats = [
		makeMat(scene, 'fb1', 0x2a4535),
		makeMat(scene, 'fb2', 0x1e3a2d),
		makeMat(scene, 'fb3', 0x354d40),
	];
	const snowMat = makeMat(scene, 'snowClump', 0xeef0f4, 0.2);

	const rng = mulberry32(42);

	for (let z = -2000; z > -120000; z -= 600 + rng() * 800) {
		for (const side of [-1, 1]) {
			const baseX = side * (1800 + rng() * 6000);

			// Snow-dusted rocks (45%)
			if (rng() < 0.45) {
				const w = 80 + rng() * 250;
				const h = 50 + rng() * 140;
				const rock = MeshBuilder.CreateBox('rock', {
					width: w, height: h, depth: 80 + rng() * 180,
				}, scene);
				rock.position = new Vector3(baseX, -400 + h * 0.3, z + rng() * 400);
				rock.rotation.y = rng() * Math.PI;
				rock.rotation.x = (rng() - 0.5) * 0.15;
				rock.material = snowRockMats[Math.floor(rng() * snowRockMats.length)];

				// Snow cap on rock
				if (rng() < 0.7) {
					const cap = MeshBuilder.CreateBox('snowCap', {
						width: w * 1.1, height: 15 + rng() * 20, depth: w * 0.9,
					}, scene);
					cap.position = rock.position.clone();
					cap.position.y += h * 0.4;
					cap.material = snowMat;
				}
			}

			// Frost-covered bushes (35%)
			if (rng() < 0.35) {
				const bushX = baseX + (rng() - 0.5) * 800;
				const size = 80 + rng() * 180;
				const bush = MeshBuilder.CreateSphere('bush', {
					diameter: size, segments: 4,
				}, scene);
				bush.position = new Vector3(bushX, -400 + size * 0.25, z + rng() * 400);
				bush.scaling.y = 0.5 + rng() * 0.3;
				bush.material = frostBushMats[Math.floor(rng() * frostBushMats.length)];
			}

			// Snow mounds (25%)
			if (rng() < 0.25) {
				const moundX = side * (1700 + rng() * 2000);
				const mound = MeshBuilder.CreateSphere('mound', {
					diameter: 200 + rng() * 400, segments: 5,
				}, scene);
				mound.position = new Vector3(moundX, -410, z + rng() * 500);
				mound.scaling.y = 0.25 + rng() * 0.15;
				mound.material = snowMat;
			}
		}

		// Occasional dead pine on the side (15%)
		if (rng() < 0.15) {
			const side = rng() < 0.5 ? -1 : 1;
			const treeX = side * (2500 + rng() * 4000);
			createDeadPine(scene, new Vector3(treeX, 0, z + rng() * 400), rng);
		}
	}
}

function createDeadPine(scene: Scene, pos: Vector3, rng: () => number): void {
	const root = MeshBuilder.CreateCylinder('deadTrunk', {
		diameterTop: 40, diameterBottom: 80, height: 600 + rng() * 400, tessellation: 6,
	}, scene);
	root.position = pos.clone();
	root.position.y = -100;
	const mat = new StandardMaterial('deadWood', scene);
	mat.diffuseColor = new Color3(0.3, 0.25, 0.2);
	mat.specularColor = new Color3(0.05, 0.05, 0.05);
	root.material = mat;

	// Sparse frozen branches
	const branchMat = new StandardMaterial('branch', scene);
	branchMat.diffuseColor = new Color3(0.18, 0.30, 0.22);
	branchMat.specularColor = new Color3(0.05, 0.05, 0.05);
	for (let i = 0; i < 3; i++) {
		const branch = MeshBuilder.CreateCylinder('branch', {
			diameterTop: 0, diameterBottom: 120 + rng() * 80, height: 100, tessellation: 4,
		}, scene);
		branch.parent = root;
		branch.position.y = 150 + i * 120;
		branch.material = branchMat;
	}
}

/** Low winter sun — large warm disc near the horizon. */
export function createSun(scene: Scene): Mesh {
	const sunPos = new Vector3(25000, 12000, -130000);

	// Core sun disc
	const sun = MeshBuilder.CreateDisc('sun', {
		radius: 4000, tessellation: 48,
	}, scene);
	sun.position = sunPos;
	sun.billboardMode = 7;
	const mat = new StandardMaterial('sunMat', scene);
	mat.diffuseColor = new Color3(1, 0.92, 0.70);
	mat.emissiveColor = new Color3(1, 0.88, 0.60);
	mat.specularColor = Color3.Black();
	mat.disableLighting = true;
	mat.backFaceCulling = false;
	sun.material = mat;

	// Inner warm halo
	const halo1 = MeshBuilder.CreateDisc('sunHalo1', {
		radius: 8000, tessellation: 48,
	}, scene);
	halo1.position = sunPos.clone();
	halo1.billboardMode = 7;
	const h1Mat = new StandardMaterial('h1Mat', scene);
	h1Mat.diffuseColor = new Color3(1, 0.90, 0.65);
	h1Mat.emissiveColor = new Color3(1, 0.82, 0.50);
	h1Mat.alpha = 0.12;
	h1Mat.specularColor = Color3.Black();
	h1Mat.disableLighting = true;
	h1Mat.backFaceCulling = false;
	halo1.material = h1Mat;

	// Outer soft glow
	const halo2 = MeshBuilder.CreateDisc('sunHalo2', {
		radius: 14000, tessellation: 48,
	}, scene);
	halo2.position = sunPos.clone();
	halo2.billboardMode = 7;
	const h2Mat = new StandardMaterial('h2Mat', scene);
	h2Mat.diffuseColor = new Color3(1, 0.92, 0.75);
	h2Mat.emissiveColor = new Color3(1, 0.85, 0.55);
	h2Mat.alpha = 0.05;
	h2Mat.specularColor = Color3.Black();
	h2Mat.disableLighting = true;
	h2Mat.backFaceCulling = false;
	halo2.material = h2Mat;

	return sun;
}

function makeMat(scene: Scene, name: string, color: number, spec = 0.05): StandardMaterial {
	const m = new StandardMaterial(name, scene);
	m.diffuseColor = hex(color);
	m.specularColor = new Color3(spec, spec, spec);
	return m;
}

function mulberry32(seed: number): () => number {
	let s = seed | 0;
	return () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
