/**
 * Boxy Run entry point. Supports two modes:
 *
 * **Single-player** (default): keyboard controls, one seed per session.
 *   URL: /dev.html?seed=42
 *
 * **Tournament mode**: connects to a tournament server, joins a lobby,
 *   plays a live 1v1 match. Both sims (own + opponent) run locally
 *   from the shared match seed.
 *   URL: /dev.html?tournament=1&name=@alice&server=ws://localhost:7101
 *
 * In tournament mode, inputs are streamed over the wire. The opponent's
 * inputs are applied to a second local sim. When either character dies,
 * the match result is computed from both sims and submitted for hash
 * agreement.
 */

import {
	createScene,
	renderFrame,
	type SceneHandle,
	addOpponentMesh,
	createRenderState,
	removeOpponentMesh,
	syncOpponent,
	syncRender,
	type RenderState,
} from './renderer';
import { makeInitialState } from '../sim/init';
import {
	DEFAULT_CONFIG,
	TICK_SECONDS,
	type CharacterAction,
	type GameConfig,
} from '../sim/state';
import { tick } from '../sim/tick';
import { getSkin, type CharacterSkin } from '../render/skins';
import { showSkinSelector } from './skin-selector';
import { connectMatchWS } from './match-ws';
import { createChatPanel } from './match-chat';
import { startStatePoll } from './match-poll';
import { LEVELS, checkObjectives, completeLevel, saveLevelBest, type LevelDef } from './levels';
import {
	showOverlay,
	hideOverlay,
	updateOpponentHud,
	removeOpponentHud,
	showDeathBanner,
	removeDeathBanner,
	installTouchControls,
} from './ui';
import {
	initAudio,
	resumeAudio,
	playBeep,
	playCoinCollect,
	playCrash,
	playFlameActivate,
	playGameStart,
	playJump,
	playLaneSwitch,
	playPowerupCollect,
} from '../render/audio';

// ── Sphere wallet bridge ─────────────────────────────────────────
// sphere-connect.ts (loaded before this script) exposes
// window.SphereWallet. These helpers wrap it so the rest of the code
// doesn't need to null-check repeatedly.
interface SphereWallet {
	isConnected: boolean;
	isDepositPaid: boolean;
	identity: { nametag?: string } | null;
	coinId: string;
	entryFee: number;
	updateUI(phase: string): void;
	requestPayout(coins: number): void;
	resetDeposit(): void;
	depositAndRestart(): void;
}

function getWallet(): SphereWallet | null {
	return (window as any).SphereWallet ?? null;
}

function walletNametag(): string | null {
	return getWallet()?.identity?.nametag ?? null;
}

function walletCanPlay(): boolean {
	const w = getWallet();
	if (!w) return true; // no wallet = dev mode, allow playing
	return w.isDepositPaid;
}

// ── Game balance (server-side ledger) ────────────────────────────
const ENTRY_FEE = 10;
const STORAGE_KEY = 'boxyrun-nametag';

function getPlayerNametag(): string | null {
	return walletNametag() || localStorage.getItem(STORAGE_KEY);
}

async function fetchGameBalance(): Promise<number | null> {
	const tag = getPlayerNametag();
	if (!tag) return null;
	try {
		const r = await fetch('/api/balance/' + encodeURIComponent(tag));
		const d = await r.json();
		return typeof d.balance === 'number' ? d.balance : 0;
	} catch { return null; }
}

async function deductEntryFee(): Promise<boolean> {
	const tag = getPlayerNametag();
	if (!tag) return true; // no identity = dev mode, allow
	try {
		const r = await fetch('/api/deposit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ nametag: tag, amount: -ENTRY_FEE }),
		});
		const d = await r.json();
		return d.status === 'ok';
	} catch { return false; }
}

function updateBalanceDisplay(balance: number | null) {
	const el = document.getElementById('balance');
	if (el) el.textContent = balance !== null ? balance.toLocaleString() + ' UCT' : '--';
}

// Key codes
const KEY_LEFT = 37;
const KEY_UP = 38;
const KEY_RIGHT = 39;
const KEY_P = 80;
const KEY_A = 65;
const KEY_W = 87;
const KEY_DOWN = 40;
const KEY_D = 68;
const KEY_F = 70;
const KEY_ENTER = 13;

