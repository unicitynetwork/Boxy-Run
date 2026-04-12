/**
 * Unit tests for bracket generation. Pure functions, no server needed.
 */

import {
	generateBracket,
	hashString,
	nextPowerOfTwo,
} from '../server/bracket';
import { assert, assertEqual, runTest } from './harness';

runTest('bracket generation', async () => {
	// ── hashString is deterministic ──
	assertEqual(
		hashString('boxyrun-alpha-1'),
		hashString('boxyrun-alpha-1'),
		'hashString stable',
	);
	assert(
		hashString('a') !== hashString('b'),
		'hashString differs for different inputs',
	);

	// ── nextPowerOfTwo ──
	assertEqual(nextPowerOfTwo(1), 1);
	assertEqual(nextPowerOfTwo(2), 2);
	assertEqual(nextPowerOfTwo(3), 4);
	assertEqual(nextPowerOfTwo(5), 8);
	assertEqual(nextPowerOfTwo(8), 8);
	assertEqual(nextPowerOfTwo(9), 16);
	assertEqual(nextPowerOfTwo(32), 32);
	assertEqual(nextPowerOfTwo(33), 64);

	// ── 2 players: 1 round with 1 match ──
	{
		const b = generateBracket(['@a', '@b'], 't');
		assertEqual(b.length, 1, 'N=2 → 1 round');
		assertEqual(b[0].length, 1, 'N=2 → 1 match in round 0');
		const slot = b[0][0];
		assert(
			(slot.playerA === '@a' && slot.playerB === '@b') ||
				(slot.playerA === '@b' && slot.playerB === '@a'),
			'N=2 both players placed',
		);
	}

	// ── 4 players: 2 rounds (R0 has 2 matches, R1 has 1) ──
	{
		const b = generateBracket(['@a', '@b', '@c', '@d'], 't');
		assertEqual(b.length, 2, 'N=4 → 2 rounds');
		assertEqual(b[0].length, 2, 'N=4 → 2 matches in round 0');
		assertEqual(b[1].length, 1, 'N=4 → 1 match in round 1');
		// Every slot in round 0 must be filled
		for (const match of b[0]) {
			assert(match.playerA !== null, 'R0 playerA filled');
			assert(match.playerB !== null, 'R0 playerB filled');
		}
		// Round 1 must be all TBD
		assertEqual(b[1][0].playerA, null);
		assertEqual(b[1][0].playerB, null);
		// All four names accounted for
		const names = new Set([
			b[0][0].playerA,
			b[0][0].playerB,
			b[0][1].playerA,
			b[0][1].playerB,
		]);
		assertEqual(
			[...names].sort(),
			['@a', '@b', '@c', '@d'],
			'N=4 all players present',
		);
	}

	// ── 5 players: padded to 8, so round 0 has 4 matches with 3 byes ──
	{
		const b = generateBracket(['@a', '@b', '@c', '@d', '@e'], 't');
		assertEqual(b.length, 3, 'N=5 → 3 rounds');
		assertEqual(b[0].length, 4, 'N=5 → 4 matches in round 0 (padded)');
		assertEqual(b[1].length, 2, 'N=5 → 2 matches in round 1');
		assertEqual(b[2].length, 1, 'N=5 → 1 match in round 2 (final)');
		// Exactly 5 non-null slots in round 0 (3 byes = 3 null opponents)
		let filled = 0;
		let byes = 0;
		for (const match of b[0]) {
			if (match.playerA !== null) filled++;
			if (match.playerB !== null) filled++;
			if (match.playerA === null || match.playerB === null) byes++;
		}
		assertEqual(filled, 5, 'N=5 → 5 player slots filled');
		assertEqual(byes, 3, 'N=5 → 3 byes');
	}

	// ── 8 players: 3 rounds, no byes ──
	{
		const b = generateBracket(
			['@a', '@b', '@c', '@d', '@e', '@f', '@g', '@h'],
			't',
		);
		assertEqual(b.length, 3, 'N=8 → 3 rounds');
		assertEqual(b[0].length, 4);
		assertEqual(b[1].length, 2);
		assertEqual(b[2].length, 1);
		for (const m of b[0]) {
			assert(m.playerA !== null && m.playerB !== null, 'N=8 no byes');
		}
	}

	// ── 32 players: 5 rounds, all filled ──
	{
		const players = Array.from({ length: 32 }, (_, i) => `@p${i}`);
		const b = generateBracket(players, 'boxyrun-alpha-1');
		assertEqual(b.length, 5, 'N=32 → 5 rounds');
		assertEqual(b[0].length, 16);
		assertEqual(b[1].length, 8);
		assertEqual(b[2].length, 4);
		assertEqual(b[3].length, 2);
		assertEqual(b[4].length, 1);
		const allNames: string[] = [];
		for (const m of b[0]) {
			assert(m.playerA !== null && m.playerB !== null, 'N=32 no byes');
			allNames.push(m.playerA as string, m.playerB as string);
		}
		assertEqual(allNames.sort(), players.sort(), 'N=32 all present');
	}

	// ── Determinism: same input → same bracket ──
	{
		const a = generateBracket(['@a', '@b', '@c', '@d'], 't');
		const b = generateBracket(['@a', '@b', '@c', '@d'], 't');
		assertEqual(
			JSON.stringify(a),
			JSON.stringify(b),
			'same seed → same bracket',
		);
	}

	// ── Different tournamentId → different shuffle (usually) ──
	{
		const a = generateBracket(['@a', '@b', '@c', '@d'], 'tournament-1');
		const b = generateBracket(['@a', '@b', '@c', '@d'], 'tournament-2');
		// They might occasionally coincide for tiny inputs, but with 4
		// players the space is 24 permutations; different seeds almost
		// always differ. If this ever flakes, pick different seed strings.
		assert(
			JSON.stringify(a) !== JSON.stringify(b),
			'different tournamentId usually produces different bracket',
		);
	}

	// ── matchIds are unique and follow the R{round}M{idx} convention ──
	{
		const b = generateBracket(
			['@a', '@b', '@c', '@d', '@e', '@f', '@g', '@h'],
			't',
		);
		const ids = new Set<string>();
		for (let r = 0; r < b.length; r++) {
			for (let m = 0; m < b[r].length; m++) {
				const id = b[r][m].matchId;
				assert(!ids.has(id), `duplicate matchId: ${id}`);
				ids.add(id);
				assertEqual(id, `R${r}M${m}`, 'matchId format');
			}
		}
	}
});
