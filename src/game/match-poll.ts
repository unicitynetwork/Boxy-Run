/**
 * REST polling for match state — the ONLY flow driver.
 * WS is never relied on for state transitions.
 *
 * The server's `lastGameResult` (scoreA, scoreB, winner) is the single
 * source of truth for "a game just ended and here are the scores."
 * No client-side replay, no dead/live score tracking.
 *
 * Every callback is one-shot: once fired, it won't fire again until
 * the condition resets (e.g. new game, new phase). This prevents the
 * 1s poll interval from hammering the same callback repeatedly.
 */

export type NetworkStatus = 'ok' | 'warning' | 'error';

export interface PollCallbacks {
	getPhase: () => string;
	getMySide: () => 'A' | 'B';
	getPlayerName: () => string;
	getCurrentGameNumber: () => number;
	getReadyDeadline: () => number;
	onMatchComplete: (s: any) => void;
	onSeriesAdvance: (s: any) => void;
	onBothReady: () => void;
	onForceStart?: () => void;
	onReadyExpired: () => void;
	onGameResult: (result: { scoreA: number; scoreB: number; winner: string }) => void;
	/** Opponent died with this score. Client should stop if ahead. */
	onOpponentDead?: (oppScore: number) => void;
	getMyScore?: () => number;
	onIncomingChallenge?: (challenge: any) => void;
	onPollResult?: (info: string) => void;
	onNetworkStatus?: (status: NetworkStatus) => void;
}

export function startStatePoll(stateUrl: string, cb: PollCallbacks): ReturnType<typeof setInterval> {
	let consecutiveFailures = 0;
	let polling = false; // Prevent overlapping async polls

	// One-shot flags — each callback fires at most once per condition.
	// Reset when the condition changes (new game, new phase, etc.).
	let firedMatchComplete = false;
	let firedSeriesAdvance = 0; // tracks the game number we last advanced to
	let firedBothReady = false;
	let firedForceStart = false;
	let firedReadyExpired = false;
	let firedGameResult = false;

	return setInterval(async () => {
		if (polling) return;
		polling = true;
		try {
			await pollOnce();
		} finally {
			polling = false;
		}
	}, 1000);

	async function pollOnce() {
		// In series_end, poll for incoming rematch challenges instead
		if (cb.getPhase() === 'series_end') {
			try {
				const r = await fetch(`/api/challenges/pending?nametag=${encodeURIComponent(cb.getPlayerName())}`);
				if (!r.ok) return;
				const { challenges } = await r.json();
				if (challenges?.length > 0) {
					cb.onIncomingChallenge?.(challenges[0]);
				}
			} catch {}
			return;
		}
		try {
			const r = await fetch(stateUrl);
			if (!r.ok) {
				consecutiveFailures++;
				cb.onPollResult?.('err ' + r.status);
				cb.onNetworkStatus?.(consecutiveFailures >= 3 ? 'error' : 'warning');
				return;
			}
			consecutiveFailures = 0;
			cb.onNetworkStatus?.('ok');
			const s = await r.json();
			const lgr = s.lastGameResult ? `lgr:${s.lastGameResult.winner}` : '';
			cb.onPollResult?.(`${s.phase} rdy:${s.ready?.A?'A':''}${s.ready?.B?'B':''} done:${s.done?.A?'A':''}${s.done?.B?'B':''} g${s.series?.currentGame ?? '-'} ${lgr}`);

			// 1. Match complete → show final result (once).
			if (s.phase === 'complete' && s.winner && !firedMatchComplete) {
				firedMatchComplete = true;
				cb.onMatchComplete(s);
				return;
			}

			// 2. Series advanced → show game result, reset for next game.
			//    Fire once per game number advance.
			const serverGame = s.series?.currentGame ?? 0;
			if (s.series && serverGame > cb.getCurrentGameNumber()
					&& firedSeriesAdvance < serverGame) {
				firedSeriesAdvance = serverGame;
				// Reset one-shot flags for the new game
				firedBothReady = false;
				firedForceStart = false;
				firedReadyExpired = false;
				firedGameResult = false;
				cb.onSeriesAdvance(s);
				return;
			}

			const phase = cb.getPhase();

			// 3. Server already playing but we're stuck pre-game (once).
			if (s.machinePhase === 'playing'
					&& (phase === 'waiting' || phase === 'ready_prompt')
					&& !firedForceStart) {
				firedForceStart = true;
				cb.onForceStart?.();
				return;
			}

			// 4. Both ready → countdown (once).
			if (s.ready?.A && s.ready?.B
					&& (phase === 'waiting' || phase === 'ready_prompt')
					&& !firedBothReady) {
				firedBothReady = true;
				cb.onBothReady();
				return;
			}

			// 5. Ready expired (once, only after deadline passed).
			if (phase === 'waiting' && s.ready && !s.ready.A && !s.ready.B
					&& Date.now() > cb.getReadyDeadline()
					&& !firedReadyExpired) {
				firedReadyExpired = true;
				cb.onReadyExpired();
				return;
			}

			// 6. Game resolved — server has both scores. No machinePhase
			//    check needed; firedGameResult + series advance reset
			//    prevents stale results from the previous game.
			if (s.lastGameResult && !firedGameResult
					&& (phase === 'playing' || phase === 'done_sent')) {
				firedGameResult = true;
				cb.onGameResult(s.lastGameResult);
				return;
			}

			// 7. Opponent died but game not yet resolved — show their
			//    score so I can see the target or early-decide.
			if (s.deadScores && !firedGameResult
					&& (phase === 'playing' || phase === 'done_sent')) {
				const oppSide = cb.getMySide() === 'A' ? 'B' : 'A';
				const oppDeadScore = s.deadScores[oppSide];
				if (oppDeadScore !== null && oppDeadScore !== undefined) {
					cb.onOpponentDead?.(oppDeadScore);
				}
			}

		} catch {}
	}
}