window.addEventListener('load', () => {
	initAudio();
	const params = new URLSearchParams(location.search);
	const skinParam = params.get('skin');
	const isTournament = params.get('tournament') === '1';
	const hasMatchId = params.has('matchId');

	const savedSkin = localStorage.getItem('boxyrun-skin');
	const resolvedSkin = skinParam || savedSkin;

	function pickSkin(cb: (skin: CharacterSkin) => void) {
		if (resolvedSkin) {
			cb(getSkin(resolvedSkin));
		} else {
			showSkinSelector((skin) => {
				localStorage.setItem('boxyrun-skin', skin.name);
				cb(skin);
			});
		}
	}

	// Tournament / challenge match: seed + matchId in URL.
	if (isTournament && hasMatchId) {
		pickSkin((skin) => startMatch(params, skin));
		return;
	}

	// Level mode: ?level=N
	const levelParam = params.get('level');
	if (levelParam) {
		const levelId = parseInt(levelParam, 10);
		const levelDef = LEVELS.find(l => l.id === levelId);
		if (levelDef) {
			pickSkin((skin) => startLevel(levelDef, skin));
			return;
		}
	}

	// Single-player
	pickSkin((skin) => startSinglePlayer(params, skin));
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tournament / challenge match — seed in URL, WS for input relay
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function startMatch(params: URLSearchParams, skin: CharacterSkin) {
	const matchId = params.get('matchId')!;
	const mySide = (params.get('side') || 'A') as 'A' | 'B';
	let opponentName = params.get('opponent') || 'Opponent';
	const playerName = params.get('name') || 'Player';
	const tournamentId = params.get('tid') || '';
	const bestOf = parseInt(params.get('bestOf') || '1', 10);

	// Per-game state — mutated on series-next instead of navigating (preserves AudioContext)
	const seedHex = params.get('seed') || '0';
	let currentSeed = parseInt(seedHex, 16) >>> 0;
	console.log(`[seed] URL hex=${seedHex} parsed=${currentSeed}`);
	let currentGameNumber = parseInt(params.get('gameNum') || '1', 10);
	let currentWinsA = parseInt(params.get('winsA') || '0', 10);
	let currentWinsB = parseInt(params.get('winsB') || '0', 10);
	let currentStartsAt = parseInt(params.get('startsAt') || '0', 10);

	console.log(`V2 Match: ${matchId} seed=${currentSeed} side=${mySide} vs ${opponentName} (game ${currentGameNumber}/${bestOf})`);

	// Fetch and display game balance
	fetchGameBalance().then(updateBalanceDisplay);

	// Series score HUD (updated on series-next)
	let seriesHud: HTMLElement | null = null;
	function updateSeriesHud() {
		if (bestOf <= 1) return;
		if (!seriesHud) {
			seriesHud = document.createElement('div');
			seriesHud.id = 'series-hud';
			seriesHud.style.cssText =
				'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:100;' +
				'background:rgba(0,0,0,0.8);color:#fff;padding:12px 28px;border-radius:10px;' +
				'font-family:monospace;text-align:center;pointer-events:none;' +
				'border:1px solid rgba(255,255,255,0.1);';
			document.body.appendChild(seriesHud);
		}
		const myWins = mySide === 'A' ? currentWinsA : currentWinsB;
		const oppWins = mySide === 'A' ? currentWinsB : currentWinsA;
		seriesHud.innerHTML =
			`<div style="font-size:14px;opacity:0.6;letter-spacing:0.15em;margin-bottom:8px">BEST OF ${bestOf} | GAME ${currentGameNumber}</div>` +
			`<div style="display:flex;align-items:center;gap:16px;justify-content:center">` +
			`<div style="text-align:center"><div style="font-size:10px;opacity:0.5;margin-bottom:2px">YOU</div><div style="font-size:36px;font-weight:bold;color:#00e5ff">${myWins}</div></div>` +
			`<div style="font-size:24px;opacity:0.3">—</div>` +
			`<div style="text-align:center"><div style="font-size:10px;opacity:0.5;margin-bottom:2px">OPP</div><div style="font-size:36px;font-weight:bold;color:#f97316">${oppWins}</div></div>` +
			`</div>`;
	}
	updateSeriesHud();

	const config = DEFAULT_CONFIG;
	const scene = createScene();
	const render = createRenderState(scene, skin, true);
	// No ghost — opponent status shown via server-confirmed data only.
	let oppStatusEl: HTMLElement | null = null;
	function showOppStatus(text: string, color: string) {
		if (!oppStatusEl) {
			oppStatusEl = document.createElement('div');
			oppStatusEl.style.cssText =
				'position:fixed;top:60px;right:16px;z-index:100;' +
				'background:rgba(0,0,0,0.85);' +
				'padding:12px 20px;border-radius:10px;' +
				'font-family:monospace;pointer-events:none;' +
				'border:1px solid rgba(255,255,255,0.15);';
			document.body.appendChild(oppStatusEl);
		}
		oppStatusEl.innerHTML = text;
		oppStatusEl.style.borderColor = color;
	}
	function hideOppStatus() {
		if (oppStatusEl) { oppStatusEl.remove(); oppStatusEl = null; }
	}

	// Mutable per-game sim state — reassigned on series-next
	let myState = makeInitialState(currentSeed, config);

	// ── Client-side state machine ────────────────────────────────────
	// ONE source of truth. Every handler checks `phase` — never a combo
	// of booleans. Transitions are explicit and logged.
	//
	//  ready_prompt → waiting → countdown → playing → done_sent → game_result → ready_prompt
	//                                                           → series_end (terminal)
	//
	type ClientPhase =
		| 'ready_prompt'  // showing ready button (game 1) or auto-readying (game 2+)
		| 'waiting'       // I readied, waiting for opponent
		| 'countdown'     // 3-2-1-GO
		| 'playing'       // game active, player has control
		| 'done_sent'     // match-done sent (self died or guaranteed win), waiting for server
		| 'game_result'   // showing interim game result (Bo3 series)
		| 'series_end';   // final result shown (terminal until navigate/rematch)

	let phase: ClientPhase = 'ready_prompt';
	let lastFrameTime = performance.now();
	let tickAccumulator = 0;

	/** Log to console AND server — both players' events visible in fly logs. */
	function gameLog(event: string, data?: Record<string, unknown>) {
		const entry = { event, matchId, player: playerName, phase, ...data };
		console.log(`[game] ${event}`, data || '');
		fetch('/api/log', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ nametag: playerName, event: `game.${event}`, data: entry }),
		}).catch(() => {});
	}

	// ── Debug HUD — toggle with ?debug=1 in URL ────────────────────
	const showDebug = new URLSearchParams(location.search).has('debug');
	const debugHud = document.createElement('div');
	debugHud.id = 'debug-hud';
	debugHud.style.cssText =
		'position:fixed;top:50%;left:16px;transform:translateY(-50%);z-index:999;' +
		'background:rgba(0,0,0,0.85);color:#0f0;' +
		'padding:16px 20px;border-radius:8px;' +
		'font-family:monospace;font-size:16px;line-height:1.8;' +
		'pointer-events:none;max-width:400px;' +
		'border:1px solid rgba(0,255,0,0.2);' +
		(showDebug ? '' : 'display:none;');
	document.body.appendChild(debugHud);
	let lastPollInfo = '';

	function updateDebugHud() {
		if (!showDebug) return;
		const wsState = ['CONNECTING','OPEN','CLOSING','CLOSED'][matchWs.wsState] || '?';
		const wsColor = wsState === 'OPEN' ? '#0f0' : '#f00';
		debugHud.innerHTML =
			`<div style="font-size:12px;color:#666;margin-bottom:4px">DEBUG HUD</div>` +
			`<b style="color:#0ff">${playerName}</b> <span style="color:#666">side ${mySide}</span><br>` +
			`phase: <b style="color:#ff0">${phase}</b><br>` +
			`game: ${currentGameNumber}/${bestOf} | wins: <b>${mySide === 'A' ? currentWinsA : currentWinsB}</b>-${mySide === 'A' ? currentWinsB : currentWinsA}<br>` +
			`inputs: <b>${inputsSent}</b> | score: <b>${myState.score.toLocaleString()}</b><br>` +
			`<br>` +
			`ws: <b style="color:${wsColor}">${wsState}</b><br>` +
			`<span style="font-size:12px;color:#666">poll: ${lastPollInfo}</span>`;
	}
	setInterval(updateDebugHud, 500);

	function setPhase(next: ClientPhase) {
		if (phase === next) return;
		gameLog('phase', { from: phase, to: next });
		phase = next;
		(window as any).__currentPhase = next;
	}
	// Derived helpers used by input handlers + game loop guard
	function isPlaying() { return phase === 'playing'; }
	function isGameActive() { return phase === 'playing' || phase === 'done_sent'; }
	// For 1v1 challenges (tournament name contains "vs"), go back to
	// the main page's challenge section. For bracket tournaments, go
	// to the tournament detail page.
	const isChallenge = !tournamentId || tournamentId.startsWith('challenge-');
	const backUrl = isChallenge
		? 'challenge.html'
		: `tournament-v2.html?id=${tournamentId}`;


	// ── WebSocket (input relay + chat only) ──────────────────────────
	const matchWs = connectMatchWS({
		playerName,
		matchId,
		onOpponentInput() {}, // ghost removed — inputs stored server-side for replay
		onChat(from, message) { chat.addMessage(from, message, false); },
		onChallengeStart(msg) {
			const p = new URLSearchParams({
				tournament: '1', matchId: msg.matchId, seed: msg.seed,
				side: msg.youAre, opponent: msg.opponent, name: playerName,
				tid: msg.tournamentId, bestOf: String(msg.bestOf || bestOf),
				wager: String(msg.wager || 0), startsAt: String(msg.startsAt),
			});
			location.href = 'dev.html?' + p;
		},
		onSeriesNext(msg) {
			// Rematch accepted — reload with new seed, same matchId
			const p = new URLSearchParams({
				tournament: '1', matchId: matchId, seed: msg.seed,
				side: mySide, opponent: opponentName, name: playerName,
				tid: tournamentId, bestOf: String(bestOf),
				wager: String(msg.wager || lastWager || 0),
				startsAt: String(msg.startsAt || Date.now() + 3000),
			});
			location.href = 'dev.html?' + p;
		},
	});
	function wsSend(msg: Record<string, unknown>) { matchWs.send(msg); }

	let lastWager = 0;
	let shownChallengeId = '';

	function onMatchEnd(msg: any) {
		setPhase('series_end');
		hideOppStatus();
		// Update series HUD to final score, then hide it
		if (msg.seriesEnd && seriesHud) {
			const myWins = mySide === 'A' ? (msg.scoreA ?? 0) : (msg.scoreB ?? 0);
			const oppWins = mySide === 'A' ? (msg.scoreB ?? 0) : (msg.scoreA ?? 0);
			currentWinsA = msg.scoreA ?? 0;
			currentWinsB = msg.scoreB ?? 0;
			updateSeriesHud();
		}
		if (seriesHud) seriesHud.style.display = 'none';

		const iWon = msg.winner === playerName;
		// Server reports scoreA/scoreB by SIDE (player A vs player B). Flip
		// to my-vs-opponent for display so side-B players don't see the
		// numbers reversed (e.g. "SERIES WIN! 0 — 2" when they actually
		// won 2-0 — that was a real prod bug).
		const sideAScore = msg.scoreA ?? 0;
		const sideBScore = msg.scoreB ?? 0;
		const myScore = mySide === 'A' ? sideAScore : sideBScore;
		const oppScore = mySide === 'A' ? sideBScore : sideAScore;
		const wager = msg.wager || 0;
		lastWager = wager;

		playCrash();

		// Force-resolve forfeit (both players offline 45s+) — show a
		// distinct overlay so it doesn't look like a real played match.
		if (msg.forfeit) {
			const rematchBtn = isChallenge ? `<button onclick="window.__v2rematch()" style="${BTN_STYLE}font-size:14px">REMATCH</button>` : '';
			const backLabel = isChallenge ? 'BACK TO CHALLENGES' : 'BACK TO TOURNAMENT';
			const backBtn = `<a href="${backUrl}" style="${BTN_STYLE}font-size:13px;background:transparent;color:#c8d0dc;border-color:rgba(95,234,255,0.3)">${backLabel}</a>`;
			const iWon = msg.winner === playerName;
			const forfeitMsg = iWon
				? 'Opponent didn\'t show up. You win!'
				: 'Match forfeited — no players readied.';
			showOverlay(
				`<div style="font-size:24px;font-weight:bold;color:${iWon ? '#2d6a4f' : '#94a3b8'};margin-bottom:8px">${iWon ? 'WIN BY FORFEIT' : 'MATCH FORFEITED'}</div>` +
				`<div style="font-size:14px;color:#94a3b8;margin-bottom:16px">${forfeitMsg}</div>` +
				rematchBtn + backBtn,
			);
			fetchGameBalance().then(updateBalanceDisplay);
			return;
		}

		// If this match-end is flagged as series end, fall through to the final-result branch below
		// (scores in msg are series wins, not game scores)
		const isSeriesEnd = !!msg.seriesEnd;

		// For interim series games (not the final one), show "waiting for next game"
		if (bestOf > 1 && !isSeriesEnd) {
			showOverlay(
				`<div style="font-size:20px;font-weight:bold;color:${iWon ? '#2d6a4f' : '#c1121f'};margin-bottom:8px">Game ${currentGameNumber}: ${iWon ? 'WIN' : 'LOSS'}</div>` +
				`<div style="font-size:14px;margin-bottom:8px">${myScore.toLocaleString()} — ${oppScore.toLocaleString()}</div>` +
				`<div style="font-size:13px;opacity:0.6">Waiting for next game...</div>`,
			);
			return; // series-next will handle what's next
		}

		// Final result (single game OR series end)
		const winLabel = isSeriesEnd ? 'SERIES WIN!' : 'YOU WIN!';
		const loseLabel = isSeriesEnd ? 'SERIES LOSS' : 'YOU LOSE';
		let resultHtml = '';
		if (iWon) {
			resultHtml += `<div style="font-size:28px;font-weight:bold;color:#2d6a4f;margin-bottom:8px">${winLabel}</div>`;
			if (wager > 0) resultHtml += `<div style="font-size:16px;color:#2d6a4f;margin-bottom:8px">+${wager} UCT</div>`;
		} else {
			resultHtml += `<div style="font-size:28px;font-weight:bold;color:#c1121f;margin-bottom:8px">${loseLabel}</div>`;
			if (wager > 0) resultHtml += `<div style="font-size:16px;color:#c1121f;margin-bottom:8px">-${wager} UCT</div>`;
		}

		if (isSeriesEnd) {
			// Show last game score + series total
			const lgr = msg.lastGameResult;
			if (lgr) {
				const lgMy = mySide === 'A' ? lgr.scoreA : lgr.scoreB;
				const lgOpp = mySide === 'A' ? lgr.scoreB : lgr.scoreA;
				const lgWon = lgr.winner === playerName;
				resultHtml += `<div style="font-size:12px;opacity:0.5;letter-spacing:0.1em;margin-bottom:4px">LAST GAME</div>`;
				resultHtml += `<div style="font-size:14px;margin-bottom:12px;color:${lgWon ? '#2d6a4f' : '#c1121f'}">${lgMy.toLocaleString()} — ${lgOpp.toLocaleString()}</div>`;
			}
			resultHtml += `<div style="font-size:12px;opacity:0.5;letter-spacing:0.1em;margin-bottom:6px">SERIES</div>`;
			resultHtml += `<div style="display:flex;gap:20px;justify-content:center;align-items:center;margin-bottom:16px">`;
			resultHtml += `<div style="text-align:center"><div style="font-size:11px;opacity:0.5;margin-bottom:2px">${playerName}</div><div style="font-size:28px;font-weight:bold;color:${iWon ? '#2d6a4f' : '#c1121f'}">${myScore}</div></div>`;
			resultHtml += `<div style="font-size:20px;opacity:0.3">—</div>`;
			resultHtml += `<div style="text-align:center"><div style="font-size:11px;opacity:0.5;margin-bottom:2px">${opponentName}</div><div style="font-size:28px;font-weight:bold;color:${iWon ? '#c1121f' : '#2d6a4f'}">${oppScore}</div></div>`;
			resultHtml += `</div>`;
		} else {
			// Single game — show actual scores
			resultHtml += `<div style="font-size:12px;opacity:0.5;letter-spacing:0.1em;margin-bottom:6px">Score</div>`;
			resultHtml += `<div style="display:flex;gap:20px;justify-content:center;align-items:center;margin-bottom:16px">`;
			resultHtml += `<div style="text-align:center"><div style="font-size:11px;opacity:0.5;margin-bottom:2px">${playerName}</div><div style="font-size:28px;font-weight:bold;color:${iWon ? '#2d6a4f' : '#c1121f'}">${myScore.toLocaleString()}</div></div>`;
			resultHtml += `<div style="font-size:20px;opacity:0.3">—</div>`;
			resultHtml += `<div style="text-align:center"><div style="font-size:11px;opacity:0.5;margin-bottom:2px">${opponentName}</div><div style="font-size:28px;font-weight:bold;color:${iWon ? '#c1121f' : '#2d6a4f'}">${oppScore.toLocaleString()}</div></div>`;
			resultHtml += `</div>`;
		}

		const rematchBtn = isChallenge ? `<button onclick="window.__v2rematch()" style="${BTN_STYLE}font-size:14px">REMATCH</button>` : '';
		const backLabel = isChallenge ? 'BACK TO CHALLENGES' : 'BACK TO TOURNAMENT';
		const backBtn = `<a href="${backUrl}" style="${BTN_STYLE}font-size:13px;background:transparent;color:#c8d0dc;border-color:rgba(95,234,255,0.3)">${backLabel}</a>`;

		showOverlay(resultHtml + rematchBtn + backBtn);

		fetchGameBalance().then(updateBalanceDisplay);
	}

	// ── Rematch ──────────────────────────────────────────────────────
	// Creates a new challenge via REST, polls for acceptance, redirects
	// on accept. Simple, battle-tested, works with bots.
	(window as any).__v2rematch = async () => {
		showOverlay('<div style="font-size:16px">Sending rematch...</div><div style="font-size:12px;margin-top:8px;opacity:0.6">Waiting for opponent to accept...</div>');
		let challengeId: string;
		try {
			const r = await fetch('/api/challenges', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ from: playerName, opponent: opponentName, wager: lastWager, bestOf }),
			});
			const data = await r.json();
			if (!r.ok) {
				const backBtn = `<a href="${backUrl}" style="${BTN_STYLE}font-size:13px;background:transparent;color:#c8d0dc;border-color:rgba(95,234,255,0.3)">BACK</a>`;
				showOverlay(`<div style="font-size:14px;color:#c1121f;margin-bottom:12px">${data.message || 'Challenge failed'}</div>` +
					`<button onclick="window.__v2rematch()" style="${BTN_STYLE}font-size:14px">TRY AGAIN</button>` + backBtn);
				return;
			}
			challengeId = data.challengeId;
		} catch {
			const backBtn = `<a href="${backUrl}" style="${BTN_STYLE}font-size:13px;background:transparent;color:#c8d0dc;border-color:rgba(95,234,255,0.3)">BACK</a>`;
			showOverlay(`<div style="font-size:14px;color:#c1121f;margin-bottom:12px">Network error</div>` +
				`<button onclick="window.__v2rematch()" style="${BTN_STYLE}font-size:14px">TRY AGAIN</button>` + backBtn);
			return;
		}
		// Poll for acceptance — also listen for WS challenge-start as backup
		const poll = setInterval(async () => {
			try {
				const r = await fetch(`/api/challenges/${challengeId}/status`);
				if (!r.ok) return;
				const s = await r.json();
				if (s.status === 'accepted' && s.seed) {
					clearInterval(poll);
					matchWs.close();
					const side = s.playerA === playerName ? 'A' : 'B';
					const opp = side === 'A' ? s.playerB : s.playerA;
					const p = new URLSearchParams({
						tournament: '1', matchId: s.matchId, seed: s.seed,
						side, opponent: opp, name: playerName,
						tid: s.tournamentId, bestOf: String(s.bestOf || bestOf),
						wager: String(lastWager), startsAt: String(Date.now() + 3000),
					});
					location.href = 'dev.html?' + p;
				} else if (s.status === 'expired' || s.status === 'declined') {
					clearInterval(poll);
					const backBtn = `<a href="${backUrl}" style="${BTN_STYLE}font-size:13px;background:transparent;color:#c8d0dc;border-color:rgba(95,234,255,0.3)">BACK</a>`;
					showOverlay(`<div style="font-size:14px;margin-bottom:12px">${s.status === 'declined' ? 'Opponent declined' : 'Rematch expired'}</div>` +
						`<button onclick="window.__v2rematch()" style="${BTN_STYLE}font-size:14px">TRY AGAIN</button>` + backBtn);
				}
			} catch {}
		}, 1000);
		setTimeout(() => clearInterval(poll), 35000);
	};

	(window as any).__acceptRematch = async (challengeId: string) => {
		showOverlay('<div style="font-size:16px">Starting match...</div>');
		try {
			const r = await fetch(`/api/challenges/${challengeId}/accept`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ by: playerName }),
			});
			const data = await r.json();
			if (!r.ok) {
				showOverlay(`<div style="font-size:14px;color:#c1121f;margin-bottom:12px">${data.message || 'Accept failed'}</div>`);
				return;
			}
			matchWs.close();
			const p = new URLSearchParams({
				tournament: '1', matchId: data.matchId, seed: data.seed || '0',
				side: data.youAre, opponent: data.opponent, name: playerName,
				tid: data.tournamentId, bestOf: String(data.bestOf || bestOf),
				wager: String(lastWager), startsAt: String(Date.now() + 3000),
			});
			location.href = 'dev.html?' + p;
		} catch {
			showOverlay(`<div style="font-size:14px;color:#c1121f;margin-bottom:12px">Network error</div>`);
		}
	};

	(window as any).__declineRematch = async (challengeId: string) => {
		try {
			await fetch(`/api/challenges/${challengeId}/decline`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ by: playerName }),
			});
		} catch {}
		const backBtn = `<a href="${backUrl}" style="${BTN_STYLE}font-size:13px;background:transparent;color:#c8d0dc;border-color:rgba(95,234,255,0.3)">${isChallenge ? 'BACK TO CHALLENGES' : 'BACK TO TOURNAMENT'}</a>`;
		showOverlay('Challenge declined.' + backBtn);
	};

	// ── Chat ─────────────────────────────────────────────────────────
	const chat = createChatPanel({
		onSend(text) {
			wsSend({ type: 'chat', to: opponentName, message: text });
			chat.addMessage(playerName, text, true);
		},
		playerName,
	});

	// Keyboard + touch input
	let inputsSent = 0;
	const inputLog: Array<{ t: number; a: string }> = [];
	const keysAllowed: Record<number, boolean> = {};
	document.addEventListener('keydown', (e) => {
		// Don't intercept typing in chat or other inputs
		if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
		if (!isPlaying()) return;
		const key = e.keyCode;
		if (keysAllowed[key] === false) return;
		keysAllowed[key] = false;
		const action = keyToAction(key);
		if (action) {
			myState.character.queuedActions.push(action);
			wsSend({ type: 'input', matchId, tick: myState.tick, payload: btoa(action) });
			inputsSent++;
			inputLog.push({ t: myState.tick, a: action });
		}
	});
	document.addEventListener('keyup', (e) => { keysAllowed[e.keyCode] = true; });

	installTouchControls({
		onAction: (a) => {
			if (!isPlaying()) return;
			myState.character.queuedActions.push(a);
			wsSend({ type: 'input', matchId, tick: myState.tick, payload: btoa(a) });
		},
		onStart: () => {},
		isPlaying,
	});

	// Render initial state
	syncRender(myState, render, scene, config);
	renderFrame(scene);

	function getSeriesInfo(): string {
		return bestOf > 1 ? `<div style="font-size:11px;opacity:0.5;margin-top:4px">Best of ${bestOf} | Game ${currentGameNumber}</div>` : '';
	}

	function showReadyPrompt(message?: string) {
		setPhase('ready_prompt');
		const msg = message ? `<div style="font-size:14px;color:#c1121f;margin-bottom:8px">${message}</div>` : '';
		showOverlay(
			msg +
			`<div style="font-size:18px">vs ${opponentName}</div>${getSeriesInfo()}` +
			`<div style="margin-top:16px"><button onclick="window.__clickReady()" style="font-family:monospace;font-size:14px;font-weight:bold;padding:12px 32px;background:#00e5ff;color:#060a12;border:none;border-radius:6px;cursor:pointer;letter-spacing:0.1em">READY</button></div>`,
		);
	}

	/** Shown for game 1 (needs click to unlock audio) and on series-next (auto-ready). */
	function beginGame(isInitial: boolean) {
		if (isInitial) {
			showReadyPrompt();
		} else {
			setPhase('ready_prompt');
			showOverlay(
				`<div style="font-size:18px">vs ${opponentName}</div>${getSeriesInfo()}` +
				`<div style="font-size:13px;margin-top:10px;opacity:0.7">Getting ready…</div>`,
			);
			setTimeout(() => { resumeAudio(); sendReady(); }, 200);
		}
	}

	beginGame(true);

	(window as any).__clickReady = () => {
		resumeAudio();
		sendReady();
	};

	let readyDeadline = 0;

	function sendReady() {
		if (phase !== 'ready_prompt') return;
		gameLog('sendReady');
		setPhase('waiting');
		readyDeadline = Date.now() + 10_000;

		showOverlay(`<div style="font-size:18px">vs ${opponentName}</div>${getSeriesInfo()}<div style="font-size:13px;margin-top:10px;opacity:0.7">Sending ready…</div>`);
		const waitingTimer = setTimeout(() => {
			if (phase === 'waiting') updateWaitingOverlay();
		}, 400);

		const parsed = matchId.match(/^(.+)\/R(\d+)M(\d+)$/);
		if (!parsed) { console.warn('[ready] bad matchId', matchId); return; }
		const [, tid, round, slot] = parsed;
		fetch(`/api/tournaments/${encodeURIComponent(tid)}/matches/${round}/${slot}/ready`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ nametag: playerName }),
		}).then((r) => r.json().then((data) => ({ ok: r.ok, data })))
		  .then(({ ok, data }) => {
			if (!ok) { clearTimeout(waitingTimer); return; }
			if ((data.phase === 'started' || data.phase === 'reconnected') && data.matchStart) {
				clearTimeout(waitingTimer);
				const startsAt = Math.max(data.matchStart.startsAt || Date.now() + 3000, Date.now() + 1500);
				kickCountdown(startsAt);
			}
		  })
		  .catch(() => { clearTimeout(waitingTimer); });
	}

	function updateWaitingOverlay() {
		if (phase !== 'waiting') return;
		const remaining = Math.max(0, Math.ceil((readyDeadline - Date.now()) / 1000));
		if (remaining === 0) {
			showReadyPrompt('Ready expired — opponent didn\'t ready in time');
			return;
		}
		showOverlay(
			`<div style="font-size:18px">vs ${opponentName}</div>${getSeriesInfo()}` +
			`<div style="font-size:13px;margin-top:8px;opacity:0.6">Waiting for opponent to be ready...</div>` +
			`<div style="font-size:32px;font-weight:bold;color:#f97316;margin-top:12px">${remaining}s</div>`,
		);
	}
	setInterval(() => { if (phase === 'waiting') updateWaitingOverlay(); }, 500);

	/** Transition to countdown. Single-entry — second call is always a no-op. */
	let countdownLastShown = -1;
	let countdownActive = false;
	function kickCountdown(countdownStart: number) {
		if (countdownActive) return;
		if (phase !== 'waiting' && phase !== 'ready_prompt') return;
		countdownActive = true;
		setPhase('countdown');
		countdownLastShown = -1;
		function tick() {
			if (phase !== 'countdown') return; // phase changed under us — bail
			const ms = countdownStart - Date.now();
			const currentSec = Math.ceil(ms / 1000);
			if (ms > 1000) {
				showOverlay(`<div style="font-size:12px;color:#f97316;margin-bottom:6px;letter-spacing:.2em">GET READY</div><div style="font-size:56px;font-weight:800;line-height:1">${currentSec}</div>`);
				if (currentSec !== countdownLastShown) { countdownLastShown = currentSec; playBeep(1); }
				setTimeout(tick, 100);
			} else if (ms > 0) {
				showOverlay('<div style="font-size:12px;color:#f97316;margin-bottom:6px;letter-spacing:.2em">GET READY</div><div style="font-size:56px;font-weight:800;line-height:1">1</div>');
				if (countdownLastShown !== 1) { countdownLastShown = 1; playBeep(1); }
				setTimeout(tick, ms);
			} else {
				showOverlay('<div style="font-size:56px;font-weight:800;color:#f97316;line-height:1">GO!</div>');
				playGameStart();
				// Both setTimeout AND rAF are throttled in background tabs.
				// Use both + a visibilitychange listener as triple fallback.
				function startPlaying() {
					if (phase !== 'countdown') return;
					hideOverlay();
					setPhase('playing');
					countdownActive = false;
					lastFrameTime = performance.now();
					tickAccumulator = 0;
					inputLog.length = 0;
					gameLog('gameStart', {
						seed: currentSeed, game: currentGameNumber,
						tick: myState.tick, rng: myState.rngState,
						trees: myState.trees.length, score: myState.score,
					});
					showOppStatus(
						`<div style="display:flex;align-items:center;gap:8px">` +
						`<span style="width:8px;height:8px;border-radius:50%;background:#2ea043;box-shadow:0 0 6px rgba(46,160,67,0.6);animation:pulse 1.5s infinite"></span>` +
						`<span style="font-size:14px;color:#aaa">OPPONENT ALIVE</span>` +
						`</div>`,
						'rgba(46,160,67,0.3)',
					);
				}
				setTimeout(startPlaying, 500);
				requestAnimationFrame(() => requestAnimationFrame(startPlaying));
				// If tab was in background, catch it when it becomes visible
				const onVisible = () => {
					if (phase === 'countdown') startPlaying();
					document.removeEventListener('visibilitychange', onVisible);
				};
				document.addEventListener('visibilitychange', onVisible);
			}
		}
		tick();
	}

	// ── REST poll — the ONLY flow driver ─────────────────────────────
	const reconcileMatchRegex = matchId.match(/^(.+)\/R(\d+)M(\d+)$/);
	const stateUrl = reconcileMatchRegex
		? `/api/tournaments/${encodeURIComponent(reconcileMatchRegex[1])}/matches/${reconcileMatchRegex[2]}/${reconcileMatchRegex[3]}/state`
		: null;
	const doneUrl = reconcileMatchRegex
		? `/api/tournaments/${encodeURIComponent(reconcileMatchRegex[1])}/matches/${reconcileMatchRegex[2]}/${reconcileMatchRegex[3]}/done`
		: null;

	function resetForNextGame(s: any) {
		currentSeed = parseInt(s.series.currentSeed, 16) >>> 0;
		console.log(`[seed] series advance hex=${s.series.currentSeed} parsed=${currentSeed}`);
		currentGameNumber = s.series.currentGame;
		currentWinsA = s.series.winsA || 0;
		currentWinsB = s.series.winsB || 0;
		myState = makeInitialState(currentSeed, config);
		countdownActive = false;
		inputsSent = 0;
		tickAccumulator = 0;
		lastFrameTime = performance.now();
		render.character.root.visible = true;
		if (seriesHud) seriesHud.style.display = '';
		removeDeathBanner();
		updateSeriesHud();
		try {
			const p = new URLSearchParams(location.search);
			p.set('seed', s.series.currentSeed);
			p.set('gameNum', String(currentGameNumber));
			p.set('winsA', String(currentWinsA));
			p.set('winsB', String(currentWinsB));
			history.replaceState(null, '', location.pathname + '?' + p.toString());
		} catch {}
		syncRender(myState, render, scene, config);
		renderFrame(scene);
		beginGame(false);
	}

	if (stateUrl) {
		startStatePoll(stateUrl, {
			getPhase: () => phase,
			getMySide: () => mySide,
			getPlayerName: () => playerName,
			getCurrentGameNumber: () => currentGameNumber,
			getReadyDeadline: () => readyDeadline,
			onMatchComplete(s) {
				gameLog('matchComplete', { winner: s.winner, scoreA: s.scoreA, scoreB: s.scoreB, lastGameResult: s.lastGameResult });
				// Detect forfeit: match complete but no games were played (both scores 0, no game result)
				const isForfeit = (s.scoreA ?? 0) === 0 && (s.scoreB ?? 0) === 0 && !s.lastGameResult;
				onMatchEnd({
					matchId: s.matchId, winner: s.winner,
					scoreA: s.scoreA ?? 0, scoreB: s.scoreB ?? 0,
					seriesEnd: (s.bestOf || 1) > 1, bestOf: s.bestOf || 1,
					wager: lastWager, lastGameResult: s.lastGameResult,
					forfeit: isForfeit,
				});
			},
			onSeriesAdvance(s) {
				gameLog('seriesAdvance', { serverGame: s.series.currentGame, localGame: currentGameNumber, winsA: s.series.winsA, winsB: s.series.winsB });
				const prevWinsA = currentWinsA;
				const prevWinsB = currentWinsB;
				const newWinsA = s.series.winsA || 0;
				const newWinsB = s.series.winsB || 0;
				const iWonGame = (mySide === 'A') ? (newWinsA > prevWinsA) : (newWinsB > prevWinsB);
				const myWins = mySide === 'A' ? newWinsA : newWinsB;
				const oppWins = mySide === 'A' ? newWinsB : newWinsA;
				const gameJustPlayed = currentGameNumber;
				currentGameNumber = s.series.currentGame;
				currentWinsA = newWinsA;
				currentWinsB = newWinsB;
				setPhase('game_result');
				removeDeathBanner();
				const gameMyScore = s.lastGameResult ? (mySide === 'A' ? s.lastGameResult.scoreA : s.lastGameResult.scoreB) : 0;
				const gameOppScore = s.lastGameResult ? (mySide === 'A' ? s.lastGameResult.scoreB : s.lastGameResult.scoreA) : 0;
				const scoreLine = (gameMyScore || gameOppScore)
					? `<div style="font-size:14px;margin-bottom:12px;color:#888">${gameMyScore.toLocaleString()} — ${gameOppScore.toLocaleString()}</div>`
					: '';
				showOverlay(
					`<div style="font-size:26px;font-weight:bold;color:${iWonGame ? '#2d6a4f' : '#c1121f'};margin-bottom:8px">Game ${gameJustPlayed}: ${iWonGame ? 'WIN' : 'LOSS'}</div>` +
					scoreLine +
					`<div style="font-size:12px;color:#666;letter-spacing:.2em;margin-bottom:4px">SERIES (Best of ${bestOf})</div>` +
					`<div style="font-size:28px;font-weight:bold;margin-bottom:16px">${myWins} — ${oppWins}</div>` +
					`<div style="font-size:13px;opacity:0.7">Next game starting…</div>`,
				);
				setTimeout(() => resetForNextGame(s), 3000);
			},
			onForceStart() {
				// Server is already in playing phase but we're stuck
				// (tab was in background, countdown timer never fired).
				// Skip countdown entirely and go straight to playing.
				gameLog('forceStart', { wasPhase: phase });
				hideOverlay();
				setPhase('playing');
				countdownActive = false;
				lastFrameTime = performance.now();
				tickAccumulator = 0;
				inputLog.length = 0;
				showOppStatus(
					`<div style="display:flex;align-items:center;gap:8px">` +
					`<span style="width:8px;height:8px;border-radius:50%;background:#2ea043;box-shadow:0 0 6px rgba(46,160,67,0.6);animation:pulse 1.5s infinite"></span>` +
					`<span style="font-size:14px;color:#aaa">OPPONENT ALIVE</span>` +
					`</div>`,
					'rgba(46,160,67,0.3)',
				);
			},
			onBothReady() {
				gameLog('bothReady');
				kickCountdown(Date.now() + 3000);
			},
			onReadyExpired() {
				gameLog('readyExpired');
				showReadyPrompt('Ready expired — opponent didn\'t ready in time');
			},
			onGameResult(result) {
				// Server resolved this game — both scores are final.
				const myScore = mySide === 'A' ? result.scoreA : result.scoreB;
				const oppScore = mySide === 'A' ? result.scoreB : result.scoreA;
				const iWon = result.winner === playerName;
				gameLog('gameResult', { result, iWon });

				// Stop the game if still playing (early-decide case)
				if (phase === 'playing') {
					sendMatchDone();
				}
				setPhase('done_sent');
				render.character.root.visible = false;
				hideOppStatus();
				if (seriesHud) seriesHud.style.display = 'none';
				showOverlay(
					`<div style="font-size:24px;font-weight:bold;color:${iWon ? '#2d6a4f' : '#c1121f'};margin-bottom:8px">${iWon ? 'YOU WIN!' : 'YOU LOSE'}</div>` +
					`<div style="font-size:18px;margin-bottom:4px">You: ${myScore.toLocaleString()}</div>` +
					`<div style="font-size:18px;margin-bottom:16px;color:#888">Opponent: ${oppScore.toLocaleString()}</div>` +
					`<div style="font-size:13px;opacity:0.6">Waiting for result…</div>`,
				);
			},
			getMyScore: () => myState.score,
			onOpponentDead(oppScore) {
				if (phase !== 'playing') return;
				if (myState.score > oppScore) {
					// I'm ahead — game decided, stop and send done
					gameLog('earlyDecide', { myScore: myState.score, oppScore });
					setPhase('done_sent');
					sendMatchDone();
					render.character.root.visible = false;
					hideOppStatus();
					if (seriesHud) seriesHud.style.display = 'none';
					showOverlay(
						`<div style="font-size:24px;font-weight:bold;color:#2d6a4f;margin-bottom:8px">GAME OVER</div>` +
						`<div style="font-size:18px;margin-bottom:4px">You: ${myState.score.toLocaleString()}</div>` +
						`<div style="font-size:18px;margin-bottom:16px;color:#888">Opponent: ${oppScore.toLocaleString()}</div>` +
						`<div style="font-size:13px;opacity:0.6">Calculating result…</div>`,
					);
				} else {
					// Opponent dead but I'm behind — show their score as target
					showOppStatus(
						`<div style="font-size:12px;color:#f66;letter-spacing:0.1em;margin-bottom:4px">OPPONENT DEAD</div>` +
						`<div style="font-size:24px;font-weight:bold;color:#f97316">${oppScore.toLocaleString()}</div>` +
						`<div style="font-size:11px;opacity:0.5;margin-top:2px">Beat this to win!</div>`,
						'rgba(249,115,22,0.4)',
					);
				}
			},
			onPollResult(info) { lastPollInfo = info; },
			onIncomingChallenge(ch) {
				if (shownChallengeId === ch.id) return;
				shownChallengeId = ch.id;
				const wagerText = ch.wager > 0 ? ` for ${ch.wager} UCT` : '';
				showOverlay(
					`<div style="font-size:16px;margin-bottom:12px"><strong>${ch.from}</strong> challenges you${wagerText}</div>` +
					`<button onclick="window.__acceptRematch('${ch.id}')" style="font-family:monospace;font-size:14px;font-weight:bold;padding:12px 32px;background:#00e5ff;color:#060a12;border:none;border-radius:6px;cursor:pointer;letter-spacing:0.1em;margin:4px">ACCEPT</button>` +
					`<button onclick="window.__declineRematch('${ch.id}')" style="font-family:monospace;font-size:12px;padding:8px 24px;background:transparent;color:#94a3b8;border:1px solid #334155;border-radius:6px;cursor:pointer;letter-spacing:0.1em;margin:4px">DECLINE</button>`,
				);
			},
		});
	}

	/** Send match-done to server via WS + REST. Idempotent. */
	function sendMatchDone() {
		wsSend({ type: 'match-done', matchId });
		if (doneUrl) {
			fetch(doneUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ nametag: playerName }),
			}).catch(() => {});
		}
	}

	// Game loop
	function loop() {
		const now = performance.now();
		let delta = (now - lastFrameTime) / 1000;
		lastFrameTime = now;
		delta = Math.min(delta, 0.1);

		// Only tick the sim during playing or done_sent (dead but watching ghost)
		if (isGameActive()) {
			const preCoinCount = myState.coinCount;
			const preCharges = myState.flamethrowerCharges;
			const preJumping = myState.character.isJumping;
			const preLane = myState.character.currentLane;

			tickAccumulator += delta;
			while (tickAccumulator >= TICK_SECONDS && isGameActive()) {
				tick(myState, config);

				// Self died → transition to done_sent
				if (myState.gameOver && phase === 'playing') {
					playCrash();
					render.character.root.visible = false;
					gameLog('died', { score: myState.score, inputsSent, tick: myState.tick, seed: currentSeed, inputs: inputLog });
					setPhase('done_sent');
					sendMatchDone();
					// Safety: if the poll never detects the result (server
					// down, network issue), stop ticking after 45s.
					setTimeout(() => {
						if (phase === 'done_sent') {
							setPhase('series_end');
							const backBtn = `<a href="${backUrl}" style="${BTN_STYLE}font-size:13px;background:transparent;color:#c8d0dc;border-color:rgba(95,234,255,0.3)">BACK</a>`;
							showOverlay(
								`<div style="font-size:16px;color:#c1121f;margin-bottom:12px">Result unavailable — connection issue</div>` +
								backBtn,
							);
						}
					}, 120_000); // 2 minutes — expert bots can take 60s+
					if (seriesHud) seriesHud.style.display = 'none';
					showOverlay(
						`<div style="font-size:24px;font-weight:bold;margin-bottom:8px">YOU DIED</div>` +
						`<div style="font-size:20px;margin-bottom:16px">Score: ${myState.score.toLocaleString()}</div>` +
						`<div style="font-size:13px;opacity:0.6">Waiting for opponent to finish…</div>`,
					);
				}

				// No early-stop on opponent ghost death. The ghost is built
				// from relayed inputs which can lag/drop — trusting it caused
				// controls to lock up mid-game. Player keeps playing until
				// THEY die. Server determines the winner.

				tickAccumulator -= TICK_SECONDS;
			}

			// Sound effects
			if (myState.coinCount > preCoinCount) playCoinCollect(myState.lastCollectedTier || 'gold');
			if (myState.flamethrowerCharges > preCharges) playPowerupCollect();
			if (myState.flameJustFired) playFlameActivate();
			if (myState.character.isJumping && !preJumping) playJump();
			if (myState.character.currentLane !== preLane && !preJumping) playLaneSwitch();
		}

		// Update opponent HUD

		syncRender(myState, render, scene, config);
		renderFrame(scene);
		requestAnimationFrame(loop);
	}
	requestAnimationFrame(loop);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Single-player (unchanged from before)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Level mode — fixed seed, objectives, finish line
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function startLevel(level: LevelDef, skin: CharacterSkin) {
	const config = DEFAULT_CONFIG;
	const scene = createScene();
	const render = createRenderState(scene, skin);
	const state = makeInitialState(level.seed, config);

	// Apply level overrides
	state.treePresenceProb = level.initial.treePresenceProb;
	state.maxTreeSize = level.initial.maxTreeSize;
	state.fogDistance = level.initial.fogDistance;
	state.fogTarget = level.initial.fogDistance;
	state.maxRows = level.totalRows;
	if (level.spawns) {
		state.scriptedSpawns = level.spawns.map(s => ({ ...s }));
	}

	// ── Level phase state machine ────────────────────────────────
	// 'ready'    → waiting for keypress to start
	// 'playing'  → game is running, ticking
	// 'complete' → objectives met, showing result overlay
	// 'failed'   → died or ran out of road without meeting objectives
	let phase: 'ready' | 'playing' | 'complete' | 'failed' = 'ready';
	let stopped = false;

	syncRender(state, render, scene, config);
	renderFrame(scene);

	const BTN = 'font-family:monospace;font-size:14px;font-weight:bold;padding:12px 32px;background:#00e5ff;color:#060a12;border:none;border-radius:6px;cursor:pointer;letter-spacing:0.1em';
	const BTN_GHOST = 'font-family:monospace;font-size:12px;padding:8px 24px;background:transparent;color:#94a3b8;border:1px solid #334155;border-radius:6px;cursor:pointer;letter-spacing:0.1em';
	const backBtn = `<button onclick="location.href='levels.html'" style="${BTN_GHOST}">BACK TO LEVELS</button>`;

	const objListHtml = level.objectives
		.map(o => `<div style="font-size:12px;opacity:0.8">&bull; ${o.label}</div>`)
		.join('');

	showOverlay(
		`<div style="font-size:11px;letter-spacing:0.3em;opacity:0.5;margin-bottom:4px">LEVEL ${level.id}</div>` +
		`<div style="font-size:22px;font-weight:bold;margin-bottom:8px">${level.name}</div>` +
		`<div style="font-size:13px;opacity:0.7;margin-bottom:12px">${level.description}</div>` +
		`<div style="text-align:left;display:inline-block;margin-bottom:16px">${objListHtml}</div>` +
		`<div style="font-size:13px;opacity:0.5;margin-bottom:12px">Press any key to start</div>` +
		backBtn,
	);

	let lastFrameTime = performance.now();
	let tickAccumulator = 0;
	const keysAllowed: Record<number, boolean> = {};
	const ac = new AbortController();

	// ── Objectives HUD ───────────────────────────────────────────
	let objHud: HTMLDivElement | null = null;
	function ensureObjHud() {
		if (objHud) return;
		objHud = document.createElement('div');
		objHud.id = 'level-obj-hud';
		objHud.style.cssText = 'position:fixed;top:12px;right:12px;z-index:100;' +
			'background:rgba(0,0,0,0.7);border:1px solid rgba(95,234,255,0.3);border-radius:6px;' +
			'padding:10px 14px;font-family:monospace;font-size:12px;color:#f8fafc;min-width:160px;' +
			'backdrop-filter:blur(8px)';
		document.body.appendChild(objHud);
	}
	function updateObjHud() {
		if (!objHud) return;
		const { results } = checkObjectives(level, state);
		const progress = Math.min(100, Math.round((state.difficulty / level.totalRows) * 100));
		let html = `<div style="font-size:10px;letter-spacing:0.2em;opacity:0.5;margin-bottom:6px">LEVEL ${level.id}</div>`;
		html += `<div style="background:rgba(255,255,255,0.1);border-radius:3px;height:4px;margin-bottom:8px;overflow:hidden">` +
			`<div style="background:#5feaff;height:100%;width:${progress}%;transition:width 0.3s"></div></div>`;
		for (const r of results) {
			const icon = r.done ? '<span style="color:#4ade80">&#10003;</span>' : '<span style="opacity:0.3">&#9675;</span>';
			html += `<div style="margin-bottom:3px;${r.done ? 'opacity:0.5' : ''}">${icon} ${r.label} (${r.current}/${r.target})</div>`;
		}
		objHud.innerHTML = html;
	}
	function removeObjHud() {
		if (objHud) { objHud.remove(); objHud = null; }
	}

	// ── Start playing ────────────────────────────────────────────
	function beginPlaying() {
		if (phase !== 'ready') return;
		phase = 'playing';
		lastFrameTime = performance.now();
		tickAccumulator = 0;
		hideOverlay();
		ensureObjHud();
		playGameStart();
	}

	// ── End states ───────────────────────────────────────────────
	function showComplete() {
		if (phase === 'complete' || phase === 'failed') return;
		phase = 'complete';
		saveLevelBest(level.id, state.score);
		completeLevel(level.id);
		playGameStart();
		removeObjHud();

		const { results } = checkObjectives(level, state);
		const resultsHtml = results
			.map(r => `<div style="font-size:13px;margin-bottom:4px"><span style="color:#4ade80">&#10003;</span> ${r.label}</div>`)
			.join('');

		const nextLevel = LEVELS.find(l => l.id === level.id + 1);
		const nextBtn = nextLevel
			? `<button onclick="location.href='dev.html?level=${nextLevel.id}'" style="${BTN}">NEXT LEVEL</button>`
			: '';
		showOverlay(
			`<div style="font-size:11px;letter-spacing:0.3em;color:#4ade80;margin-bottom:4px">LEVEL ${level.id}</div>` +
			`<div style="font-size:28px;font-weight:bold;color:#2d6a4f;margin-bottom:4px">COMPLETE!</div>` +
			`<div style="font-size:16px;margin-bottom:12px">Score: ${state.score.toLocaleString()}</div>` +
			`<div style="text-align:left;display:inline-block;margin-bottom:16px">${resultsHtml}</div>` +
			`<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">` +
			nextBtn +
			`<button onclick="window.__boxyRestart()" style="${BTN_GHOST}">RETRY</button>` +
			`</div>` +
			`<div style="margin-top:12px">${backBtn}</div>`,
		);
	}

	function showFailed(reason: string) {
		if (phase === 'complete' || phase === 'failed') return;
		phase = 'failed';
		playCrash();
		saveLevelBest(level.id, state.score);
		removeObjHud();

		const { results } = checkObjectives(level, state);
		const resultsHtml = results
			.map(r => {
				const icon = r.done ? '<span style="color:#4ade80">&#10003;</span>' : '<span style="color:#ef4444">&#10007;</span>';
				return `<div style="font-size:13px;margin-bottom:4px">${icon} ${r.label} (${r.current}/${r.target})</div>`;
			})
			.join('');

		showOverlay(
			`<div style="font-size:11px;letter-spacing:0.3em;opacity:0.5;margin-bottom:4px">LEVEL ${level.id}</div>` +
			`<div style="font-size:24px;font-weight:bold;color:#c1121f;margin-bottom:8px">${reason}</div>` +
			`<div style="font-size:16px;margin-bottom:4px">Score: ${state.score.toLocaleString()}</div>` +
			`<div style="text-align:left;display:inline-block;margin-bottom:16px">${resultsHtml}</div>` +
			`<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">` +
			`<button onclick="window.__boxyRestart()" style="${BTN}">RETRY</button>` +
			`</div>` +
			`<div style="margin-top:12px">${backBtn}</div>`,
		);
	}

	// ── Input ────────────────────────────────────────────────────
	document.addEventListener('keydown', (e) => {
		if (phase === 'complete' || phase === 'failed') return;
		const key = e.keyCode;
		if (keysAllowed[key] === false) return;
		keysAllowed[key] = false;
		if (phase === 'ready' && key > 18) { beginPlaying(); return; }
		if (phase !== 'playing') return;
		const action = keyToAction(key);
		if (action) state.character.queuedActions.push(action);
	}, { signal: ac.signal });
	document.addEventListener('keyup', (e) => { keysAllowed[e.keyCode] = true; }, { signal: ac.signal });

	installTouchControls({
		onAction: (a) => { if (phase === 'playing') state.character.queuedActions.push(a); },
		onStart: () => { if (phase === 'ready') beginPlaying(); },
		isPlaying: () => phase === 'playing',
	});

	function restart() {
		stopped = true;
		removeObjHud();
		ac.abort();
		const world = document.getElementById('world');
		if (world) world.innerHTML = '';
		const scoreEl = document.getElementById('score');
		const coinsEl = document.getElementById('coins');
		if (scoreEl) scoreEl.textContent = '0';
		if (coinsEl) coinsEl.textContent = '0';
		const flameEl = document.getElementById('flame-indicator');
		if (flameEl) flameEl.remove();
		startLevel(level, skin);
	}
	(window as any).__boxyRestart = restart;

	// ── Game loop ────────────────────────────────────────────────
	function loop() {
		if (stopped) return;
		const now = performance.now();
		let delta = (now - lastFrameTime) / 1000;
		lastFrameTime = now;
		delta = Math.min(delta, 0.1);

		if (phase === 'playing') {
			const preJumping = state.character.isJumping;
			const preLane = state.character.currentLane;
			const preCoinCount = state.coinCount;
			const preCharges = state.flamethrowerCharges;

			tickAccumulator += delta;
			while (tickAccumulator >= TICK_SECONDS && phase === 'playing') {
				tick(state, config);

				// Check: objectives met → complete
				if (checkObjectives(level, state).met) {
					showComplete();
					break;
				}
				// Check: died → failed
				if (state.gameOver) {
					showFailed('CRASHED');
					break;
				}
				// Check: ran out of road → failed
				if (state.finished) {
					showFailed('TIME UP');
					break;
				}
				tickAccumulator -= TICK_SECONDS;
			}

			// Audio (only if still playing — might have transitioned above)
			if (phase === 'playing') {
				if (state.coinCount > preCoinCount) playCoinCollect(state.lastCollectedTier || 'gold');
				if (state.flamethrowerCharges > preCharges) playPowerupCollect();
				if (state.flameJustFired) playFlameActivate();
				if (state.character.isJumping && !preJumping) playJump();
				if (state.character.currentLane !== preLane && !preJumping) playLaneSwitch();
			}
		}

		syncRender(state, render, scene, config);
		renderFrame(scene);
		if (phase === 'playing') updateObjHud();

		requestAnimationFrame(loop);
	}

	requestAnimationFrame(loop);
}

