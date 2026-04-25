/**
 * Level definitions for single-player campaign mode.
 *
 * All levels run at the same speed (DEFAULT_CONFIG). Each lasts about
 * 1 minute (~130 tree rows). Difficulty comes from tree density, size,
 * fog, and objectives — not speed.
 *
 * Levels use fixed seeds so the same obstacles appear every attempt,
 * letting players learn and master each layout.
 *
 * Levels complete as soon as ALL objectives are met — you don't need
 * to reach the finish line. Die with 20 coins collected? Still counts.
 */

export interface LevelObjective {
	type: 'collect_coins' | 'collect_red' | 'collect_blue' | 'use_flame' | 'score';
	target: number;
	label: string;
}

export interface ScriptedSpawn {
	atRow: number;
	type: 'coin' | 'powerup';
	lane: -1 | 0 | 1;
	tier?: 'gold' | 'blue' | 'red';
}

export interface LevelDef {
	id: number;
	season: number;
	name: string;
	description: string;
	seed: number;
	/** Number of tree rows to spawn before the finish line. ~130 = 1 minute. */
	totalRows: number;
	/** What the player must achieve. All must be met. */
	objectives: LevelObjective[];
	/** Initial difficulty overrides. */
	initial: {
		treePresenceProb: number;
		maxTreeSize: number;
		fogDistance: number;
	};
	/** Guaranteed item spawns at specific rows. */
	spawns?: ScriptedSpawn[];
}

export interface Season {
	id: number;
	name: string;
	description: string;
	levels: LevelDef[];
}

export const LEVELS: LevelDef[] = [
	{
		id: 1,
		season: 1,
		name: 'First Run',
		description: 'Easy forest. Survive and score 20,000.',
		seed: 1001,
		totalRows: 130,
		objectives: [
			{ type: 'score', target: 20000, label: 'Score 20,000' },
		],
		initial: { treePresenceProb: 0.25, maxTreeSize: 0.5, fogDistance: 80000 },
	},
	{
		id: 2,
		season: 1,
		name: 'Coin Hunter',
		description: 'Collect 20 coins while dodging trees.',
		seed: 2002,
		totalRows: 130,
		objectives: [
			{ type: 'collect_coins', target: 20, label: 'Collect 20 coins' },
		],
		initial: { treePresenceProb: 0.30, maxTreeSize: 0.55, fogDistance: 65000 },
	},
	{
		id: 3,
		season: 1,
		name: 'Seeing Red',
		description: 'Red coins are rare and worth 5,000 points. Find 2.',
		seed: 3003,
		totalRows: 130,
		objectives: [
			{ type: 'collect_red', target: 2, label: 'Collect 2 red coins' },
		],
		initial: { treePresenceProb: 0.25, maxTreeSize: 0.5, fogDistance: 60000 },
		spawns: [
			{ atRow: 30, type: 'coin', lane: 0, tier: 'red' },
			{ atRow: 70, type: 'coin', lane: -1, tier: 'red' },
			{ atRow: 110, type: 'coin', lane: 1, tier: 'red' },
		],
	},
	{
		id: 4,
		season: 1,
		name: 'Dense Forest',
		description: 'Trees pack tight. Survive long enough to score 30,000.',
		seed: 4004,
		totalRows: 130,
		objectives: [
			{ type: 'score', target: 30000, label: 'Score 30,000' },
		],
		initial: { treePresenceProb: 0.55, maxTreeSize: 0.95, fogDistance: 50000 },
	},
	{
		id: 5,
		season: 1,
		name: 'Burn It Down',
		description: 'Collect flamethrowers and clear the path. Use fire 3 times.',
		seed: 5005,
		totalRows: 130,
		objectives: [
			{ type: 'use_flame', target: 3, label: 'Use flamethrower 3 times' },
		],
		initial: { treePresenceProb: 0.35, maxTreeSize: 0.85, fogDistance: 60000 },
		spawns: [
			{ atRow: 20, type: 'powerup', lane: 0 },
			{ atRow: 50, type: 'powerup', lane: 1 },
			{ atRow: 80, type: 'powerup', lane: -1 },
			{ atRow: 105, type: 'powerup', lane: 0 },
		],
	},
	{
		id: 6,
		season: 1,
		name: 'Blue Streak',
		description: 'Blue coins hide in tricky spots. Grab 5 of them.',
		seed: 6006,
		totalRows: 130,
		objectives: [
			{ type: 'collect_blue', target: 5, label: 'Collect 5 blue coins' },
		],
		initial: { treePresenceProb: 0.30, maxTreeSize: 0.6, fogDistance: 55000 },
		spawns: [
			{ atRow: 15, type: 'coin', lane: 1, tier: 'blue' },
			{ atRow: 35, type: 'coin', lane: -1, tier: 'blue' },
			{ atRow: 55, type: 'coin', lane: 0, tier: 'blue' },
			{ atRow: 80, type: 'coin', lane: 1, tier: 'blue' },
			{ atRow: 100, type: 'coin', lane: -1, tier: 'blue' },
			{ atRow: 120, type: 'coin', lane: 0, tier: 'blue' },
		],
	},
	{
		id: 7,
		season: 1,
		name: 'Fogbound',
		description: 'Visibility is low. Score 35,000 blind.',
		seed: 7007,
		totalRows: 130,
		objectives: [
			{ type: 'score', target: 35000, label: 'Score 35,000' },
		],
		initial: { treePresenceProb: 0.45, maxTreeSize: 0.9, fogDistance: 18000 },
	},
	{
		id: 8,
		season: 1,
		name: 'Red Rush',
		description: 'Dense forest, big trees. Hunt down 3 red coins.',
		seed: 8008,
		totalRows: 130,
		objectives: [
			{ type: 'collect_red', target: 3, label: 'Collect 3 red coins' },
		],
		initial: { treePresenceProb: 0.45, maxTreeSize: 0.9, fogDistance: 45000 },
		spawns: [
			{ atRow: 25, type: 'coin', lane: 1, tier: 'red' },
			{ atRow: 60, type: 'coin', lane: -1, tier: 'red' },
			{ atRow: 95, type: 'coin', lane: 0, tier: 'red' },
			{ atRow: 120, type: 'coin', lane: 1, tier: 'red' },
		],
	},
	{
		id: 9,
		season: 1,
		name: 'Inferno',
		description: 'Maximum density. Burn your way through — 5 flamethrowers.',
		seed: 9009,
		totalRows: 130,
		objectives: [
			{ type: 'use_flame', target: 5, label: 'Use flamethrower 5 times' },
		],
		initial: { treePresenceProb: 0.50, maxTreeSize: 1.0, fogDistance: 35000 },
		spawns: [
			{ atRow: 10, type: 'powerup', lane: 0 },
			{ atRow: 30, type: 'powerup', lane: 1 },
			{ atRow: 50, type: 'powerup', lane: -1 },
			{ atRow: 70, type: 'powerup', lane: 0 },
			{ atRow: 90, type: 'powerup', lane: 1 },
			{ atRow: 110, type: 'powerup', lane: -1 },
		],
	},
	{
		id: 10,
		season: 1,
		name: 'The Gauntlet',
		description: 'Everything at max. Score 40K to survive.',
		seed: 10010,
		totalRows: 200,
		objectives: [
			{ type: 'score', target: 40000, label: 'Score 40,000' },
		],
		initial: { treePresenceProb: 0.55, maxTreeSize: 1.25, fogDistance: 15000 },
		spawns: [
			{ atRow: 30, type: 'coin', lane: 0, tier: 'red' },
			{ atRow: 70, type: 'coin', lane: -1, tier: 'red' },
			{ atRow: 110, type: 'coin', lane: 1, tier: 'red' },
			{ atRow: 130, type: 'coin', lane: 0, tier: 'red' },
		],
	},
];

