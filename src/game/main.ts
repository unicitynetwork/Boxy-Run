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
	disposeScene,
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
	TICK_HZ,
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
	playLevelComplete,
	playPowerupCollect,
} from '../render/audio';
import { stopAmbientMusic } from '../render/ambient-music';
import { getAudioRecordingStream, getSharedAudioContext } from '../render/audio-context';
import * as Mp4Muxer from 'mp4-muxer';

// ── Scene cleanup on page unload ─────────────────────────────────
// Babylon.js holds large GPU buffers. Disposing on unload prevents
// Safari's "significant memory" warnings.
let activeScene: SceneHandle | null = null;
window.addEventListener('pagehide', () => {
	if (activeScene) {
		disposeScene(activeScene);
		activeScene = null;
	}
});

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
	// Endpoint now requires the caller's session — players can only read
	// their own balance. Without the session it 401s.
	const session = (window as any).SphereWallet?.authSession;
	if (!session) return null;
	try {
		const r = await fetch('/api/balance/' + encodeURIComponent(tag), {
			headers: { 'Authorization': `Bearer ${session}` },
		});
		const d = await r.json();
		return typeof d.balance === 'number' ? d.balance : 0;
	} catch { return null; }
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
const KEY_SPACE = 32;
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

	// Daily challenge: ?daily=1
	if (params.get('daily') === '1') {
		pickSkin((skin) => startDailyChallenge(skin));
		return;
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
	activeScene = scene;
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
		// Endpoint binds nametag to session, so we no longer send it in
		// the body. Skip the call when there's no session — silently
		// 401-ing on every game-log call would just spam the network tab.
		const session = (window as any).SphereWallet?.authSession;
		if (!session) return;
		fetch('/api/log', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${session}`,
			},
			body: JSON.stringify({ event: `game.${event}`, data: entry }),
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
	const debugHudInterval = setInterval(updateDebugHud, 500);

	function setPhase(next: ClientPhase) {
		if (phase === next) return;
		gameLog('phase', { from: phase, to: next });
		phase = next;
		(window as any).__currentPhase = next;
		// Stop music when match is over
		if (next === 'series_end') {
			myState.gameOver = true; // ensures syncRender stops music
			stopAmbientMusic();
		}
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
			// Only reload for REMATCH (game resets to 1). Normal series
			// advance (game 2, 3) is handled by the poll's onSeriesAdvance.
			if (msg.gameNumber > 1) return;
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
		gameLog('showReadyPrompt', { message: message || 'initial', currentGame: currentGameNumber });
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
			// Synchronous: set phase + send ready immediately.
			// No setTimeout, no overlay delay. The 3-second countdown
			// (triggered by onBothReady) provides the visual pause.
			setPhase('ready_prompt');
			sendReady();
		}
	}

	beginGame(true);

	(window as any).__clickReady = () => {
		resumeAudio();
		sendReady();
	};

	let readyDeadline = 0;

	function sendReady() {
		if (phase !== 'ready_prompt') {
			gameLog('sendReady_SKIPPED', { phase });
			return;
		}
		gameLog('sendReady');
		setPhase('waiting');
		// Game 1: 10s deadline to show READY button if opponent doesn't respond.
		// Series games: no client deadline — server handles timeouts.
		readyDeadline = seriesResultBanner ? Infinity : Date.now() + 10_000;

		// Between series games, keep the death/result overlay — don't flash "Sending ready"
		if (!seriesResultBanner) {
			showOverlay(`<div style="font-size:18px">vs ${opponentName}</div>${getSeriesInfo()}<div style="font-size:13px;margin-top:10px;opacity:0.7">Sending ready…</div>`);
		}
		const waitingTimer = setTimeout(() => {
			if (phase === 'waiting' && !seriesResultBanner) updateWaitingOverlay();
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
		gameLog('updateWaitingOverlay', { remaining: Math.ceil((readyDeadline - Date.now()) / 1000), seriesBanner: !!seriesResultBanner });
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
	const waitingInterval = setInterval(() => { if (phase === 'waiting' && !seriesResultBanner) updateWaitingOverlay(); }, 500);

	/** Transition to countdown. Single-entry — second call is always a no-op. */
	let countdownLastShown = -1;
	let countdownActive = false;
	let seriesResultBanner = ''; // HTML shown above countdown between series games
	function kickCountdown(countdownStart: number) {
		if (countdownActive) return;
		if (phase !== 'waiting' && phase !== 'ready_prompt') return;
		countdownActive = true;
		setPhase('countdown');
		countdownLastShown = -1;
		function tick() {
			if (phase !== 'countdown') { hideOverlay(); return; } // phase changed under us — clean up
			const ms = countdownStart - Date.now();
			const currentSec = Math.ceil(ms / 1000);
			if (ms > 1000) {
				showOverlay(seriesResultBanner + `<div style="font-size:12px;color:#f97316;margin-bottom:6px;letter-spacing:.2em">GET READY</div><div style="font-size:56px;font-weight:800;line-height:1">${currentSec}</div>`);
				if (currentSec !== countdownLastShown) { countdownLastShown = currentSec; playBeep(1); }
				setTimeout(tick, 100);
			} else if (ms > 0) {
				showOverlay(seriesResultBanner + '<div style="font-size:12px;color:#f97316;margin-bottom:6px;letter-spacing:.2em">GET READY</div><div style="font-size:56px;font-weight:800;line-height:1">1</div>');
				if (countdownLastShown !== 1) { countdownLastShown = 1; playBeep(1); }
				setTimeout(tick, ms);
			} else {
				seriesResultBanner = '';
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
				const gameJustPlayed = (s.series.currentGame || 2) - 1;
				const gameMyScore = s.lastGameResult ? (mySide === 'A' ? s.lastGameResult.scoreA : s.lastGameResult.scoreB) : 0;
				const gameOppScore = s.lastGameResult ? (mySide === 'A' ? s.lastGameResult.scoreB : s.lastGameResult.scoreA) : 0;

				// Update state + send ready immediately (no setTimeout)
				currentGameNumber = s.series.currentGame;
				currentWinsA = newWinsA;
				currentWinsB = newWinsB;
				resetForNextGame(s);

				// Save result banner — shown above the countdown numbers
				const scoreLine = (gameMyScore || gameOppScore)
					? `<div style="font-size:12px;color:#888">${gameMyScore.toLocaleString()} — ${gameOppScore.toLocaleString()}</div>`
					: '';
				seriesResultBanner =
					`<div style="font-size:20px;font-weight:bold;color:${iWonGame ? '#2d6a4f' : '#c1121f'};margin-bottom:2px">Game ${gameJustPlayed}: ${iWonGame ? 'WIN' : 'LOSS'}</div>` +
					scoreLine +
					`<div style="font-size:11px;color:#666;letter-spacing:.2em;margin-bottom:12px">SERIES ${myWins} — ${oppWins}</div>`;
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
				const iWon = result.winner === playerName;
				gameLog('gameResult', { result, iWon });

				// Stop the game if still playing (early-decide case)
				if (phase === 'playing') {
					sendMatchDone();
					setPhase('done_sent');
					render.character.root.visible = false;
					hideOppStatus();
					if (seriesHud) seriesHud.style.display = 'none';
				}

				// In a series, show a brief result — onSeriesAdvance will
				// replace it with the countdown shortly after.
				if (bestOf > 1) {
					const myScore = mySide === 'A' ? result.scoreA : result.scoreB;
					const oppScore = mySide === 'A' ? result.scoreB : result.scoreA;
					showOverlay(
						`<div style="font-size:22px;font-weight:bold;color:${iWon ? '#2d6a4f' : '#c1121f'};margin-bottom:4px">${iWon ? 'YOU WIN!' : 'YOU LOSE'}</div>` +
						`<div style="font-size:14px;margin-bottom:4px">${myScore.toLocaleString()} — ${oppScore.toLocaleString()}</div>` +
						`<div style="font-size:12px;opacity:0.5">Next game loading…</div>`,
					);
					return;
				}

				// Bo1: show full result
				const myScore = mySide === 'A' ? result.scoreA : result.scoreB;
				const oppScore = mySide === 'A' ? result.scoreB : result.scoreA;
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
	let loopStopped = false;
	function loop() {
		if (loopStopped) return;
		const now = performance.now();
		let delta = (now - lastFrameTime) / 1000;
		lastFrameTime = now;
		delta = Math.min(delta, 0.1);

		// When not actively playing, render at 4fps to save CPU/GPU/memory.
		// Overlays, ready prompts, and results don't need 60fps.
		if (!isGameActive()) {
			syncRender(myState, render, scene, config);
			renderFrame(scene);
			setTimeout(() => requestAnimationFrame(loop), 250);
			return;
		}

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
					// down, network issue), show error after 2 minutes.
					const diedAtGame = currentGameNumber;
					setTimeout(() => {
						if (phase === 'done_sent' && currentGameNumber === diedAtGame) {
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
	activeScene = scene;
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
	let phase: 'ready' | 'playing' | 'complete' | 'failed' | 'replay' = 'ready';
	let stopped = false;

	// Input recording for replay
	const recordedInputs: { tick: number; action: string }[] = [];

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
		state.gameOver = true; // tells syncRender to stop music
		stopAmbientMusic();
		saveLevelBest(level.id, state.score);
		completeLevel(level.id);
		playGameStart();
		removeObjHud();

		// Trigger confetti celebration
		showCelebration(level.id, level.name);

		// Delay the buttons so the celebration plays first
		setTimeout(() => {
			if (phase !== 'complete') return;
			// Big primary SHARE button — animated cyan→orange gradient with
			// a soft glow, scaled up so it dominates the dialog.
			const SHARE_BTN = 'font-family:Orbitron,monospace;font-size:18px;font-weight:800;' +
				'letter-spacing:0.2em;padding:18px 44px;border:none;border-radius:8px;cursor:pointer;' +
				'color:#060a12;background:linear-gradient(90deg,#5feaff 0%,#ffd700 50%,#ff9534 100%);' +
				'background-size:200% 100%;animation:share-shine 2.4s linear infinite;' +
				'box-shadow:0 8px 28px rgba(255,149,52,0.45),0 0 0 1px rgba(95,234,255,0.5);';
			if (!document.getElementById('share-shine-style')) {
				const s = document.createElement('style');
				s.id = 'share-shine-style';
				s.textContent = '@keyframes share-shine{0%{background-position:0% 50%}100%{background-position:200% 50%}}';
				document.head.appendChild(s);
			}
			showOverlay(
				`<div style="font-size:11px;letter-spacing:0.3em;color:#4ade80;margin-bottom:6px">LEVEL ${level.id} • ${level.name}</div>` +
				`<div style="font-size:32px;font-weight:bold;color:#2d6a4f;margin-bottom:6px">COMPLETE!</div>` +
				`<div style="font-size:16px;margin-bottom:22px;opacity:0.85">Score: ${state.score.toLocaleString()}</div>` +
				`<div style="display:flex;flex-direction:column;gap:14px;align-items:center">` +
				`<button onclick="window.__boxyShareWin()" style="${SHARE_BTN}">★ SHARE ★</button>` +
				`<button onclick="location.href='levels.html'" style="${BTN_GHOST}">BACK TO LEVELS</button>` +
				`</div>`,
			);
		}, 2200);
	}

	// ── Celebration overlay: confetti + congratulations ──────────
	function showCelebration(levelId: number, levelName: string): void {
		const existing = document.getElementById('celebration');
		if (existing) existing.remove();

		const headline = 'COMPLETE';

		const wrap = document.createElement('div');
		wrap.id = 'celebration';
		wrap.style.cssText = 'position:fixed;top:7%;left:50%;transform:translateX(-50%);z-index:250;' +
			'text-align:center;font-family:Orbitron,monospace;color:#e8ecf2;' +
			'animation:celebrate 0.7s cubic-bezier(0.16,1,0.3,1) both;' +
			'pointer-events:none;padding:14px 28px;' +
			'background:rgba(8,12,22,0.55);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);' +
			'border-top:1px solid rgba(95,234,255,0.35);border-bottom:1px solid rgba(95,234,255,0.35);';
		wrap.innerHTML =
			`<div style="font-size:10px;letter-spacing:0.45em;color:#5feaff;font-weight:600;margin-bottom:6px">LEVEL ${levelId}</div>` +
			`<div style="font-size:clamp(18px,3vw,26px);font-weight:300;letter-spacing:0.32em;color:#fff;line-height:1">${headline}</div>` +
			`<div style="font-size:11px;letter-spacing:0.18em;color:#94a3b8;font-weight:500;margin-top:6px;font-style:italic">${levelName}</div>`;

		if (!document.getElementById('celebration-style')) {
			const style = document.createElement('style');
			style.id = 'celebration-style';
			style.textContent =
				'@keyframes celebrate{0%{opacity:0;transform:translateX(-50%) scale(0.4)}60%{transform:translateX(-50%) scale(1.05)}100%{opacity:1;transform:translateX(-50%) scale(1)}}';
			document.head.appendChild(style);
		}

		document.body.appendChild(wrap);
		setTimeout(() => { if (wrap.parentNode) wrap.remove(); }, 4000);
	}

	// ── Share win video — composites canvas + celebration text into a 3s video ──
	(window as any).__boxyShareWin = async () => {
		hideOverlay();
		// Re-show celebration on top
		showCelebration(level.id, level.name);
		// Re-trigger replay-record on the gameplay
		(window as any).__boxyReplay(true);
	};

	function showFailed(reason: string) {
		if (phase === 'complete' || phase === 'failed') return;
		phase = 'failed';
		state.gameOver = true; // tells syncRender to stop music
		stopAmbientMusic();
		playCrash();
		saveLevelBest(level.id, state.score);
		removeObjHud();

		showOverlay(
			`<div style="font-size:11px;letter-spacing:0.3em;opacity:0.5;margin-bottom:6px">LEVEL ${level.id}</div>` +
			`<div style="font-size:28px;font-weight:bold;color:#c1121f;margin-bottom:6px">${reason}</div>` +
			`<div style="font-size:16px;margin-bottom:22px;opacity:0.85">Score: ${state.score.toLocaleString()}</div>` +
			`<div style="display:flex;flex-direction:column;gap:14px;align-items:center">` +
			`<button onclick="window.__boxyRestart()" style="${BTN};font-size:16px;padding:14px 40px;letter-spacing:0.18em">RETRY</button>` +
			`<button onclick="location.href='levels.html'" style="${BTN_GHOST}">BACK TO LEVELS</button>` +
			`</div>`,
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
		if (action) {
			state.character.queuedActions.push(action);
			recordedInputs.push({ tick: state.tick, action });
		}
	}, { signal: ac.signal });
	document.addEventListener('keyup', (e) => { keysAllowed[e.keyCode] = true; }, { signal: ac.signal });

	installTouchControls({
		onAction: (a) => {
			if (phase === 'playing') {
				state.character.queuedActions.push(a);
				recordedInputs.push({ tick: state.tick, action: a });
			}
		},
		onStart: () => { if (phase === 'ready') beginPlaying(); },
		isPlaying: () => phase === 'playing',
	});

	// ── Replay system ───────────────────────────────────────────
	(window as any).__boxyReplay = async (record: boolean) => {
		hideOverlay();
		phase = 'replay';

		const inputs = [...recordedInputs];
		const endTick = state.tick; // tick when original game ended

		// Build a fresh sim state seeded from the level config.
		const buildState = () => {
			const s = makeInitialState(level.seed, config);
			s.treePresenceProb = level.initial.treePresenceProb;
			s.maxTreeSize = level.initial.maxTreeSize;
			s.fogDistance = level.initial.fogDistance;
			s.fogTarget = level.initial.fogDistance;
			s.maxRows = level.totalRows;
			if (level.spawns) {
				s.scriptedSpawns = level.spawns.map(sp => ({ ...sp }));
			}
			return s;
		};

		let replayState = buildState();
		let inputIdx = 0;

		// Tick the sim silently up to a target tick (no rendering).
		const seekTo = (targetTick: number) => {
			const target = Math.max(0, Math.min(endTick, Math.round(targetTick)));
			if (target < replayState.tick) {
				// Rewind: rebuild from scratch.
				replayState = buildState();
				inputIdx = 0;
			}
			while (replayState.tick < target && !replayState.gameOver && !replayState.finished) {
				while (inputIdx < inputs.length && inputs[inputIdx].tick <= replayState.tick) {
					replayState.character.queuedActions.push(inputs[inputIdx].action as any);
					inputIdx++;
				}
				tick(replayState, config);
			}
		};

		// For RECORD VIDEO, jump to last 3 seconds.
		const LAST_SECONDS = 3;
		const recordStart = Math.max(0, endTick - Math.round(LAST_SECONDS * TICK_HZ));
		console.log('[replay] endTick=' + endTick + ' recordStart=' + recordStart + ' record=' + record + ' TICK_HZ=' + TICK_HZ);
		if (record && recordStart > 0) {
			seekTo(recordStart);
			console.log('[replay] after seek: replayState.tick=' + replayState.tick + ' gameOver=' + replayState.gameOver + ' finished=' + replayState.finished);
		}

		// Reuse the existing render object so there's only one character +
		// one set of pools. syncRender disposes stale pool entries automatically.
		render.musicStarted = false;
		render.musicStopped = false;
		render.prevCoinCount = replayState.coinCount;
		render.prevFlameTicks = 0;
		render.prevLane = replayState.character.currentLane;
		render.character.root.setEnabled(true);
		if (render.dustTrail) render.dustTrail.emitRate = 0;

		// Video recording — composite the 3D canvas + overlay text into a 2D canvas
		let mediaRecorder: MediaRecorder | null = null;
		const chunks: Blob[] = [];
		let composeCanvas: HTMLCanvasElement | null = null;
		let composeCtx: CanvasRenderingContext2D | null = null;
		let composeRunning = false;
		// WebCodecs path (Chrome/Edge etc): encodes H.264 in-browser → real .mp4
		let videoEncoder: any = null;
		let audioEncoder: any = null;
		let mp4Muxer: any = null;
		let webCodecsFrames = 0;
		let webCodecsActive = false;
		let audioReader: any = null;
		let audioReaderRunning = false;
		const wasWin = (() => { try { return checkObjectives(level, state).met; } catch { return false; } })();

		// Present the finished recording in the share panel
		const presentRecording = (blob: Blob, ext: 'mp4' | 'webm') => {
			console.log('[record] presentRecording called, size=' + blob.size + ' type=' + blob.type + ' ext=' + ext);
			const filename = `boxy-run-level-${level.id}.${ext}`;
			const url = URL.createObjectURL(blob);
			const shareText = `I completed Level ${level.id}: ${level.name}! Score ${state.score.toLocaleString()} 🏆 https://boxy-run.fly.dev`;
			const canShare = !!(navigator as any).canShare?.({ files: [new File([blob], filename, { type: blob.type })] });

			const existing = document.getElementById('share-video-panel');
			if (existing) existing.remove();
			const panel = document.createElement('div');
			panel.id = 'share-video-panel';
			panel.style.cssText = 'position:fixed;inset:0;z-index:400;background:rgba(0,0,0,0.85);' +
				'display:flex;align-items:center;justify-content:center;padding:20px;' +
				'font-family:Orbitron,monospace;color:#e8ecf2';
			const card = document.createElement('div');
			card.style.cssText = 'background:rgba(8,12,22,0.96);border:1px solid rgba(95,234,255,0.35);' +
				'border-radius:10px;padding:20px;max-width:560px;width:100%;text-align:center;' +
				'box-shadow:0 10px 40px rgba(0,0,0,0.6);position:relative';
			// × close in the corner
			const closeX = document.createElement('button');
			closeX.textContent = '✕';
			closeX.title = 'Close';
			closeX.style.cssText = 'position:absolute;top:8px;right:10px;width:32px;height:32px;' +
				'background:transparent;border:none;color:#94a3b8;font-size:18px;cursor:pointer;line-height:1';
			closeX.onclick = () => { URL.revokeObjectURL(url); panel.remove(); };
			card.appendChild(closeX);
			const video = document.createElement('video');
			video.src = url;
			video.controls = true;
			video.autoplay = true;
			video.loop = true;
			video.muted = true;
			(video as any).playsInline = true;
			video.style.cssText = 'width:100%;border-radius:6px;background:#000;margin:18px 0 14px';
			card.appendChild(video);
			if (ext === 'webm') {
				const warn = document.createElement('div');
				warn.style.cssText = 'margin:8px 0;padding:10px 12px;border-radius:6px;' +
					'background:rgba(255,149,52,0.08);border:1px solid rgba(255,149,52,0.35);' +
					'color:#ffb877;font-size:12px;line-height:1.5;text-align:left';
				warn.innerHTML =
					`<strong style="color:#ff9534">Tip:</strong> This browser only produces <code>.webm</code>, which WhatsApp doesn't accept. ` +
					`Open <strong>boxy-run.fly.dev</strong> in <strong>Safari</strong> or <strong>Chrome</strong> for a shareable <code>.mp4</code>.`;
				card.appendChild(warn);
			}
			// Single primary action: SHARE on mobile (Web Share with file),
			// fallback to direct download on desktop. Shimmering gradient
			// matches the level-complete CTA so it reads as the same action.
			const shareBtn = document.createElement('button');
			shareBtn.textContent = canShare ? '★ SHARE ★' : '★ DOWNLOAD ★';
			shareBtn.style.cssText = 'font-family:Orbitron,monospace;font-size:18px;font-weight:800;' +
				'letter-spacing:0.2em;padding:18px 44px;border:none;border-radius:8px;cursor:pointer;' +
				'color:#060a12;background:linear-gradient(90deg,#5feaff 0%,#ffd700 50%,#ff9534 100%);' +
				'background-size:200% 100%;animation:share-shine 2.4s linear infinite;' +
				'box-shadow:0 8px 28px rgba(255,149,52,0.45),0 0 0 1px rgba(95,234,255,0.5);margin-top:6px';
			shareBtn.onclick = async () => {
				if (canShare) {
					try {
						const file = new File([blob], filename, { type: blob.type });
						await (navigator as any).share({ files: [file], title: 'Boxy Run', text: shareText });
					} catch (e) { console.warn('[record] share cancelled', e); }
				} else {
					const a = document.createElement('a');
					a.href = url;
					a.download = filename;
					document.body.appendChild(a);
					a.click();
					a.remove();
				}
			};
			card.appendChild(shareBtn);
			// Secondary: back to level menu so the user has a clean exit
			const backBtn = document.createElement('button');
			backBtn.textContent = 'BACK TO LEVELS';
			backBtn.style.cssText = `${BTN_GHOST};margin-top:14px`;
			backBtn.onclick = () => { location.href = 'levels.html'; };
			card.appendChild(backBtn);
			panel.appendChild(card);
			document.body.appendChild(panel);
		};

		if (record) {
			const src = scene.canvas;
			composeCanvas = document.createElement('canvas');
			// Even dimensions required by H.264; cap at 1280px wide.
			const maxW = 1280;
			const ratio = Math.min(1, maxW / src.width);
			composeCanvas.width = Math.round(src.width * ratio / 2) * 2;
			composeCanvas.height = Math.round(src.height * ratio / 2) * 2;
			composeCtx = composeCanvas.getContext('2d')!;
			const W = composeCanvas.width;
			const H = composeCanvas.height;
			// Pre-paint the FULL hook card on the canvas BEFORE captureStream
			// starts pulling frames — otherwise the very first captured
			// frame is the blank canvas, and that's what mobile players
			// (WhatsApp etc.) use as the autoplay thumbnail.
			{
				const ctx = composeCtx;
				const safeW = W * 0.78;
				const headline = ['I JUST BEAT', level.name.toUpperCase()];
				const tag = getPlayerNametag();
				const fitFont = (text: string, weight: string, maxWidth: number, ideal: number, min: number) => {
					let size = ideal;
					while (size > min) {
						ctx.font = `${weight} ${size}px Orbitron, monospace`;
						if (ctx.measureText(text).width <= maxWidth) break;
						size -= 1;
					}
					return size;
				};
				const bg = ctx.createLinearGradient(0, 0, 0, H);
				bg.addColorStop(0, '#0a1628');
				bg.addColorStop(1, '#040810');
				ctx.fillStyle = bg;
				ctx.fillRect(0, 0, W, H);
				const glow = ctx.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.45, H * 0.6);
				glow.addColorStop(0, 'rgba(95,234,255,0.18)');
				glow.addColorStop(1, 'rgba(95,234,255,0)');
				ctx.fillStyle = glow;
				ctx.fillRect(0, 0, W, H);
				ctx.textAlign = 'center';
				const eyebrow = 'B O X Y   R U N';
				const ebSize = fitFont(eyebrow, '700', safeW, Math.round(H * 0.024), 10);
				ctx.fillStyle = '#5feaff';
				ctx.font = `700 ${ebSize}px Orbitron, monospace`;
				ctx.fillText(eyebrow, W / 2, Math.round(H * 0.20));
				ctx.strokeStyle = 'rgba(95,234,255,0.4)';
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.moveTo(W * 0.36, H * 0.235);
				ctx.lineTo(W * 0.64, H * 0.235);
				ctx.stroke();
				ctx.fillStyle = '#fff';
				const headIdeal = Math.round(H * 0.07);
				const headMin = Math.round(H * 0.03);
				const sizes = headline.map(l => fitFont(l, '300', safeW, headIdeal, headMin));
				const headSize = Math.min(...sizes);
				ctx.font = `300 ${headSize}px Orbitron, monospace`;
				let y = Math.round(H * 0.44);
				for (const line of headline) {
					ctx.fillText(line, W / 2, y);
					y += Math.round(headSize * 1.15);
				}
				ctx.fillStyle = '#94a3b8';
				ctx.font = `500 ${Math.round(H * 0.018)}px Orbitron, monospace`;
				ctx.fillText('FINAL SCORE', W / 2, Math.round(H * 0.76));
				const scoreText = state.score.toLocaleString();
				const scoreSize = fitFont(scoreText, '300', safeW, Math.round(H * 0.055), Math.round(H * 0.025));
				ctx.fillStyle = '#ffd700';
				ctx.font = `300 ${scoreSize}px Orbitron, monospace`;
				ctx.fillText(scoreText, W / 2, Math.round(H * 0.83));
				if (tag) {
					ctx.fillStyle = '#94a3b8';
					ctx.font = `italic 500 ${Math.round(H * 0.018)}px Orbitron, monospace`;
					ctx.fillText('@' + tag, W / 2, Math.round(H * 0.88));
				}
				ctx.fillStyle = 'rgba(255,255,255,0.55)';
				ctx.font = `600 ${Math.round(H * 0.02)}px Orbitron, monospace`;
				ctx.fillText('boxy-run.fly.dev', W / 2, H - Math.round(H * 0.04));
			}

			// ── Decide encoding path ───────────────────────────────────
			// Priority: native MediaRecorder MP4 (Safari) > WebCodecs+mp4-muxer
			// (Chrome/Edge) > MediaRecorder WebM (Firefox).
			const mediaRecorderSupportsMp4 = typeof MediaRecorder !== 'undefined' &&
				MediaRecorder.isTypeSupported &&
				(MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01F') ||
				 MediaRecorder.isTypeSupported('video/mp4;codecs=h264') ||
				 MediaRecorder.isTypeSupported('video/mp4'));
			console.log('[record] MediaRecorder mp4 supported=' + mediaRecorderSupportsMp4);

			const hasWebCodecs = typeof (window as any).VideoEncoder !== 'undefined' &&
				typeof (window as any).VideoFrame !== 'undefined';
			let h264Supported = false;
			// Only consider WebCodecs if MediaRecorder can't already give us MP4
			// (Safari has buggy WebCodecs but works fine via MediaRecorder mp4)
			// and we're not on Firefox (its encoder doesn't supply a usable
			// decoderConfig.description).
			const isFirefox = /Firefox\//.test(navigator.userAgent);
			if (hasWebCodecs && !mediaRecorderSupportsMp4 && !isFirefox) {
				try {
					const probe = await (window as any).VideoEncoder.isConfigSupported({
						codec: 'avc1.42E01F',
						width: W,
						height: H,
						bitrate: 5_000_000,
						framerate: 30,
						avc: { format: 'avc' },
					});
					h264Supported = !!probe?.supported;
					console.log('[record] H.264 isConfigSupported=' + h264Supported);
				} catch (e) {
					console.warn('[record] isConfigSupported threw', e);
				}
			}
			if (h264Supported) {
				try {
					// AAC audio in WebCodecs path is currently disabled — it
					// caused mp4-muxer to emit an mp4 that some players
					// (WhatsApp/iOS) refuse to render (black screen).
					// Safari users get audio via MediaRecorder mp4 anyway.
					const sharedAudioStream = null as MediaStream | null;
					const audioTrack: any = null;
					const hasAudioApis = false;
					const audioSampleRate = 48000;
					const audioChannels = 2;

					mp4Muxer = new (Mp4Muxer as any).Muxer({
						target: new (Mp4Muxer as any).ArrayBufferTarget(),
						video: { codec: 'avc', width: W, height: H, frameRate: 30 },
						audio: hasAudioApis
							? { codec: 'aac', sampleRate: audioSampleRate, numberOfChannels: audioChannels }
							: undefined,
						fastStart: 'in-memory',
					});
					videoEncoder = new (window as any).VideoEncoder({
						output: (chunk: any, meta: any) => {
							// Some browsers omit decoderConfig.colorSpace; mp4-muxer 5.x
							// crashes on null. Patch the metadata defensively.
							if (meta && meta.decoderConfig && !meta.decoderConfig.colorSpace) {
								meta.decoderConfig.colorSpace = {
									primaries: 'bt709',
									transfer: 'bt709',
									matrix: 'bt709',
									fullRange: false,
								};
							}
							try {
								mp4Muxer.addVideoChunk(chunk, meta);
							} catch (err) {
								console.error('[record] addVideoChunk failed', err);
							}
						},
						error: (err: any) => console.error('[record] encoder error', err),
					});
					videoEncoder.configure({
						codec: 'avc1.42E01F', // H.264 baseline 3.1
						width: W,
						height: H,
						bitrate: 5_000_000,
						framerate: 30,
						avc: { format: 'avc' },
					});

					// ── Audio encoder (AAC) ───────────────────────────────
					if (hasAudioApis && audioTrack) {
						try {
							audioEncoder = new (window as any).AudioEncoder({
								output: (chunk: any, meta: any) => {
									try { mp4Muxer.addAudioChunk(chunk, meta); }
									catch (err) { console.error('[record] addAudioChunk failed', err); }
								},
								error: (err: any) => console.error('[record] audio encoder error', err),
							});
							audioEncoder.configure({
								codec: 'mp4a.40.2', // AAC-LC
								sampleRate: audioSampleRate,
								numberOfChannels: audioChannels,
								bitrate: 128_000,
							});
							const proc = new (window as any).MediaStreamTrackProcessor({ track: audioTrack });
							audioReader = proc.readable.getReader();
							audioReaderRunning = true;
							(async () => {
								while (audioReaderRunning && audioReader) {
									try {
										const { value, done } = await audioReader.read();
										if (done) break;
										if (audioEncoder && audioEncoder.state === 'configured') {
											audioEncoder.encode(value);
										}
										value.close();
									} catch (e) {
										console.warn('[record] audio reader err', e);
										break;
									}
								}
							})();
							console.log('[record] AAC audio encoder active sr=' + audioSampleRate);
						} catch (e) {
							console.warn('[record] audio encoder setup failed', e);
							audioEncoder = null;
						}
					}

					webCodecsActive = true;
					console.log('[record] WebCodecs H.264 → MP4 active' + (audioEncoder ? ' + AAC' : ''));
				} catch (e) {
					console.warn('[record] WebCodecs init failed, falling back to MediaRecorder', e);
					webCodecsActive = false;
					videoEncoder = null;
					audioEncoder = null;
					mp4Muxer = null;
				}
			}

			// ── MediaRecorder fallback (Safari mp4 / others webm) ────
			let mrMime: string | undefined;
			if (!webCodecsActive) {
				try {
					if (typeof (composeCanvas as any).captureStream !== 'function') {
						throw new Error('captureStream unsupported');
					}
					// Video-only stream — adding the audio track caused Safari
					// MediaRecorder to emit a black-frame mp4 (timeline ok,
					// no decodable video). Skip audio for now until we find a
					// safe way to mix it.
					const stream = (composeCanvas as any).captureStream(30);
					const candidates = [
						'video/mp4;codecs=avc1.42E01F',
						'video/mp4;codecs=h264',
						'video/mp4',
						'video/webm;codecs=vp9',
						'video/webm;codecs=vp8',
						'video/webm',
					];
					mrMime = candidates.find(t =>
						typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t),
					);
					console.log('[record] MediaRecorder mime=' + mrMime);
					mediaRecorder = new MediaRecorder(stream, mrMime ? { mimeType: mrMime, videoBitsPerSecond: 5_000_000 } : undefined);
					mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
					mediaRecorder.onerror = (e) => console.error('[record] MR error', e);
					mediaRecorder.onstop = () => {
						const blobMime = mrMime || 'video/webm';
						const ext = blobMime.includes('mp4') ? 'mp4' : 'webm';
						const blob = new Blob(chunks, { type: blobMime });
						presentRecording(blob, ext as 'mp4' | 'webm');
					};
					mediaRecorder.start();
				} catch (err: any) {
					console.error('[record] failed to start MediaRecorder', err);
					alert('Video recording is not supported in this browser.');
					phase = 'failed';
					return;
				}
			}

			// Compose function — called synchronously after each Babylon render
			composeRunning = true;
			const composeStart = performance.now();
			// Time when the playhead crosses the finish line (set by replayLoop)
			let finishCrossedAt: number | null = null;
			const triggerFinishBanner = () => {
				if (finishCrossedAt === null) finishCrossedAt = performance.now();
			};
			// Headline text depends on the level
			const finishHeadline = `LEVEL ${level.id} COMPLETE`;
			const composeFrame = () => {
				if (!composeRunning || !composeCtx || !composeCanvas) return;
				try {
					composeCtx.drawImage(scene.canvas, 0, 0, W, H);
				} catch (e) {
					console.error('[record] drawImage failed', e);
				}
				const elapsed = (performance.now() - composeStart) / 1000;

				// Top-left: tiny uppercase level info
				composeCtx.textAlign = 'left';
				const padX = Math.round(W * 0.028);
				const padY = Math.round(H * 0.045);
				composeCtx.fillStyle = '#5feaff';
				composeCtx.font = `600 ${Math.round(H * 0.018)}px Orbitron, monospace`;
				composeCtx.fillText(`LEVEL ${level.id}`.toUpperCase(), padX, padY);
				composeCtx.fillStyle = 'rgba(232,236,242,0.8)';
				composeCtx.font = `500 ${Math.round(H * 0.022)}px Orbitron, monospace`;
				composeCtx.fillText(level.name.toUpperCase(), padX, padY + Math.round(H * 0.032));

				// Top-right: score
				composeCtx.textAlign = 'right';
				composeCtx.fillStyle = '#94a3b8';
				composeCtx.font = `500 ${Math.round(H * 0.014)}px Orbitron, monospace`;
				composeCtx.fillText('SCORE', W - padX, padY);
				composeCtx.fillStyle = '#fff';
				composeCtx.font = `300 ${Math.round(H * 0.05)}px Orbitron, monospace`;
				composeCtx.fillText(replayState.score.toLocaleString(), W - padX, padY + Math.round(H * 0.05));

				// Finish banner — only after the playhead crosses the finish
				// line. Fades in over 0.35s, holds, then fades out near the end.
				if (wasWin && finishCrossedAt !== null) {
					const sinceCross = (performance.now() - finishCrossedAt) / 1000;
					const fadeIn = Math.min(1, sinceCross / 0.35);
					// Hold for at least 1.4s, then fade out over 0.4s
					const holdEnd = 1.4;
					const fadeOut = sinceCross < holdEnd ? 1 : Math.max(0, 1 - (sinceCross - holdEnd) / 0.4);
					const fade = fadeIn * fadeOut;
					if (fade > 0.01) {
						composeCtx.save();
						composeCtx.globalAlpha = fade;
						const bandH = Math.round(H * 0.22);
						const bandY = H - bandH - Math.round(H * 0.06);
						const bg = composeCtx.createLinearGradient(0, bandY, 0, bandY + bandH);
						bg.addColorStop(0, 'rgba(8,12,22,0)');
						bg.addColorStop(0.4, 'rgba(8,12,22,0.6)');
						bg.addColorStop(1, 'rgba(8,12,22,0.6)');
						composeCtx.fillStyle = bg;
						composeCtx.fillRect(0, bandY, W, bandH);
						composeCtx.strokeStyle = 'rgba(95,234,255,0.6)';
						composeCtx.lineWidth = 1;
						composeCtx.beginPath();
						composeCtx.moveTo(W * 0.22, bandY + Math.round(H * 0.04));
						composeCtx.lineTo(W * 0.78, bandY + Math.round(H * 0.04));
						composeCtx.stroke();
						composeCtx.textAlign = 'center';
						composeCtx.fillStyle = '#fff';
						// Auto-fit headline to 78% of width so it isn't cut off
						// by mobile portrait crops
						const safe = W * 0.78;
						let headSize = Math.round(H * 0.07);
						const headMin = Math.round(H * 0.03);
						while (headSize > headMin) {
							composeCtx.font = `300 ${headSize}px Orbitron, monospace`;
							if (composeCtx.measureText(finishHeadline).width <= safe) break;
							headSize -= 1;
						}
						composeCtx.fillText(finishHeadline, W / 2, bandY + Math.round(H * 0.105));
						composeCtx.fillStyle = '#94a3b8';
						composeCtx.font = `italic 500 ${Math.round(H * 0.018)}px Orbitron, monospace`;
						composeCtx.fillText(level.name, W / 2, bandY + Math.round(H * 0.155));
						composeCtx.strokeStyle = 'rgba(95,234,255,0.4)';
						composeCtx.beginPath();
						composeCtx.moveTo(W * 0.30, bandY + bandH - Math.round(H * 0.025));
						composeCtx.lineTo(W * 0.70, bandY + bandH - Math.round(H * 0.025));
						composeCtx.stroke();
						composeCtx.restore();
					}
				}

				// Footer URL
				composeCtx.textAlign = 'center';
				composeCtx.fillStyle = 'rgba(255,255,255,0.4)';
				composeCtx.font = `500 ${Math.round(H * 0.014)}px Orbitron, monospace`;
				composeCtx.fillText('boxy-run.fly.dev', W / 2, H - Math.round(H * 0.022));

				// Feed the WebCodecs encoder (in-browser H.264 → MP4)
				if (webCodecsActive && videoEncoder) {
					try {
						const ts = (webCodecsFrames * 1_000_000) / 30; // microseconds
						const VF = (window as any).VideoFrame;
						const frame = new VF(composeCanvas, { timestamp: ts });
						videoEncoder.encode(frame, { keyFrame: webCodecsFrames % 60 === 0 });
						frame.close();
						webCodecsFrames++;
					} catch (e) {
						console.error('[record] encode failed', e);
					}
				}
			};
			(window as any).__boxyComposeFrame = composeFrame;
			(window as any).__boxyTriggerFinishBanner = triggerFinishBanner;

			// ── 1-second hook card before the gameplay clip ────────────
			// Drawn into composeCanvas + fed to the encoder so it lands at
			// the START of the saved video — that becomes the autoplay
			// thumbnail in social feeds.
			const hookHeadline = ['I JUST BEAT', level.name.toUpperCase()];
			const hookNametag = getPlayerNametag();
			const drawHookCard = () => {
				if (!composeCtx || !composeCanvas) return;
				const ctx = composeCtx;
				// Background gradient
				const bg = ctx.createLinearGradient(0, 0, 0, H);
				bg.addColorStop(0, '#0a1628');
				bg.addColorStop(1, '#040810');
				ctx.fillStyle = bg;
				ctx.fillRect(0, 0, W, H);
				// Glow blob behind headline
				const glow = ctx.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.45, H * 0.6);
				glow.addColorStop(0, 'rgba(95,234,255,0.18)');
				glow.addColorStop(1, 'rgba(95,234,255,0)');
				ctx.fillStyle = glow;
				ctx.fillRect(0, 0, W, H);

				// Helper: pick the largest font that fits maxWidth
				const fitFont = (text: string, weight: string, maxWidth: number, ideal: number, min: number) => {
					let size = ideal;
					while (size > min) {
						ctx.font = `${weight} ${size}px Orbitron, monospace`;
						if (ctx.measureText(text).width <= maxWidth) break;
						size -= 1;
					}
					return size;
				};
				ctx.textAlign = 'center';
				const safeW = W * 0.78; // safe area for text (mobile crop)

				// Big BOXY RUN wordmark at the top
				const eyebrow = 'BOXY RUN';
				const ebSize = fitFont(eyebrow, '900', safeW, Math.round(H * 0.085), Math.round(H * 0.04));
				// Glow behind
				ctx.save();
				ctx.shadowColor = 'rgba(95,234,255,0.7)';
				ctx.shadowBlur = Math.round(H * 0.04);
				ctx.fillStyle = '#5feaff';
				ctx.font = `900 ${ebSize}px Orbitron, monospace`;
				ctx.fillText(eyebrow, W / 2, Math.round(H * 0.18));
				ctx.restore();
				// Accent line under wordmark
				ctx.strokeStyle = 'rgba(95,234,255,0.5)';
				ctx.lineWidth = 1.5;
				ctx.beginPath();
				ctx.moveTo(W * 0.32, H * 0.225);
				ctx.lineTo(W * 0.68, H * 0.225);
				ctx.stroke();

				// Headline — auto-fit each line within safe width
				ctx.fillStyle = '#fff';
				const headlineIdeal = Math.round(H * 0.06);
				const headlineMin = Math.round(H * 0.028);
				const lineSizes: number[] = [];
				for (const line of hookHeadline) {
					lineSizes.push(fitFont(line, '300', safeW, headlineIdeal, headlineMin));
				}
				const headlineSize = Math.min(...lineSizes);
				ctx.font = `300 ${headlineSize}px Orbitron, monospace`;
				let y = Math.round(H * (hookHeadline.length === 2 ? 0.46 : 0.52));
				for (const line of hookHeadline) {
					ctx.fillText(line, W / 2, y);
					y += Math.round(headlineSize * 1.15);
				}

				// Score block
				ctx.fillStyle = '#94a3b8';
				ctx.font = `500 ${Math.round(H * 0.018)}px Orbitron, monospace`;
				ctx.fillText('FINAL SCORE', W / 2, Math.round(H * 0.78));
				const scoreText = state.score.toLocaleString();
				const scoreSize = fitFont(scoreText, '300', safeW, Math.round(H * 0.055), Math.round(H * 0.025));
				ctx.fillStyle = '#ffd700';
				ctx.font = `300 ${scoreSize}px Orbitron, monospace`;
				ctx.fillText(scoreText, W / 2, Math.round(H * 0.85));
				// Nametag (if set)
				if (hookNametag) {
					ctx.fillStyle = '#94a3b8';
					ctx.font = `italic 500 ${Math.round(H * 0.018)}px Orbitron, monospace`;
					ctx.fillText('@' + hookNametag, W / 2, Math.round(H * 0.90));
				}
				// Footer URL
				ctx.fillStyle = 'rgba(255,255,255,0.55)';
				ctx.font = `600 ${Math.round(H * 0.02)}px Orbitron, monospace`;
				ctx.fillText('boxy-run.fly.dev', W / 2, H - Math.round(H * 0.035));
			};
			(window as any).__boxyDrawHookCard = drawHookCard;
		}

		hideOverlay();
		let replayLabel = document.getElementById('replay-label');
		if (!replayLabel) {
			replayLabel = document.createElement('div');
			replayLabel.id = 'replay-label';
			replayLabel.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);' +
				'font-family:monospace;font-size:11px;letter-spacing:.3em;color:#ff9534;' +
				'background:rgba(0,0,0,0.6);padding:6px 18px;border-radius:4px;' +
				'pointer-events:none;z-index:300;border:1px solid rgba(255,149,52,0.4)';
			document.body.appendChild(replayLabel);
		}
		replayLabel.textContent = record ? '● RECORDING' : 'REPLAY';

		// Playback controls (only for WATCH REPLAY, not RECORD VIDEO)
		let paused = false;
		let speed = 1;
		let controls: HTMLDivElement | null = null;
		let progressFill: HTMLDivElement | null = null;
		let progressTime: HTMLSpanElement | null = null;
		let playPauseBtn: HTMLButtonElement | null = null;
		let finished = false;
		const cleanupControls = () => {
			if (controls) { controls.remove(); controls = null; }
		};
		if (!record) {
			controls = document.createElement('div');
			controls.id = 'replay-controls';
			controls.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);' +
				'z-index:300;background:rgba(8,12,22,0.92);border:1px solid rgba(95,234,255,0.3);' +
				'border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:10px;' +
				'font-family:monospace;color:#e8ecf2;backdrop-filter:blur(8px);' +
				'box-shadow:0 4px 24px rgba(0,0,0,0.5);max-width:92vw;flex-wrap:wrap;justify-content:center';
			const btnStyle = 'background:transparent;border:1px solid rgba(95,234,255,0.3);' +
				'color:#e8ecf2;font-family:monospace;font-size:14px;padding:6px 12px;border-radius:4px;' +
				'cursor:pointer;min-width:36px';
			const mkBtn = (label: string, title: string, onClick: () => void) => {
				const b = document.createElement('button');
				b.textContent = label;
				b.title = title;
				b.style.cssText = btnStyle;
				b.onclick = onClick;
				return b;
			};
			const hidePanel = () => {
				const p = document.getElementById('replay-end-panel');
				if (p) p.remove();
			};
			const restartBtn = mkBtn('⏮', 'Restart', () => { paused = false; finished = false; seekTo(0); hidePanel(); updatePlayPause(); });
			const back1Btn = mkBtn('⏪', 'Back 1s', () => { finished = false; seekTo(replayState.tick - TICK_HZ); hidePanel(); });
			playPauseBtn = mkBtn('⏸', 'Pause / Play', () => {
				if (finished) { finished = false; seekTo(0); paused = false; hidePanel(); }
				else paused = !paused;
				updatePlayPause();
			});
			const fwd1Btn = mkBtn('⏩', 'Forward 1s', () => { seekTo(replayState.tick + TICK_HZ); });
			const speedBtn = mkBtn('1x', 'Speed', () => {
				speed = speed === 1 ? 0.5 : speed === 0.5 ? 2 : 1;
				speedBtn.textContent = speed + 'x';
			});
			const closeBtn = mkBtn('✕', 'Close', () => {
				phase = 'failed';
				cleanupReplayChrome();
				if (state.gameOver) {
					if (checkObjectives(level, state).met) showComplete();
					else showFailed('CRASHED');
				}
			});

			// Progress bar
			const progress = document.createElement('div');
			progress.style.cssText = 'flex:1;min-width:160px;height:6px;background:rgba(95,234,255,0.15);' +
				'border-radius:3px;cursor:pointer;position:relative;margin:0 4px';
			progressFill = document.createElement('div');
			progressFill.style.cssText = 'height:100%;background:#5feaff;border-radius:3px;width:0%;' +
				'transition:width 0.05s linear';
			progress.appendChild(progressFill);
			progress.onclick = (e) => {
				const rect = progress.getBoundingClientRect();
				const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
				finished = false;
				seekTo(ratio * endTick);
			};

			progressTime = document.createElement('span');
			progressTime.style.cssText = 'font-size:11px;color:#94a3b8;min-width:64px;text-align:right';

			const updatePlayPause = () => {
				if (playPauseBtn) playPauseBtn.textContent = paused || finished ? '▶' : '⏸';
			};

			controls.appendChild(restartBtn);
			controls.appendChild(back1Btn);
			controls.appendChild(playPauseBtn);
			controls.appendChild(fwd1Btn);
			controls.appendChild(speedBtn);
			controls.appendChild(progress);
			controls.appendChild(progressTime);
			controls.appendChild(closeBtn);
			document.body.appendChild(controls);
		}

		const cleanupReplayChrome = () => {
			cleanupControls();
			const lbl = document.getElementById('replay-label');
			if (lbl) lbl.remove();
			const panel = document.getElementById('replay-end-panel');
			if (panel) panel.remove();
		};

		const showReplayEndPanel = () => {
			if (record) return;
			let panel = document.getElementById('replay-end-panel');
			if (panel) return;
			const wasComplete = !state.gameOver || state.finished
				? false
				: false;
			// state.gameOver was set true by both showComplete and showFailed; use phase context
			const wasWin = (() => {
				try { return checkObjectives(level, state).met; } catch { return false; }
			})();
			panel = document.createElement('div');
			panel.id = 'replay-end-panel';
			panel.style.cssText = 'position:fixed;top:48px;left:50%;transform:translateX(-50%);' +
				'z-index:301;background:rgba(8,12,22,0.94);border:1px solid rgba(95,234,255,0.35);' +
				'border-radius:10px;padding:16px 22px;font-family:Orbitron,monospace;color:#e8ecf2;' +
				'text-align:center;backdrop-filter:blur(8px);box-shadow:0 8px 30px rgba(0,0,0,0.6);' +
				'max-width:92vw;animation:fadeInBanner 0.3s ease';
			const nextLevel = LEVELS.find(l => l.id === level.id + 1);
			const headline = wasWin ? 'REPLAY COMPLETE' : 'REPLAY ENDED';
			const headlineColor = wasWin ? '#4ade80' : '#5feaff';
			const nextHtml = wasWin && nextLevel
				? `<button data-act="next" style="${BTN}">NEXT LEVEL</button>`
				: '';
			panel.innerHTML =
				`<div style="font-size:11px;letter-spacing:0.3em;color:${headlineColor};margin-bottom:6px">${headline}</div>` +
				`<div style="font-size:18px;font-weight:bold;margin-bottom:14px">Level ${level.id}: ${level.name}</div>` +
				`<div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">` +
				nextHtml +
				`<button data-act="again" style="${BTN_GHOST}">WATCH AGAIN</button>` +
				`<button data-act="retry" style="${BTN_GHOST}">RETRY LEVEL</button>` +
				`<button data-act="levels" style="${BTN_GHOST}">LEVEL MENU</button>` +
				`</div>`;
			document.body.appendChild(panel);
			panel.querySelector<HTMLButtonElement>('[data-act="next"]')?.addEventListener('click', () => {
				if (nextLevel) location.href = `dev.html?level=${nextLevel.id}`;
			});
			panel.querySelector<HTMLButtonElement>('[data-act="again"]')?.addEventListener('click', () => {
				panel!.remove();
				finished = false;
				paused = false;
				seekTo(0);
				if (playPauseBtn) playPauseBtn.textContent = '⏸';
			});
			panel.querySelector<HTMLButtonElement>('[data-act="retry"]')?.addEventListener('click', () => {
				cleanupReplayChrome();
				phase = 'failed';
				(window as any).__boxyRestart();
			});
			panel.querySelector<HTMLButtonElement>('[data-act="levels"]')?.addEventListener('click', () => {
				location.href = 'levels.html';
			});
		};

		let replayFrame = performance.now();
		let replayAcc = 0;
		let prevReplayTick = replayState.tick;

		function replayLoop() {
			if (phase !== 'replay') return;
			const now = performance.now();
			let delta = (now - replayFrame) / 1000;
			replayFrame = now;
			delta = Math.min(delta, 0.1);

			if (!paused && !finished) {
				replayAcc += delta * speed;
				while (replayAcc >= TICK_SECONDS && !replayState.gameOver && !replayState.finished && replayState.tick < endTick) {
					while (inputIdx < inputs.length && inputs[inputIdx].tick <= replayState.tick) {
						replayState.character.queuedActions.push(inputs[inputIdx].action as any);
						inputIdx++;
					}
					tick(replayState, config);
					replayAcc -= TICK_SECONDS;
				}
			}

			const scoreEl = document.getElementById('score');
			const coinsEl = document.getElementById('coins');
			if (scoreEl) scoreEl.textContent = replayState.score.toLocaleString();
			if (coinsEl) coinsEl.textContent = String(replayState.coinCount);

			// Position the finish line so it sits at the camera exactly when
			// the original game ended — but only if the player actually
			// completed the level. If they crashed early there's no real
			// finish to show.
			if (wasWin) {
				const moveDistance = config.moveSpeed * TICK_SECONDS;
				(replayState as any).__finishLineZ = (replayState.tick - endTick) * moveDistance;
			} else {
				(replayState as any).__finishLineZ = undefined;
			}
			// Keep music playing for the entire replay/recording, even past
			// the recorded gameOver/finished tick.
			(replayState as any).__forceMusic = true;
			// Fire the level-complete fanfare + finish banner when the
			// playhead crosses the finish line (won runs only). Edge-triggered.
			const finishThreshold = endTick - 20;
			if (wasWin && prevReplayTick < finishThreshold && replayState.tick >= finishThreshold) {
				playLevelComplete();
				const fb = (window as any).__boxyTriggerFinishBanner;
				if (typeof fb === 'function') fb();
			}
			prevReplayTick = replayState.tick;

			syncRender(replayState, render, scene, config);
			renderFrame(scene);
			// Composite into the recording canvas in the SAME frame as the
			// WebGL render so drawImage sees fresh pixels.
			const composeFn = (window as any).__boxyComposeFrame;
			if (record && typeof composeFn === 'function') composeFn();

			// Update progress UI
			if (progressFill && endTick > 0) {
				progressFill.style.width = Math.min(100, (replayState.tick / endTick) * 100) + '%';
			}
			if (progressTime) {
				const cur = (replayState.tick / TICK_HZ).toFixed(1);
				const tot = (endTick / TICK_HZ).toFixed(1);
				progressTime.textContent = cur + 's / ' + tot + 's';
			}

			const ended = replayState.gameOver || replayState.finished || replayState.tick >= endTick;

			if (ended && record) {
				console.log('[replay] ended at tick=' + replayState.tick + ' endTick=' + endTick + ' gameOver=' + replayState.gameOver + ' finished=' + replayState.finished);
				// Give the encoder ~1s of trailing frames, then finalize
				setTimeout(async () => {
					composeRunning = false;
					if (webCodecsActive && videoEncoder && mp4Muxer) {
						console.log('[record] flushing encoder, frames=' + webCodecsFrames);
						try {
							// Stop pulling audio + flush both encoders
							audioReaderRunning = false;
							if (audioReader) {
								try { await audioReader.cancel(); } catch {}
							}
							if (audioEncoder) {
								try { await audioEncoder.flush(); audioEncoder.close(); } catch (e) { console.warn('[record] audio flush err', e); }
							}
							await videoEncoder.flush();
							console.log('[record] encoder flushed');
							videoEncoder.close();
							mp4Muxer.finalize();
							const buffer = mp4Muxer.target.buffer;
							console.log('[record] finalized, mp4 size=' + buffer.byteLength);
							const blob = new Blob([buffer], { type: 'video/mp4' });
							presentRecording(blob, 'mp4');
						} catch (e) {
							console.error('[record] WebCodecs finalize failed', e);
							alert('Recording failed: ' + (e as any)?.message);
						}
					} else if (mediaRecorder && mediaRecorder.state === 'recording') {
						console.log('[record] stopping MediaRecorder');
						mediaRecorder.stop();
					} else {
						console.warn('[record] no encoder/recorder to stop');
					}
				}, 1000);
				// For record mode, the share panel is the post-recording UI;
				// don't pile a REPLAY COMPLETE overlay on top.
				setTimeout(() => {
					phase = 'failed';
					const lbl = document.getElementById('replay-label');
					if (lbl) lbl.remove();
				}, 1500);
				return;
			}

			// For watch mode, mark finished but stay in replay so user can scrub/restart
			if (ended && !finished) {
				finished = true;
				showReplayEndPanel();
				if (playPauseBtn) playPauseBtn.textContent = '▶';
			}

			requestAnimationFrame(replayLoop);
		}

		// If recording, run a 1-second hook card BEFORE the gameplay clip
		// starts. The recorder is already running; we just feed it hook
		// frames for ~30 frames, then hand off to replayLoop.
		if (record) {
			const drawHookCard = (window as any).__boxyDrawHookCard;
			const W2 = composeCanvas?.width || 0;
			const H2 = composeCanvas?.height || 0;
			const VF = (window as any).VideoFrame;
			const HOOK_MS = 1000;
			const hookEndAt = performance.now() + HOOK_MS;
			await new Promise<void>((resolve) => {
				const tickHook = () => {
					if (!composeCanvas || !composeCtx) { resolve(); return; }
					if (typeof drawHookCard === 'function') drawHookCard();
					// Feed WebCodecs encoder so hook lands in the mp4 too
					if (webCodecsActive && videoEncoder && VF) {
						try {
							const ts = (webCodecsFrames * 1_000_000) / 30;
							const f = new VF(composeCanvas, { timestamp: ts });
							videoEncoder.encode(f, { keyFrame: webCodecsFrames % 60 === 0 });
							f.close();
							webCodecsFrames++;
						} catch (e) { /* ignore */ }
					}
					if (performance.now() >= hookEndAt) { resolve(); return; }
					requestAnimationFrame(tickHook);
				};
				requestAnimationFrame(tickHook);
			});
		}

		requestAnimationFrame(replayLoop);
	};

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
		// Yield rendering to the replay loop while it's running
		if (phase === 'replay') {
			setTimeout(() => requestAnimationFrame(loop), 250);
			return;
		}
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

		if (phase === 'playing') {
			requestAnimationFrame(loop);
		} else {
			// Throttle to 4fps when not playing (overlays, results)
			setTimeout(() => requestAnimationFrame(loop), 250);
		}
	}

	requestAnimationFrame(loop);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Daily Challenge — same seed for everyone, one attempt per day
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function dailySeed(): number {
	const dateStr = new Date().toISOString().split('T')[0];
	let hash = 0;
	for (let i = 0; i < dateStr.length; i++) {
		hash = ((hash << 5) - hash + dateStr.charCodeAt(i)) | 0;
	}
	return hash >>> 0;
}

