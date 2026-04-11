/**
 * Sim state for Boxy Run. Pure data — no Three.js, no DOM, no `window`.
 *
 * Every field on GameState is either a sim variable mutated by tick(), or
 * a cached value derived from other sim state. Visual-only state (limb
 * rotations, mesh spin, camera tween targets) does NOT live here; the
 * renderer derives those from sim state at draw time.
 *
 * The sim mutates GameState in place for performance. If you need a
 * checkpoint, deep-clone explicitly.
 */

/** Simulation tick rate. One tick = 1/60 second of game time. */
export const TICK_HZ = 60;
export const TICK_SECONDS = 1 / TICK_HZ;

/**
 * Discrete player actions. Queued in CharacterState.queuedActions and
 * consumed FIFO by tick(). Lane switches are rejected here if the
 * character is already at the edge; jumps are rejected if the character
 * is already jumping or switching lanes.
 */
export type CharacterAction = 'up' | 'left' | 'right';

/** A tick-tagged input event from a player, as relayed over the wire. */
export interface InputEvent {
	readonly tick: number;
	readonly action: CharacterAction;
}

/** Sim state for the player character. */
export interface CharacterState {
	/** Horizontal position. Changes while switching lanes. */
	x: number;
	/** Vertical position. Changes while jumping; used for tree collision. */
	y: number;
	isJumping: boolean;
	isSwitchingLeft: boolean;
	isSwitchingRight: boolean;
	/** -1 (left), 0 (center), 1 (right). */
	currentLane: -1 | 0 | 1;
	/** Tick at which the current running animation cycle began. Advanced after each jump. */
	runningStartTick: number;
	/** Tick at which the current jump began (undefined semantics when not jumping). */
	jumpStartTick: number;
	/** Actions waiting to be applied. Consumed FIFO in tick(). */
	queuedActions: CharacterAction[];
}

/** Sim state for a tree obstacle. */
export interface TreeState {
	x: number;
	y: number;
	z: number;
	scale: number;
}

/** Sim state for a coin pickup. */
export interface CoinState {
	x: number;
	y: number;
	z: number;
	collected: boolean;
}

/**
 * Complete sim state. Everything needed to run the game deterministically.
 * tick() mutates this in place.
 */
export interface GameState {
	/** 32-bit seed used to build the RNG. Set at init, never mutated. */
	readonly seed: number;

	/** Current mulberry32 internal state. Advanced on every rngNext() call. */
	rngState: number;

	/** Monotonic sim tick counter. Advances exactly once per tick() call. */
	tick: number;

	/** Player score. Monotonically non-decreasing until gameOver. */
	score: number;

	/** Coins collected this run. */
	coinCount: number;

	/** True once the character has collided with a tree. Sim halts thereafter. */
	gameOver: boolean;

	/** Difficulty level. Increments when a new tree row is spawned. */
	difficulty: number;

	/** Current per-lane probability that a tree spawns. Adjusted by level. */
	treePresenceProb: number;

	/** Current max tree scale factor. Adjusted by level. */
	maxTreeSize: number;

	/** Fog distance. Sim state so renderer and sim agree on visual range. */
	fogDistance: number;

	/** Z position of the most recently spawned tree row. */
	lastTreeRowZ: number;

	/** Active tree obstacles. Spawn-ordered. Filtered when they move off-screen. */
	trees: TreeState[];

	/** Active coins. Same semantics as trees. */
	coins: CoinState[];

	/** Player character state. */
	character: CharacterState;
}

/**
 * Game constants. Read-only, set once, do not belong on GameState.
 * Kept separate so a state snapshot stays small.
 */
export interface GameConfig {
	/** World motion speed in units per second. Trees/coins move toward the player at this rate. */
	readonly moveSpeed: number;
	/** Minimum z-distance between successive tree rows. */
	readonly spawnDistance: number;
	/** Fixed integer score awarded per tick while alive. */
	readonly scorePerTick: number;
	/** Jump duration in seconds. */
	readonly jumpDuration: number;
	/** Jump peak height in world units. */
	readonly jumpHeight: number;
	/** Running animation frequency in Hz. Cosmetic only; used by renderer. */
	readonly characterStepFreq: number;
	/** Distance between adjacent lanes in world units. */
	readonly laneWidth: number;
	/** Horizontal speed during a lane switch, units per second. */
	readonly laneSwitchSpeed: number;
}

/**
 * Default config matching the existing Boxy Run balance. Changing these
 * values changes the game feel. Changing them mid-run breaks determinism
 * unless the config is also part of the tournament match seed input —
 * which is why it is an immutable object, not part of GameState.
 */
export const DEFAULT_CONFIG: GameConfig = {
	moveSpeed: 10000,
	spawnDistance: 4500,
	// Matches the original `Math.floor(600 * (moveSpeed / 6000) / TICK_HZ)` = 16.
	scorePerTick: Math.floor((600 * (10000 / 6000)) / TICK_HZ),
	jumpDuration: 0.6,
	jumpHeight: 2000,
	characterStepFreq: 2,
	laneWidth: 800,
	laneSwitchSpeed: 4000,
};
