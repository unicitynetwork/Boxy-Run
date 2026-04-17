/**
 * Axis-aligned bounding-box collision primitives. Pure functions of sim
 * state — no side effects, no rendering, no `this`. Derived from the
 * `collides()` methods on the Tree / Coin / Character in the original
 * game.js. The magic numbers (115, 310, 320, 40, 250, 1150, 80, 100)
 * are copied verbatim because the game's feel depends on them; do not
 * tweak without running the visual-parity acceptance test.
 */

import type { CharacterState, CoinState, PowerupState, TreeState } from './state';

/** Axis-aligned bounding box in world coordinates. */
export interface BoundingBox {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
	minZ: number;
	maxZ: number;
}

/**
 * Character hitbox. Half-extents:
 *   - x: ±115 (shoulder width)
 *   - y: -310 to +320 around position (slightly off-center for head/feet)
 *   - z: ±40 (shallow depth)
 * Matches the charMin / charMax computation in the original
 * collisionsDetected() function.
 */
export function characterBox(character: CharacterState): BoundingBox {
	return {
		minX: character.x - 115,
		maxX: character.x + 115,
		minY: character.y - 310,
		maxY: character.y + 320,
		minZ: character.z - 40,
		maxZ: character.z + 40,
	};
}

/**
 * Tree hitbox. Scales with the tree's size parameter. Matches the
 * Tree.collides() computation in the original code.
 */
export function treeBox(tree: TreeState): BoundingBox {
	const halfWidth = tree.scale * 250;
	const height = tree.scale * 1150;
	return {
		minX: tree.x - halfWidth,
		maxX: tree.x + halfWidth,
		minY: tree.y,
		maxY: tree.y + height,
		minZ: tree.z - halfWidth,
		maxZ: tree.z + halfWidth,
	};
}

/**
 * Coin hitbox. Constant-size, does not scale. Matches the Coin.collides()
 * computation. Depth (±100) is deliberately wider than width/height
 * (±80) so fast-moving coins don't slip between frames.
 */
export function coinBox(coin: CoinState): BoundingBox {
	return {
		minX: coin.x - 80,
		maxX: coin.x + 80,
		minY: coin.y - 80,
		maxY: coin.y + 80,
		minZ: coin.z - 100,
		maxZ: coin.z + 100,
	};
}

/** Powerup hitbox. Generous to make them easy to collect. */
export function powerupBox(p: PowerupState): BoundingBox {
	return {
		minX: p.x - 120,
		maxX: p.x + 120,
		minY: p.y - 120,
		maxY: p.y + 120,
		minZ: p.z - 150,
		maxZ: p.z + 150,
	};
}

/** True iff two AABBs overlap or touch on all three axes. */
export function aabbIntersect(a: BoundingBox, b: BoundingBox): boolean {
	return (
		a.minX <= b.maxX && a.maxX >= b.minX &&
		a.minY <= b.maxY && a.maxY >= b.minY &&
		a.minZ <= b.maxZ && a.maxZ >= b.minZ
	);
}