function todayStr(): string {
	return new Date().toISOString().split('T')[0];
}

async function startDailyChallenge(skin: CharacterSkin) {
	const today = todayStr();
	const played = localStorage.getItem('boxyrun-daily-date');

	if (played === today) {
		showOverlay(
			`<div style="font-size:11px;letter-spacing:0.3em;color:#ff9534;margin-bottom:8px">DAILY CHALLENGE</div>` +
			`<div style="font-size:20px;font-weight:bold;margin-bottom:12px">Already played today!</div>` +
			`<div style="font-size:13px;color:#94a3b8;margin-bottom:16px">Come back tomorrow for a new challenge.</div>` +
			`<a href="index.html" style="font-family:monospace;font-size:13px;padding:10px 24px;background:transparent;color:#5feaff;border:1px solid rgba(95,234,255,0.4);border-radius:6px;text-decoration:none;letter-spacing:0.1em">BACK TO MENU</a>`,
		);
		return;
	}

	const seed = dailySeed();
	const config = DEFAULT_CONFIG;
	let state = makeInitialState(seed, config);
	const scene = createScene();
	activeScene = scene;
	const render = createRenderState(scene, skin);

	let phase: 'ready' | 'playing' | 'dead' = 'ready';
	let lastFrameTime = performance.now();
	let tickAccumulator = 0;
	const recordedInputs: { tick: number; action: string }[] = [];
	const recordAction = (a: string) => {
		if (phase === 'playing') recordedInputs.push({ tick: state.tick, action: a });
	};

	showOverlay(
		`<div style="font-size:11px;letter-spacing:0.3em;color:#ff9534;margin-bottom:8px">DAILY CHALLENGE</div>` +
		`<div style="font-size:14px;color:#94a3b8;margin-bottom:4px">${today}</div>` +
		`<div style="font-size:13px;color:#cbd5e1;margin-bottom:16px">Same seed for everyone. One attempt.</div>` +
		`<button onclick="window.__dailyStart()" style="font-family:monospace;font-size:14px;font-weight:bold;padding:12px 32px;background:#ff9534;color:#060a12;border:none;border-radius:6px;cursor:pointer;letter-spacing:0.1em">START</button>`,
	);

	(window as any).__dailyStart = () => {
		resumeAudio();
		hideOverlay();
		phase = 'playing';
		lastFrameTime = performance.now();
	};

	// Touch controls
	installTouchControls({
		onAction(a) {
			if (phase === 'playing') {
				state.character.queuedActions.push(a);
				recordAction(a);
			}
		},
		onStart() { if (phase === 'ready') (window as any).__dailyStart(); },
		isPlaying() { return phase === 'playing'; },
	});

	// Keyboard
	document.addEventListener('keydown', (e) => {
		const key = e.key;
		if (phase === 'ready' && (key === ' ' || key === 'w' || key === 'W' || key === 'ArrowUp')) {
			e.preventDefault();
			(window as any).__dailyStart();
			return;
		}
		if (phase !== 'playing') return;
		e.preventDefault();
		const push = (a: 'up' | 'left' | 'right' | 'fire') => {
			state.character.queuedActions.push(a);
			recordAction(a);
		};
		switch (key) {
			case 'w': case 'W': case 'ArrowUp': case ' ': push('up'); break;
			case 'a': case 'A': case 'ArrowLeft': push('left'); break;
			case 'd': case 'D': case 'ArrowRight': push('right'); break;
			case 's': case 'S': case 'ArrowDown': case 'f': case 'F': push('fire'); break;
		}
	});

	// HUD
	const scoreEl = document.getElementById('score');
	const coinsEl = document.getElementById('coins');
	const mobileScore = document.getElementById('mobile-score');
	const mobileCoins = document.getElementById('mobile-coins');

	function updateHud() {
		if (scoreEl) scoreEl.textContent = state.score.toLocaleString();
		if (coinsEl) coinsEl.textContent = String(state.coinCount);
		if (mobileScore) mobileScore.textContent = state.score.toLocaleString();
		if (mobileCoins) mobileCoins.textContent = `${state.coinCount} coins`;
	}

	const BTN = 'font-family:monospace;font-size:14px;font-weight:bold;padding:12px 32px;background:#00e5ff;color:#060a12;border:none;border-radius:6px;cursor:pointer;letter-spacing:0.1em;text-decoration:none;display:inline-block;';

	function loop() {
		const now = performance.now();
		let delta = (now - lastFrameTime) / 1000;
		lastFrameTime = now;
		delta = Math.min(delta, 0.1);

		if (phase === 'playing') {
			const preCoinCount = state.coinCount;
			const preCharges = state.flamethrowerCharges;
			const preJumping = state.character.isJumping;
			const preLane = state.character.currentLane;

			tickAccumulator += delta;
			while (tickAccumulator >= TICK_SECONDS && phase === 'playing') {
				tick(state, config);
				if (state.gameOver) {
					phase = 'dead';
					playCrash();
					render.character.root.visible = false;

					// Mark as played
					localStorage.setItem('boxyrun-daily-date', today);

					// Submit score — server replays the inputs to verify the score
					const nickname = getPlayerNametag() || 'anonymous';
					const wireInputs = recordedInputs.map(i => ({ tick: i.tick, payload: btoa(i.action) }));
					fetch('/api/daily-challenge/scores', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ nickname, inputs: wireInputs, date: today }),
					}).catch(() => {});

					// Also submit to regular leaderboard
					submitScore(nickname, seed, recordedInputs);

					showOverlay(
						`<div style="font-size:11px;letter-spacing:0.3em;color:#ff9534;margin-bottom:8px">DAILY CHALLENGE</div>` +
						`<div style="font-size:24px;font-weight:bold;margin-bottom:4px">GAME OVER</div>` +
						`<div style="font-size:20px;margin-bottom:4px">Score: ${state.score.toLocaleString()}</div>` +
						`<div style="font-size:13px;color:#ffd700;margin-bottom:16px">${state.coinCount} coins</div>` +
						`<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">` +
						`<button onclick="window.__dailyShare()" style="${BTN}background:transparent;color:#5feaff;border:1px solid rgba(95,234,255,0.4)">SHARE</button>` +
						`<a href="index.html" style="${BTN}">MENU</a>` +
						`</div>`,
					);
					break;
				}
				tickAccumulator -= TICK_SECONDS;
			}

			if (phase === 'playing') {
				if (state.coinCount > preCoinCount) playCoinCollect(state.lastCollectedTier || 'gold');
				if (state.flamethrowerCharges > preCharges) playPowerupCollect();
				if (state.flameJustFired) playFlameActivate();
				if (state.character.isJumping && !preJumping) playJump();
				if (state.character.currentLane !== preLane && !preJumping) playLaneSwitch();
			}
		}

		updateHud();
		syncRender(state, render, scene, config);
		renderFrame(scene);

		if (phase === 'playing') {
			requestAnimationFrame(loop);
		} else {
			setTimeout(() => requestAnimationFrame(loop), 250);
		}
	}

	// Share handler
	(window as any).__dailyShare = async () => {
		const { generateShareCard, shareOrDownload } = await import('./share-card');
		const blob = await generateShareCard({
			score: state.score, coins: state.coinCount, isDaily: true,
			playerName: getPlayerNametag() || undefined,
		});
		await shareOrDownload(blob, state.score);
	};

	requestAnimationFrame(loop);
}