export function startMatchRedirectPoll(opts: {
	playerName: string;
	backUrl: string;
	lastWager: number;
	onExpired: () => void;
	onBeforeRedirect?: () => void;
}): { stop: () => void } {
	let stopped = false;
	const poll = setInterval(async () => {
		if (stopped) return;
		try {
			const r = await fetch('/api/tournaments');
			if (!r.ok) return;
			const { tournaments } = await r.json();
			for (const t of tournaments) {
				if (t.status !== 'active' || !t.id.startsWith('challenge-')) continue;
				if (stopped) return;
				const br = await fetch(`/api/tournaments/${encodeURIComponent(t.id)}/bracket`);
				if (!br.ok) continue;
				const { matches } = await br.json();
				const m = matches?.find((m: any) =>
					(m.playerA === opts.playerName || m.playerB === opts.playerName)
					&& (m.status === 'ready_wait' || m.status === 'active'),
				);
				if (m && m.seed) {
					stopped = true;
					clearInterval(poll);
					opts.onBeforeRedirect?.();
					const side = m.playerA === opts.playerName ? 'A' : 'B';
					const opp = side === 'A' ? m.playerB : m.playerA;
					const p = new URLSearchParams({
						tournament: '1', matchId: m.id, seed: m.seed,
						side, opponent: opp, name: opts.playerName,
						tid: t.id, bestOf: String(t.best_of || 1),
						wager: String(opts.lastWager), startsAt: String(Date.now() + 3000),
					});
					location.href = 'dev.html?' + p;
					return;
				}
			}
		} catch {}
	}, 1000);

	const timeout = setTimeout(() => {
		if (!stopped) {
			stopped = true;
			clearInterval(poll);
			opts.onExpired();
		}
	}, 35000);

	return {
		stop() {
			stopped = true;
			clearInterval(poll);
			clearTimeout(timeout);
		},
	};
}