export const SEASONS: Season[] = [
	{
		id: 1,
		name: 'Season 1: Winter Forest',
		description: 'Master the frozen trails. 10 levels of increasing difficulty.',
		levels: LEVELS.filter(l => l.season === 1),
	},
];

/** Get the season a level belongs to. */
export function getSeasonForLevel(levelId: number): Season | undefined {
	return SEASONS.find(s => s.levels.some(l => l.id === levelId));
}

/** Check if all objectives are met. */
export function checkObjectives(level: LevelDef, state: {
	score: number;
	coinCount: number;
	redCollected: number;
	blueCollected: number;
	flamethrowerUses: number;
}): { met: boolean; results: Array<{ label: string; current: number; target: number; done: boolean }> } {
	const results = level.objectives.map(obj => {
		let current = 0;
		switch (obj.type) {
			case 'collect_coins': current = state.coinCount; break;
			case 'collect_red': current = state.redCollected; break;
			case 'collect_blue': current = state.blueCollected; break;
			case 'use_flame': current = state.flamethrowerUses; break;
			case 'score': current = state.score; break;
		}
		return { label: obj.label, current, target: obj.target, done: current >= obj.target };
	});
	return { met: results.every(r => r.done), results };
}

export function getUnlockedLevel(): number {
	try {
		const v = localStorage.getItem('boxyrun-level-unlocked');
		return v ? Math.max(1, parseInt(v, 10) || 1) : 1;
	} catch { return 1; }
}

export function completeLevel(levelId: number): void {
	try {
		const current = getUnlockedLevel();
		if (levelId >= current && levelId < LEVELS.length) {
			localStorage.setItem('boxyrun-level-unlocked', String(levelId + 1));
		}
	} catch {}
}

export function getLevelBest(levelId: number): number {
	try {
		const v = localStorage.getItem(`boxyrun-level-${levelId}-best`);
		return v ? parseInt(v, 10) || 0 : 0;
	} catch { return 0; }
}

export function saveLevelBest(levelId: number, score: number): void {
	try {
		const current = getLevelBest(levelId);
		if (score > current) {
			localStorage.setItem(`boxyrun-level-${levelId}-best`, String(score));
		}
	} catch {}
}