async function startSinglePlayer(params: URLSearchParams, skin: CharacterSkin) {
	const seedParam = params.get('seed');
	const seed = seedParam
		? parseInt(seedParam, 10) >>> 0
		: (Math.random() * 0xffffffff) >>> 0;
	console.log('Boxy Run seed:', seed, 'skin:', skin.name);

	// Fetch and display game balance (informational only — solo play is free)
	fetchGameBalance().then(updateBalanceDisplay);

	const config = DEFAULT_CONFIG;
	const scene = createScene();
	activeScene = scene;
	const render = createRenderState(scene, skin);
	const state = makeInitialState(seed, config);
	let paused = true;
	let stopped = false;
	const entryPaid = true;

	syncRender(state, render, scene, config);
	renderFrame(scene);

	const menuBtn = `<div style="margin-top:16px"><button onclick="location.href='index.html'" style="font-family:monospace;font-size:12px;padding:8px 24px;background:transparent;color:#94a3b8;border:1px solid #334155;border-radius:6px;cursor:pointer;letter-spacing:0.1em">MENU</button></div>`;

	showOverlay(`<div style="font-size:18px;font-weight:bold;margin-bottom:8px">BOXY RUN</div><div style="font-size:13px;opacity:0.7;margin-bottom:12px">Press any key to start</div>` + menuBtn);

	let lastFrameTime = performance.now();
	let tickAccumulator = 0;
	const keysAllowed: Record<number, boolean> = {};
	const recordedInputs: { tick: number; action: string }[] = [];

	function tryStart() {
		paused = false;
		lastFrameTime = performance.now();
		tickAccumulator = 0;
		hideOverlay();
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
		if (action) {
			state.character.queuedActions.push(action);
			recordedInputs.push({ tick: state.tick, action });
		}
	}, { signal: ac.signal });
	document.addEventListener('keyup', (e) => { keysAllowed[e.keyCode] = true; }, { signal: ac.signal });

	installTouchControls({
		onAction: (a) => {
			if (!paused && !state.gameOver) {
				state.character.queuedActions.push(a);
				recordedInputs.push({ tick: state.tick, action: a });
			}
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
			submitScore(nickname, seed, recordedInputs);
			// Refresh balance display
			fetchGameBalance().then(updateBalanceDisplay);

			showOverlay(
				`<div style="margin-bottom:8px"><strong>GAME OVER</strong></div>` +
				`<div style="font-size:0.85em;margin-bottom:4px">Score: ${state.score.toLocaleString()}</div>` +
				`<div style="font-size:0.85em;margin-bottom:16px">Coins: ${state.coinCount}</div>` +
				`<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">` +
				`<button onclick="window.__boxyRestart()" style="font-family:monospace;font-size:14px;font-weight:bold;padding:12px 32px;background:#00e5ff;color:#060a12;border:none;border-radius:6px;cursor:pointer;letter-spacing:0.1em">PLAY AGAIN</button>` +
				`<button onclick="window.__boxyShare()" style="font-family:monospace;font-size:12px;padding:10px 24px;background:transparent;color:#5feaff;border:1px solid rgba(95,234,255,0.4);border-radius:6px;cursor:pointer;letter-spacing:0.1em">SHARE</button>` +
				`</div>` +
				`<div style="margin-top:12px">${menuBtn}</div>`,
			);
		}
		if (paused) {
			// Throttle to 4fps when paused/dead (overlay showing)
			setTimeout(() => requestAnimationFrame(loop), 250);
		} else {
			requestAnimationFrame(loop);
		}
	}

	(window as any).__boxyDebug = {
		get seed() { return state.seed; },
		get tick() { return state.tick; },
		get score() { return state.score; },
		get state() { return state; },
	};

	(window as any).__boxyShare = async () => {
		const { generateShareCard, shareOrDownload } = await import('./share-card');
		const blob = await generateShareCard({
			score: state.score, coins: state.coinCount, isDaily: false,
			playerName: getPlayerNametag() || undefined,
		});
		await shareOrDownload(blob, state.score);
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
	if (key === KEY_DOWN || key === KEY_F || key === KEY_SPACE) return 'fire';
	return null;
}


const BTN_STYLE = 'padding:12px 32px;background:#00e5ff;color:#060a12;border:2px solid #00e5ff;border-radius:6px;font-family:monospace;font-weight:bold;cursor:pointer;letter-spacing:0.1em;text-decoration:none;display:inline-block;margin:6px;';

/**
 * Submit a score to the leaderboard API. Fire-and-forget.
 * The server replays the seed + inputs to derive the authoritative score —
 * clients can't fabricate scores any more. Inputs are base64-encoded
 * actions (matching the tournament input wire format).
 */
function submitScore(
	nickname: string,
	seed: number,
	inputs: Array<{ tick: number; action: string }>,
): void {
	const wireInputs = inputs.map(i => ({ tick: i.tick, payload: btoa(i.action) }));
	fetch('/api/scores', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ nickname, seed, inputs: wireInputs }),
	}).then((r) => r.json())
		.then((d) => console.log('Score submitted:', d))
		.catch((e) => console.log('Score submission failed (API may be offline):', e));
}

