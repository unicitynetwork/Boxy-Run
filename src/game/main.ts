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
} from '../render/scene';
import {
	addOpponentMesh,
	createRenderState,
	removeOpponentMesh,
	syncOpponent,
	syncRender,
	type RenderState,
} from '../render/sync';
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
	let currentSeed = parseInt(params.get('seed') || '0', 16) >>> 0;
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
				'background:rgba(0,0,0,0.7);color:#fff;padding:6px 16px;border-radius:6px;' +
				'font-family:monospace;font-size:13px;text-align:center;pointer-events:none;';
			document.body.appendChild(seriesHud);
		}
		const myWins = mySide === 'A' ? currentWinsA : currentWinsB;
		const oppWins = mySide === 'A' ? currentWinsB : currentWinsA;
		seriesHud.innerHTML = `<span style="font-size:10px;opacity:0.6">BEST OF ${bestOf} | GAME ${currentGameNumber}</span><br><span style="color:#00e5ff">${myWins}</span> - <span style="color:#f97316">${oppWins}</span>`;
	}
	updateSeriesHud();

	const config = DEFAULT_CONFIG;
	const scene = createScene();
	const render = createRenderState(scene, skin, true);
	addOpponentMesh(render, scene);

	// Mutable per-game sim state — reassigned on series-next
	let myState = makeInitialState(currentSeed, config);
	let opponentState = makeInitialState(currentSeed, config);
	let oppBuffer = new Map<number, CharacterAction[]>();

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
	let oppGhostDead = false; // visual-only: hide ghost mesh when opp sim dies
	let lastFrameTime = performance.now();
	let tickAccumulator = 0;

	function setPhase(next: ClientPhase) {
		if (phase === next) return;
		console.log(`[phase] ${phase} → ${next}`);
		phase = next;
		(window as any).__currentPhase = next; // exposed for Playwright tests
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

	// Opponent score HUD
	let oppHud: HTMLElement | null = null;
	function updateOppHud() {
		if (!oppHud) {
			oppHud = document.createElement('div');
			oppHud.style.cssText =
				'position:fixed;top:16px;right:16px;z-index:100;' +
				'background:rgba(0,0,0,0.7);color:#e35d6a;' +
				'padding:10px 16px;border-radius:6px;' +
				'font-family:monospace;font-size:14px;' +
				'border:1px solid rgba(227,93,106,0.3);pointer-events:none;';
			document.body.appendChild(oppHud);
		}
		const dead = opponentState.gameOver ? ' [DEAD]' : '';
		oppHud.innerHTML =
			`<span style="font-size:11px;opacity:0.6">OPPONENT</span><br>` +
			`Score: ${opponentState.score}${dead}`;
	}

	// Connect WebSocket
	const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
	const wsUrl = `${wsProto}//${location.host}`;
	let ws: WebSocket | null = null;
	let intentionalClose = false;
	let wsLastMessageAt = 0;
	let wsWatchdog: ReturnType<typeof setInterval> | null = null;

	// Outgoing queue. Anything sent while the WS is reconnecting (CLOSED /
	// CONNECTING) MUST be queued, not dropped — silent drops here is the
	// "I won locally but server says I lost" bug: the local game keeps
	// applying inputs from queuedActions, so the player sees themselves
	// jumping, but the server's deterministic replay never sees those
	// inputs and the character dies earlier on the server side. Order is
	// preserved: the queue flushes (FIFO) on the next onopen, AFTER the
	// register message, so inputs land server-side tagged with their
	// original tick number.
	const pendingSends: string[] = [];
	function connectWS() {
		ws = new WebSocket(wsUrl);
		wsLastMessageAt = Date.now();
		ws.onopen = () => {
			wsLastMessageAt = Date.now();
			ws!.send(JSON.stringify({ type: 'register', identity: { nametag: playerName } }));
			// Flush anything queued while the WS was down.
			while (pendingSends.length && ws!.readyState === 1) {
				ws!.send(pendingSends.shift()!);
			}
		};
		ws.onmessage = (e) => {
			wsLastMessageAt = Date.now();
			try {
				const msg = JSON.parse(e.data);
				if (msg.type === 'heartbeat') return;

				// WS is used ONLY for real-time input relay and chat.
				// All flow transitions (ready, countdown, result, series)
				// are driven by the REST reconcile loop. This eliminates
				// the entire class of "missed WS push" bugs.
				if (msg.type === 'opponent-input' && msg.matchId === matchId) {
					try {
						const action = atob(msg.payload) as CharacterAction;
						if (action === 'up' || action === 'left' || action === 'right' || action === 'fire') {
							if (!oppBuffer.has(msg.tick)) oppBuffer.set(msg.tick, []);
							oppBuffer.get(msg.tick)!.push(action);
						}
					} catch {}
				}
				// Incoming rematch challenge — only on result screen
				if (msg.type === 'challenge-received' && phase === 'series_end') {
					const wagerText = msg.wager > 0 ? ` for ${msg.wager} UCT` : '';
					showOverlay(
						`<div style="font-size:16px;margin-bottom:12px"><strong>${msg.from}</strong> challenges you${wagerText}</div>` +
						`<button onclick="window.__acceptRematch('${msg.challengeId}')" style="font-family:monospace;font-size:14px;font-weight:bold;padding:12px 32px;background:#00e5ff;color:#060a12;border:none;border-radius:6px;cursor:pointer;letter-spacing:0.1em;margin:4px">ACCEPT</button>` +
						`<button onclick="window.__declineRematch('${msg.challengeId}')" style="font-family:monospace;font-size:12px;padding:8px 24px;background:transparent;color:#94a3b8;border:1px solid #334155;border-radius:6px;cursor:pointer;letter-spacing:0.1em;margin:4px">DECLINE</button>`,
					);
				}
				if (msg.type === 'chat' && msg.from) {
					showChatBubble(msg.from, msg.message);
				}
			} catch {}
		};
		ws.onclose = () => {
			if (wsWatchdog) { clearInterval(wsWatchdog); wsWatchdog = null; }
			if (!intentionalClose) setTimeout(connectWS, 3000);
		};

		// Watchdog: server heartbeats every 10s. If >25s silence the socket is
		// a zombie (network drop without close frame) — force close & reconnect.
		wsWatchdog = setInterval(() => {
			if (ws && ws.readyState === WebSocket.OPEN && Date.now() - wsLastMessageAt > 25_000) {
				console.warn('[ws] idle >25s — forcing reconnect');
				try { ws.close(); } catch {}
			}
		}, 5000);
	}
	connectWS();

	let lastWager = 0; // track wager for rematch

	function onMatchEnd(msg: any) {
		setPhase('series_end');
		if (oppHud) { oppHud.remove(); oppHud = null; }

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
			const backBtn = `<a href="${backUrl}" style="${BTN_STYLE}font-size:13px;background:transparent;color:#1a1a2e;border-color:#1a1a2e">${backLabel}</a>`;
			showOverlay(
				`<div style="font-size:20px;font-weight:bold;color:#94a3b8;margin-bottom:8px">MATCH FORFEITED</div>` +
				`<div style="font-size:13px;color:#94a3b8;margin-bottom:16px">Both players were offline too long.</div>` +
				`<div style="font-size:14px;margin-bottom:16px">Bracket awarded to <strong>${msg.winner || 'player A'}</strong>.</div>` +
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
		let resultHtml: string;
		const winLabel = isSeriesEnd ? 'SERIES WIN!' : 'YOU WIN!';
		const loseLabel = isSeriesEnd ? 'SERIES LOSS' : 'YOU LOSE';
		if (iWon) {
			resultHtml = `<div style="font-size:24px;font-weight:bold;color:#2d6a4f;margin-bottom:8px">${winLabel}</div>`;
			if (wager > 0) resultHtml += `<div style="font-size:14px;color:#2d6a4f;margin-bottom:8px">+${wager} UCT</div>`;
		} else {
			resultHtml = `<div style="font-size:24px;font-weight:bold;color:#c1121f;margin-bottom:8px">${loseLabel}</div>`;
			if (wager > 0) resultHtml += `<div style="font-size:14px;color:#c1121f;margin-bottom:8px">-${wager} UCT</div>`;
		}

		const rematchBtn = isChallenge ? `<button onclick="window.__v2rematch()" style="${BTN_STYLE}font-size:14px">REMATCH</button>` : '';
		const backLabel = isChallenge ? 'BACK TO CHALLENGES' : 'BACK TO TOURNAMENT';
		const backBtn = `<a href="${backUrl}" style="${BTN_STYLE}font-size:13px;background:transparent;color:#1a1a2e;border-color:#1a1a2e">${backLabel}</a>`;

		const scoreLabel = isSeriesEnd ? 'Games won' : 'Score';
		showOverlay(
			resultHtml +
			`<div style="font-size:12px;opacity:0.7;margin-bottom:4px">${scoreLabel}</div>` +
			`<div style="font-size:28px;font-weight:bold;margin-bottom:16px">${myScore} — ${oppScore}</div>` +
			rematchBtn + backBtn,
		);

		fetchGameBalance().then(updateBalanceDisplay);
	}

	// Rematch: send via REST, then poll for the match to start.
	// Old code used WS for challenge-start redirect — but we stripped
	// all WS flow handlers. REST poll catches the new match.
	let rematchPolling = false;
	(window as any).__v2rematch = async () => {
		showOverlay('<div style="font-size:16px">Sending rematch...</div><div style="font-size:12px;margin-top:8px;opacity:0.6">Waiting for opponent to accept...</div>');
		try {
			const r = await fetch('/api/challenges', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ from: playerName, opponent: opponentName, wager: lastWager, bestOf }),
			});
			const data = await r.json();
			if (!r.ok) {
				showOverlay(`<div style="font-size:14px;color:#c1121f;margin-bottom:12px">${data.message || 'Challenge failed'}</div>` +
					`<button onclick="window.__v2rematch()" style="${BTN_STYLE}font-size:14px">TRY AGAIN</button>`);
				return;
			}
		} catch {
			showOverlay(`<div style="font-size:14px;color:#c1121f;margin-bottom:12px">Network error</div>` +
				`<button onclick="window.__v2rematch()" style="${BTN_STYLE}font-size:14px">TRY AGAIN</button>`);
			return;
		}
		startMatchPoll();
	};

	/** Poll /api/tournaments for a new match involving us → redirect. */
	function startMatchPoll() {
		if (rematchPolling) return;
		rematchPolling = true;
		const poll = setInterval(async () => {
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
						(m.playerA === playerName || m.playerB === playerName)
						&& (m.status === 'ready_wait' || m.status === 'active'),
					);
					if (m) {
						clearInterval(poll);
						const side = m.playerA === playerName ? 'A' : 'B';
						const opp = side === 'A' ? m.playerB : m.playerA;
						const p = new URLSearchParams({
							tournament: '1', matchId: m.id, seed: m.seed || '0',
							side, opponent: opp, name: playerName,
							tid: t.id, bestOf: String(t.best_of || 1),
							wager: String(lastWager), startsAt: String(Date.now() + 3000),
						});
						location.href = 'dev.html?' + p;
						return;
					}
				}
			} catch {}
		}, 2000);
		setTimeout(() => {
			clearInterval(poll);
			rematchPolling = false;
			const backBtn = `<a href="${backUrl}" style="${BTN_STYLE}font-size:13px;background:transparent;color:#1a1a2e;border-color:#1a1a2e">BACK</a>`;
			showOverlay(`<div style="font-size:14px;margin-bottom:12px">Rematch expired</div>` +
				`<button onclick="window.__v2rematch()" style="${BTN_STYLE}font-size:14px">TRY AGAIN</button>` + backBtn);
		}, 35000);
	}

	// Accept/decline incoming rematch — also via REST
	(window as any).__acceptRematch = async (challengeId: string) => {
		showOverlay('<div style="font-size:16px">Starting match...</div>');
		try {
			await fetch(`/api/challenges/${challengeId}/accept`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ by: playerName }),
			});
		} catch {}
		startMatchPoll(); // ← was missing — acceptor needs the poll too
	};
	(window as any).__declineRematch = async (challengeId: string) => {
		try {
			await fetch(`/api/challenges/${challengeId}/decline`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ by: playerName }),
			});
		} catch {}
		const backLabel = isChallenge ? 'BACK TO CHALLENGES' : 'BACK TO TOURNAMENT';
		const backBtn = `<a href="${backUrl}" style="${BTN_STYLE}font-size:13px;background:transparent;color:#1a1a2e;border-color:#1a1a2e">${backLabel}</a>`;
		showOverlay('Challenge declined.' + backBtn);
	};

	// ── In-game chat ──
	function createChatPanel() {
		const panel = document.createElement('div');
		panel.id = 'game-chat';
		panel.style.cssText =
			'position:fixed;bottom:16px;right:16px;z-index:150;width:280px;' +
			'background:rgba(0,0,0,0.75);border:1px solid rgba(255,255,255,0.1);' +
			'border-radius:8px;font-family:monospace;font-size:12px;' +
			'backdrop-filter:blur(8px);display:flex;flex-direction:column;';
		panel.innerHTML =
			'<div id="game-chat-messages" style="height:120px;overflow-y:auto;padding:8px 10px;color:#ccc"></div>' +
			'<div style="display:flex;border-top:1px solid rgba(255,255,255,0.1)">' +
			'<input id="game-chat-input" type="text" maxlength="200" placeholder="Chat..." style="flex:1;padding:8px 10px;background:transparent;border:none;color:#fff;font-family:monospace;font-size:12px;outline:none">' +
			'<button id="game-chat-send" style="padding:8px 12px;background:transparent;border:none;border-left:1px solid rgba(255,255,255,0.1);color:#00e5ff;font-size:10px;font-weight:bold;cursor:pointer">SEND</button>' +
			'</div>';
		// Quick messages
		const quickBar = document.createElement('div');
		quickBar.style.cssText = 'display:flex;gap:4px;padding:6px 8px;border-top:1px solid rgba(255,255,255,0.1);flex-wrap:wrap;';
		['GG', 'Nice!', 'GL', '😂'].forEach(text => {
			const btn = document.createElement('button');
			btn.textContent = text;
			btn.style.cssText = 'padding:3px 8px;background:rgba(255,255,255,0.1);border:none;border-radius:4px;color:#aaa;font-size:11px;cursor:pointer;font-family:monospace;';
			btn.addEventListener('click', () => sendGameChat(text));
			quickBar.appendChild(btn);
		});
		panel.appendChild(quickBar);
		document.body.appendChild(panel);

		const input = document.getElementById('game-chat-input')!;
		const sendBtn = document.getElementById('game-chat-send')!;
		sendBtn.addEventListener('click', () => {
			const text = (input as HTMLInputElement).value.trim();
			if (text) { sendGameChat(text); (input as HTMLInputElement).value = ''; }
		});
		input.addEventListener('keydown', (e) => {
			e.stopPropagation(); // Don't trigger game controls
			if (e.key === 'Enter') {
				const text = (input as HTMLInputElement).value.trim();
				if (text) { sendGameChat(text); (input as HTMLInputElement).value = ''; }
			}
		});
		input.addEventListener('keyup', (e) => e.stopPropagation());
	}

	function sendGameChat(text: string) {
		wsSend({ type: 'chat', to: opponentName, message: text });
		addGameChatMessage(playerName, text, true);
	}

	function addGameChatMessage(from: string, text: string, isMe: boolean) {
		const el = document.getElementById('game-chat-messages');
		if (!el) return;
		const div = document.createElement('div');
		div.style.marginBottom = '3px';
		const color = isMe ? '#00e5ff' : '#f97316';
		div.innerHTML = `<span style="color:${color};font-weight:bold">${from.replace(/</g, '&lt;')}</span> ${text.replace(/</g, '&lt;')}`;
		el.appendChild(div);
		el.scrollTop = el.scrollHeight;
	}

	function showChatBubble(from: string, text: string) {
		addGameChatMessage(from, text, false);
	}

	createChatPanel();

	function wsSend(msg: Record<string, unknown>) {
		const json = JSON.stringify(msg);
		if (ws?.readyState === 1) {
			ws.send(json);
		} else {
			// WS down (CLOSED/CONNECTING). Queue and let onopen flush. This
			// is critical for `input` and `match-done`: dropping them would
			// desync server replay from the local sim → player thinks they
			// won, server says they lost.
			pendingSends.push(json);
		}
	}

	// Keyboard + touch input
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
	syncOpponent(opponentState, render, config);
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
		if (phase !== 'ready_prompt') return; // only from ready_prompt
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
				setTimeout(() => {
					if (phase !== 'countdown') return;
					hideOverlay();
					setPhase('playing');
					countdownActive = false;
					lastFrameTime = performance.now();
					tickAccumulator = 0;
				}, 500);
			}
		}
		tick();
	}

	// ── REST poll — the ONLY flow driver ─────────────────────────────
	// WS is used exclusively for input relay. ALL state transitions are
	// driven by this poll. No missed WS push can cause a stuck screen.
	const reconcileMatchRegex = matchId.match(/^(.+)\/R(\d+)M(\d+)$/);
	const stateUrl = reconcileMatchRegex
		? `/api/tournaments/${encodeURIComponent(reconcileMatchRegex[1])}/matches/${reconcileMatchRegex[2]}/${reconcileMatchRegex[3]}/state`
		: null;
	const doneUrl = reconcileMatchRegex
		? `/api/tournaments/${encodeURIComponent(reconcileMatchRegex[1])}/matches/${reconcileMatchRegex[2]}/${reconcileMatchRegex[3]}/done`
		: null;

	function resetForNextGame(s: any) {
		currentSeed = parseInt(s.series.currentSeed, 16) >>> 0;
		currentGameNumber = s.series.currentGame;
		currentWinsA = s.series.winsA || 0;
		currentWinsB = s.series.winsB || 0;
		myState = makeInitialState(currentSeed, config);
		opponentState = makeInitialState(currentSeed, config);
		oppBuffer.clear();
		oppGhostDead = false;
		countdownActive = false;
		tickAccumulator = 0;
		lastFrameTime = performance.now();
		if (render.opponent) render.opponent.root.visible = true;
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
		syncOpponent(opponentState, render, config);
		renderFrame(scene);
		beginGame(false);
	}

	if (stateUrl) {
		setInterval(async () => {
			if (phase === 'series_end') return;
			try {
				const r = await fetch(stateUrl);
				if (!r.ok) return;
				const s = await r.json();

				// 1. Match complete → show result.
				if (s.phase === 'complete' && s.winner) {
					console.log('[poll] → series_end');
					onMatchEnd({
						matchId: s.matchId, winner: s.winner,
						scoreA: s.scoreA ?? 0, scoreB: s.scoreB ?? 0,
						seriesEnd: (s.bestOf || 1) > 1, bestOf: s.bestOf || 1,
						wager: lastWager,
					});
					return;
				}

				// 2. Series advanced → show game result, then reset.
				if (s.series && s.series.currentGame > currentGameNumber) {
					console.log(`[poll] game ${s.series.currentGame} > ${currentGameNumber}`);
					// Determine who won the PREVIOUS game from series score delta
					const prevWinsA = currentWinsA;
					const prevWinsB = currentWinsB;
					const newWinsA = s.series.winsA || 0;
					const newWinsB = s.series.winsB || 0;
					const iWonGame = (mySide === 'A')
						? (newWinsA > prevWinsA)
						: (newWinsB > prevWinsB);
					const myWins = mySide === 'A' ? newWinsA : newWinsB;
					const oppWins = mySide === 'A' ? newWinsB : newWinsA;
					// Show result briefly before resetting
					setPhase('game_result');
					removeDeathBanner();
					showOverlay(
						`<div style="font-size:26px;font-weight:bold;color:${iWonGame ? '#2d6a4f' : '#c1121f'};margin-bottom:8px">Game ${currentGameNumber}: ${iWonGame ? 'WIN' : 'LOSS'}</div>` +
						`<div style="font-size:12px;color:#666;letter-spacing:.2em;margin-bottom:4px">SERIES (Best of ${bestOf})</div>` +
						`<div style="font-size:28px;font-weight:bold;margin-bottom:16px">${myWins} — ${oppWins}</div>` +
						`<div style="font-size:13px;opacity:0.7">Next game starting…</div>`,
					);
					setTimeout(() => resetForNextGame(s), 3000);
					return;
				}

				// 3. Both ready → countdown.
				if (s.ready?.A && s.ready?.B
						&& (phase === 'waiting' || phase === 'ready_prompt')) {
					console.log('[poll] both ready → countdown');
					kickCountdown(Date.now() + 3000);
					return;
				}

				// 4. Ready expired — only if we've actually been waiting
				//    long enough for the TTL to fire (readyDeadline passed).
				//    Without this, the very first poll sees both=false (server
				//    hasn't processed our ready yet) and falsely expires.
				if (phase === 'waiting' && s.ready && !s.ready.A && !s.ready.B
						&& Date.now() > readyDeadline) {
					console.log('[poll] ready expired');
					showReadyPrompt('Ready expired — opponent didn\'t ready in time');
					return;
				}

				// 5. Opponent confirmed dead by server → stop game, show win.
				const oppSide = mySide === 'A' ? 'B' : 'A';
				if (phase === 'playing' && s.done?.[oppSide]) {
					setPhase('done_sent');
					sendMatchDone();
					removeDeathBanner();
					showOverlay(
						`<div style="font-size:32px;font-weight:bold;color:#2d6a4f;margin-bottom:8px">YOU WIN!</div>` +
						`<div style="font-size:16px;margin-bottom:8px">Score: ${myState.score.toLocaleString()}</div>` +
						`<div style="font-size:13px;opacity:0.6">Waiting for final result…</div>`,
					);
					return;
				}
			} catch {}
		}, 2000);
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
				// Apply opponent inputs to ghost
				for (const [t, actions] of oppBuffer) {
					if (t <= opponentState.tick) {
						for (const a of actions) opponentState.character.queuedActions.push(a);
						oppBuffer.delete(t);
					}
				}

				tick(myState, config);
				tick(opponentState, config);

				// Opponent ghost died — visual only
				if (opponentState.gameOver && !oppGhostDead) {
					oppGhostDead = true;
					if (render.opponent) render.opponent.root.visible = false;
				}

				// Self died → transition to done_sent
				if (myState.gameOver && phase === 'playing') {
					playCrash();
					setPhase('done_sent');
					sendMatchDone();
					if (oppGhostDead) {
						showDeathBanner('CALCULATING RESULT', 'Both finished — server is replaying…');
					} else {
						showDeathBanner('YOU DIED', `Score: ${myState.score.toLocaleString()} — waiting for opponent…`);
					}
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
		if (phase === 'playing') updateOppHud();

		syncRender(myState, render, scene, config);
		if (!opponentState.gameOver) syncOpponent(opponentState, render, config);
		renderFrame(scene);
		requestAnimationFrame(loop);
	}
	requestAnimationFrame(loop);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Single-player (unchanged from before)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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
	const canPlayFree = !tag; // dev mode, no identity

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
	if (canPlayFree) {
		showOverlay('Press any key to start' + menuBtn);
	} else if (needsPayment) {
		showOverlay(`Pay ${ENTRY_FEE} UCT to play<br><br>${playBtn}${menuBtn}`);
	} else if (tag && (balance === null || balance < ENTRY_FEE)) {
		showOverlay(`Insufficient balance (${balance ?? 0} UCT)<br>Need ${ENTRY_FEE} UCT to play<br><br><a href="index.html" style="color:#00e5ff">Deposit on Home Page</a>${menuBtn}`);
	}

	let lastFrameTime = performance.now();
	let tickAccumulator = 0;
	const keysAllowed: Record<number, boolean> = {};

	async function tryStart() {
		if (canPlayFree || entryPaid) {
			paused = false;
			lastFrameTime = performance.now();
			tickAccumulator = 0;
			hideOverlay();
			return;
		}
		if (!tag) return;
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
			if (canPlayFree || entryPaid) {
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
			if (paused && !state.gameOver && (canPlayFree || entryPaid)) {
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


const BTN_STYLE = 'padding:12px 32px;background:#1a1a2e;color:#fff;border:2px solid #1a1a2e;border-radius:6px;font-family:monospace;font-weight:bold;cursor:pointer;letter-spacing:0.1em;text-decoration:none;display:inline-block;margin:6px;';

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