async function startSinglePlayer(params: URLSearchParams, skin: CharacterSkin) {
	const seedParam = params.get('seed');
	const seed = seedParam
		? parseInt(seedParam, 10) >>> 0
		: (Math.random() * 0xffffffff) >>> 0;
	console.log('Boxy Run seed:', seed, 'skin:', skin.name);

	// Fetch and display game balance
	const tag = getPlayerNametag();
	const balance = await fetchGameBalance();
	updateBalanceDisplay(balance);

	const needsPayment = tag && balance !== null && balance >= ENTRY_FEE;
	const noWallet = !tag;

	const config = DEFAULT_CONFIG;
	const scene = createScene();
	const render = createRenderState(scene, skin);
	const state = makeInitialState(seed, config);
	let paused = true;
	let stopped = false;
	let entryPaid = false;

	syncRender(state, render, scene, config);
	renderFrame(scene);

	const menuBtn = `<div style="margin-top:16px"><button onclick="location.href='index.html'" style="font-family:monospace;font-size:12px;padding:8px 24px;background:transparent;color:#94a3b8;border:1px solid #334155;border-radius:6px;cursor:pointer;letter-spacing:0.1em">MENU</button></div>`;
	const playBtn = `<button onclick="window.__boxyPay()" style="font-family:monospace;font-size:14px;font-weight:bold;padding:12px 32px;background:#00e5ff;color:#060a12;border:none;border-radius:6px;cursor:pointer;letter-spacing:0.1em">PAY & PLAY</button>`;

	// Show appropriate start message
	if (noWallet) {
		showOverlay(`<div style="margin-bottom:12px">Connect your wallet to play</div><a href="index.html" style="font-family:monospace;font-size:14px;font-weight:bold;padding:12px 32px;background:#00e5ff;color:#060a12;border:none;border-radius:6px;cursor:pointer;letter-spacing:0.1em;text-decoration:none;display:inline-block">CONNECT WALLET</a>` + menuBtn);
	} else if (needsPayment) {
		showOverlay(`Pay ${ENTRY_FEE} UCT to play<br><br>${playBtn}${menuBtn}`);
	} else if (balance === null || balance < ENTRY_FEE) {
		showOverlay(`Insufficient balance (${balance ?? 0} UCT)<br>Need ${ENTRY_FEE} UCT to play<br><br><a href="index.html" style="color:#00e5ff">Deposit on Home Page</a>${menuBtn}`);
	}

	let lastFrameTime = performance.now();
	let tickAccumulator = 0;
	const keysAllowed: Record<number, boolean> = {};

	async function tryStart() {
		if (entryPaid) {
			paused = false;
			lastFrameTime = performance.now();
			tickAccumulator = 0;
			hideOverlay();
			return;
		}
		if (!tag) return; // no wallet connected
		showOverlay('Paying...');
		const ok = await deductEntryFee();
		if (ok) {
			entryPaid = true;
			const newBal = await fetchGameBalance();
			updateBalanceDisplay(newBal);
			paused = false;
			lastFrameTime = performance.now();
			tickAccumulator = 0;
			hideOverlay();
		} else {
			showOverlay('Payment failed. Try again.<br><br><button onclick="window.__boxyPay()" style="font-family:monospace;font-size:14px;font-weight:bold;padding:12px 32px;background:#00e5ff;color:#060a12;border:none;border-radius:6px;cursor:pointer;letter-spacing:0.1em">RETRY</button>' + menuBtn);
		}
	}

	(window as any).__boxyPay = tryStart;

	// Use AbortController so listeners are cleaned up on restart
	const ac = new AbortController();

	document.addEventListener('keydown', (e) => {
		if (state.gameOver) return;
		const key = e.keyCode;
		if (keysAllowed[key] === false) return;
		keysAllowed[key] = false;

		if (paused && key > 18) {
			if (entryPaid) {
				paused = false;
				lastFrameTime = performance.now();
				tickAccumulator = 0;
				hideOverlay();
				return;
			}
			return;
		}
		if (key === KEY_P) {
			paused = !paused;
			if (!paused) lastFrameTime = performance.now();
			else showOverlay('Paused. Press any key to resume.');
			return;
		}
		if (paused) return;
		const action = keyToAction(key);
		if (action) state.character.queuedActions.push(action);
	}, { signal: ac.signal });
	document.addEventListener('keyup', (e) => { keysAllowed[e.keyCode] = true; }, { signal: ac.signal });

	installTouchControls({
		onAction: (a) => {
			if (!paused && !state.gameOver) state.character.queuedActions.push(a);
		},
		onStart: () => {
			if (paused && !state.gameOver && (entryPaid)) {
				paused = false;
				lastFrameTime = performance.now();
				tickAccumulator = 0;
				hideOverlay();
			}
		},
		isPlaying: () => !paused && !state.gameOver,
	});

	function restart() {
		stopped = true;
		ac.abort(); // remove old event listeners
		const world = document.getElementById('world');
		if (world) world.innerHTML = '';
		const scoreEl = document.getElementById('score');
		const coinsEl = document.getElementById('coins');
		if (scoreEl) scoreEl.textContent = '0';
		if (coinsEl) coinsEl.textContent = '0';
		// Remove flame indicator if present
		const flameEl = document.getElementById('flame-indicator');
		if (flameEl) flameEl.remove();
		startSinglePlayer(params, skin);
	}

	(window as any).__boxyRestart = restart;

	// Audio state tracking
	let prevCoinCount = 0;
	let prevPowerupCount = state.powerups.length;
	let prevHasFlame = false;
	let prevFlameTicks = 0;
	let prevIsJumping = false;
	let prevLane = 0;
	let gameStarted = false;

	function loop() {
		if (stopped) return;
		const now = performance.now();
		let delta = (now - lastFrameTime) / 1000;
		lastFrameTime = now;
		delta = Math.min(delta, 0.1);
		if (!paused && !state.gameOver) {
			if (!gameStarted) { gameStarted = true; playGameStart(); }
			const preCoinCount = state.coinCount;
			const preCharges = state.flamethrowerCharges;
			const preJumping = state.character.isJumping;
			const preLane = state.character.currentLane;

			tickAccumulator += delta;
			while (tickAccumulator >= TICK_SECONDS && !state.gameOver) {
				tick(state, config);
				tickAccumulator -= TICK_SECONDS;
			}

			// Detect events and play sounds
			if (state.coinCount > preCoinCount) {
				playCoinCollect(state.lastCollectedTier || 'gold');
			}
			if (state.flamethrowerCharges > preCharges) playPowerupCollect();
			if (state.flameJustFired) playFlameActivate();
			if (state.character.isJumping && !preJumping) playJump();
			if (state.character.currentLane !== preLane && !preJumping) playLaneSwitch();
		}
		syncRender(state, render, scene, config);
		renderFrame(scene);
		if (state.gameOver && !paused) {
			paused = true;
			playCrash();
			// Submit score + credit coins to ledger
			const nickname = getPlayerNametag() || 'anonymous';
			submitScore(nickname, state.score, state.coinCount);
			// Refresh balance display
			fetchGameBalance().then(updateBalanceDisplay);

			showOverlay(
				`<div style="margin-bottom:8px"><strong>GAME OVER</strong></div>` +
				`<div style="font-size:0.85em;margin-bottom:4px">Score: ${state.score.toLocaleString()}</div>` +
				`<div style="font-size:0.85em;margin-bottom:16px">Coins: ${state.coinCount}</div>` +
				`<button onclick="window.__boxyRestart()" style="font-family:monospace;font-size:14px;font-weight:bold;padding:12px 32px;background:#00e5ff;color:#060a12;border:none;border-radius:6px;cursor:pointer;letter-spacing:0.1em">PLAY AGAIN</button>` +
				`<div style="margin-top:12px">${menuBtn}</div>`,
			);
		}
		requestAnimationFrame(loop);
	}

	(window as any).__boxyDebug = {
		get seed() { return state.seed; },
		get tick() { return state.tick; },
		get score() { return state.score; },
		get state() { return state; },
	};

	requestAnimationFrame(loop);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Shared utilities
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function keyToAction(key: number): CharacterAction | null {
	if (key === KEY_UP || key === KEY_W) return 'up';
	if (key === KEY_LEFT || key === KEY_A) return 'left';
	if (key === KEY_RIGHT || key === KEY_D) return 'right';
	if (key === KEY_DOWN || key === KEY_F) return 'fire';
	return null;
}


const BTN_STYLE = 'padding:12px 32px;background:#00e5ff;color:#060a12;border:2px solid #00e5ff;border-radius:6px;font-family:monospace;font-weight:bold;cursor:pointer;letter-spacing:0.1em;text-decoration:none;display:inline-block;margin:6px;';

/** Submit a score to the leaderboard API. Fire-and-forget. */
function submitScore(nickname: string, score: number, coins: number): void {
	fetch('/api/scores', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ nickname, score, coins }),
	}).then((r) => r.json())
		.then((d) => console.log('Score submitted:', d))
		.catch((e) => console.log('Score submission failed (API may be offline):', e));
}

