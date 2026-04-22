/**
 * Bot-driven end-to-end tournament test.
 *
 * Spawns the real `scripts/bot-players.ts` subprocess (same one used
 * against prod) and pits it against a freshly booted local server.
 * The test verifies a full Bo3 tournament actually plays through — each
 * match runs its series, the bracket advances, and a champion is
 * crowned. This is the test shape that would have caught the recent
 * regressions (series input tagging, bot-side game-number tracking,
 * match-start missing gameNumber) before they reached production.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
	api,
	assert,
	assertEqual,
	runTest,
	sleep,
	startServer,
	stopServer,
} from './harness';

const REPO_ROOT = join(__dirname, '..', '..');
const BOT_SCRIPT = join(REPO_ROOT, 'scripts', 'bot-players.ts');

interface BotProc {
	proc: ChildProcess;
	stop: () => Promise<void>;
}

function spawnBots(tournamentId: string, count: number, port: number): BotProc {
	const proc = spawn(
		'npx',
		['tsx', BOT_SCRIPT, tournamentId, String(count), `127.0.0.1:${port}`],
		{ stdio: ['ignore', 'pipe', 'pipe'] },
	);
	const logs: string[] = [];
	proc.stdout?.on('data', (c) => { logs.push(c.toString()); });
	proc.stderr?.on('data', (c) => { logs.push('[stderr] ' + c.toString()); });
	return {
		proc,
		stop: () => new Promise((resolve) => {
			if (process.env.DEBUG_BOTS) {
				process.stderr.write('\n── bot output ──\n' + logs.join('') + '────\n');
			}
			if (proc.exitCode !== null) return resolve();
			proc.on('exit', () => resolve());
			proc.kill('SIGTERM');
			setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 2000);
		}),
	};
}

async function waitForTournamentComplete(
	server: { port: number }, tournamentId: string, timeoutMs: number,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const t = await api(server, `/api/tournaments/${tournamentId}`) as any;
		if (t.status === 'complete') {
			// Find the final match → winner
			const bracket = await api(server, `/api/tournaments/${tournamentId}/bracket`) as any;
			const maxRound = Math.max(...bracket.matches.map((m: any) => m.round as number));
			const final = bracket.matches.find((m: any) => m.round === maxRound && m.winner);
			return final?.winner as string;
		}
		await sleep(500);
	}
	throw new Error(`tournament ${tournamentId} did not complete within ${timeoutMs}ms`);
}

runTest('bot-e2e: 2-bot Bo3 tournament completes with a champion', async () => {
	const server = await startServer();
	const bots = spawnBots('bote2e-bo3-2p', 2, server.port);
	try {
		// Create the tournament up-front so bots can register as soon as they
		// spawn. startsAt in the past → auto-starts once minimum players fill.
		await api(server, '/api/tournaments', {
			method: 'POST', asAdmin: true,
			body: {
				id: 'bote2e-bo3-2p',
				name: 'Bot E2E Bo3',
				maxPlayers: 2,
				bestOf: 3,
				startsAt: new Date(Date.now() - 1000).toISOString(),
				entryFee: 0,
			},
		});

		// Play-out budget: Bo3 with 2 bots = 1 match × 2-3 games × up to 40s
		// + 4s series-next delay × up to 2 gaps + ready-TTL recovery.
		const champion = await waitForTournamentComplete(server, 'bote2e-bo3-2p', 240_000);
		assert(champion, 'tournament has a champion');
		// Bot names come from the CRYPTO_NAMES list in bot-players.ts
		// (e.g., satoshi_og, vitalik_fan), not "bot_N" prefixed.
		assert(typeof champion === 'string' && champion.length > 0, `champion is a non-empty string, got ${champion}`);

		// Bo3 invariant: the final match's score reflects series wins.
		// `scoreA + scoreB` should be between 2 and 3 (at least 2 wins for
		// champion, at most 3 games played).
		const bracket = await api(server, `/api/tournaments/bote2e-bo3-2p/bracket`) as any;
		const final = bracket.matches.find((m: any) => m.status === 'complete');
		assert(final, 'final match found');
		const totalGames = (final.scoreA as number) + (final.scoreB as number);
		assert(
			totalGames >= 2 && totalGames <= 3,
			`Bo3 final had ${totalGames} series wins total (expected 2 or 3) — scoreA=${final.score_a} scoreB=${final.score_b}`,
		);
	} finally {
		await bots.stop();
		await stopServer(server.proc);
	}
});

runTest('bot-e2e: 4-bot Bo3 tournament reaches champion through bracket', async () => {
	const server = await startServer();
	const bots = spawnBots('bote2e-bo3-4p', 4, server.port);
	try {
		await api(server, '/api/tournaments', {
			method: 'POST', asAdmin: true,
			body: {
				id: 'bote2e-bo3-4p',
				name: 'Bot E2E Bo3 4p',
				maxPlayers: 4,
				bestOf: 3,
				startsAt: new Date(Date.now() - 1000).toISOString(),
				entryFee: 0,
			},
		});

		// 4 players = 2 semis + 1 final = 3 matches, each Bo3 → up to 9 games
		// × up to 40s each + series-next delays + ready-TTL recoveries.
		const champion = await waitForTournamentComplete(server, 'bote2e-bo3-4p', 420_000);
		assert(champion, 'tournament has a champion');

		// Every match should be COMPLETE (no force-resolve forfeits).
		const bracket = await api(server, `/api/tournaments/bote2e-bo3-4p/bracket`) as any;
		const matches = bracket.matches as any[];
		assertEqual(matches.length, 3, 'expected 3 matches in a 4-player Bo3 bracket');
		for (const m of matches) {
			assertEqual(m.status, 'complete', `match ${m.id} is not complete`);
			assert(m.winner, `match ${m.id} has no winner`);
			const total = (m.scoreA as number) + (m.scoreB as number);
			assert(
				total >= 2 && total <= 3,
				`match ${m.id} series total = ${total} (expected 2-3)`,
			);
		}
	} finally {
		await bots.stop();
		await stopServer(server.proc);
	}
});
