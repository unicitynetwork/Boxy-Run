/**
 * REST polling for match state — the ONLY flow driver.
 * WS is never relied on for state transitions.
 */

export interface PollCallbacks {
	getPhase: () => string;
	getMySide: () => 'A' | 'B';
	getPlayerName: () => string;
	getCurrentGameNumber: () => number;
	getCurrentWins: () => { a: number; b: number };
	getReadyDeadline: () => number;
	onMatchComplete: (s: any) => void;
	onSeriesAdvance: (s: any) => void;
	onBothReady: () => void;
	onReadyExpired: () => void;
	onGameDecided: (opponentScore: number) => void;
	getMyScore: () => number;
	onIncomingChallenge?: (challenge: any) => void;
}

export function startStatePoll(stateUrl: string, cb: PollCallbacks): ReturnType<typeof setInterval> {
	return setInterval(async () => {
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
			if (!r.ok) return;
			const s = await r.json();

			// 1. Match complete → show result.
			if (s.phase === 'complete' && s.winner) {
				cb.onMatchComplete(s);
				return;
			}

			// 2. Series advanced → show game result, reset.
			if (s.series && s.series.currentGame > cb.getCurrentGameNumber()) {
				cb.onSeriesAdvance(s);
				return;
			}

			// 3. Both ready → countdown (not during game_result overlay).
			const phase = cb.getPhase();
			if (s.ready?.A && s.ready?.B
					&& (phase === 'waiting' || phase === 'ready_prompt')) {
				cb.onBothReady();
				return;
			}

			// 4. Ready expired (only after deadline passed).
			if (phase === 'waiting' && s.ready && !s.ready.A && !s.ready.B
					&& Date.now() > cb.getReadyDeadline()) {
				cb.onReadyExpired();
				return;
			}

			// 5. Opponent dead + my score beats their replay score → decided.
			//    deadScore is computed by the server from the dead player's
			//    stored inputs. This is authoritative — no client guessing.
			if (phase === 'playing' && s.deadScore) {
				const oppSide = cb.getMySide() === 'A' ? 'B' : 'A';
				if (s.deadScore.side === oppSide && cb.getMyScore() > s.deadScore.score) {
					cb.onGameDecided(s.deadScore.score);
					return;
				}
			}

		} catch {}
	}, 1000);
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
				const br = await fetch(`/api/tournaments/${encodeURIComponent(t.id)}/bracket`);
				if (!br.ok) continue;
				const { matches } = await br.json();
				const m = matches?.find((m: any) =>
					(m.playerA === opts.playerName || m.playerB === opts.playerName)
					&& (m.status === 'ready_wait' || m.status === 'active'),
				);
				if (m) {
					stopped = true;
					clearInterval(poll);
					opts.onBeforeRedirect?.();
					const side = m.playerA === opts.playerName ? 'A' : 'B';
					const opp = side === 'A' ? m.playerB : m.playerA;
					const p = new URLSearchParams({
						tournament: '1', matchId: m.id, seed: m.seed || '0',
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
