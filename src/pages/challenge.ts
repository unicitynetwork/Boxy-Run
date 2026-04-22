/**
 * Challenge lobby page logic. Connects to the server WS, shows the
 * online roster, lets the user send 1v1 challenges, displays incoming
 * invites, and routes chat messages.
 *
 * All wire I/O goes through `protocol/messages` types so a server-side
 * field rename surfaces here as a compile error rather than a runtime
 * silence (which is exactly how several past prod bugs happened).
 */

import {
	PROTOCOL_VERSION,
	type ClientMessage,
	type ServerMessage,
	type ChallengeReceivedMessage,
	type DistributiveOmit,
} from '../../tournament/protocol/messages';

// ─── Types not in the protocol ───────────────────────────────────

interface SphereWalletAPI {
	isConnected: boolean;
	identity: { nametag?: string } | null;
}
declare global {
	interface Window {
		SphereWallet?: SphereWalletAPI;
		challenge: (opponent: string) => void;
		accept: (id: string, btn: HTMLElement) => void;
		decline: (id: string, btn: HTMLElement) => void;
	}
}

// ─── State ───────────────────────────────────────────────────────

const WS_PROTO = location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${WS_PROTO}//${location.host}`;
let myNametag: string | null = localStorage.getItem('boxyrun-nametag');
let ws: WebSocket | null = null;
let onlinePlayers: string[] = [];
let wsLastMessageAt = 0;
let wsWatchdog: ReturnType<typeof setInterval> | null = null;

function esc(s: string): string {
	const d = document.createElement('div');
	d.textContent = s;
	return d.innerHTML;
}

function $(id: string): HTMLElement {
	const el = document.getElementById(id);
	if (!el) throw new Error(`element #${id} missing`);
	return el;
}

// ─── Identity ────────────────────────────────────────────────────

if (myNametag) {
	$('id-disconnected').style.display = 'none';
	$('id-connected').style.display = 'flex';
	$('my-name').textContent = myNametag;
	connectWS();
	enableChat();
}

// Keep nametag aligned with the wallet (not just stale localStorage).
// Adopts a wallet identity that's different from the cache — otherwise
// challenges would route to the previously-cached nametag's inbox.
setInterval(() => {
	const w = window.SphereWallet;
	if (!(w && w.isConnected && w.identity?.nametag)) return;
	const liveTag = w.identity.nametag;
	if (myNametag === liveTag) return;
	if (myNametag && myNametag !== liveTag) {
		console.warn('[challenge] wallet identity changed', myNametag, '→', liveTag);
		if (ws) try { ws.close(); } catch {}
		ws = null;
	}
	myNametag = liveTag;
	localStorage.setItem('boxyrun-nametag', myNametag);
	$('id-disconnected').style.display = 'none';
	$('id-connected').style.display = 'flex';
	$('my-name').textContent = myNametag;
	connectWS();
	enableChat();
}, 500);

// ─── WebSocket ───────────────────────────────────────────────────

function connectWS(): void {
	if (!myNametag) return;
	ws = new WebSocket(WS_URL);
	wsLastMessageAt = Date.now();
	ws.onopen = () => {
		wsLastMessageAt = Date.now();
		wsSend({ type: 'register', identity: { nametag: myNametag! } });
		$('ws-dot').classList.add('on');
		updateNetStatus();
	};
	ws.onmessage = (e) => {
		wsLastMessageAt = Date.now();
		try {
			const msg = JSON.parse(e.data) as ServerMessage;
			if (msg.type === 'heartbeat') return;
			handleMsg(msg);
		} catch (err) {
			console.error('[ws] handleMsg error:', err);
		}
	};
	ws.onclose = () => {
		if (wsWatchdog) { clearInterval(wsWatchdog); wsWatchdog = null; }
		$('ws-dot').classList.remove('on');
		updateNetStatus();
		setTimeout(connectWS, 3000);
	};
	ws.onerror = () => {};
	// Watchdog: server heartbeats every 10s. >25s silence = zombie socket → reconnect.
	wsWatchdog = setInterval(() => {
		if (ws && ws.readyState === 1 && Date.now() - wsLastMessageAt > 25_000) {
			console.warn('[ws] idle >25s — forcing reconnect');
			try { ws.close(); } catch {}
		}
	}, 5000);
}

function wsSend(msg: DistributiveOmit<ClientMessage, 'v'>): void {
	if (ws && ws.readyState === 1) {
		ws.send(JSON.stringify({ ...msg, v: PROTOCOL_VERSION }));
	}
}

// ─── Server message dispatch ─────────────────────────────────────

function handleMsg(msg: ServerMessage): void {
	switch (msg.type) {
		case 'registered':
			if (msg.protocolVersion !== PROTOCOL_VERSION) {
				console.warn(`[challenge] protocol mismatch: server=${msg.protocolVersion} client=${PROTOCOL_VERSION}`);
			}
			// Online roster is now REST-polled; ignore WS snapshot
			break;
		case 'player-online':
			// Online roster is now REST-polled; ignore WS updates
			break;
		case 'challenge-received':
			showIncoming(msg);
			break;
		case 'challenge-sent':
			// Already handled by the REST response — ignore WS echo
			break;
		case 'challenge-declined':
			clearPending();
			if (msg.by) {
				// Fast decline (< 3s) = bot busy or auto-reject
				const fast = pendingStart > 0 && (Date.now() - pendingStart) < 3000;
				const text = fast
					? `${esc(msg.by)} is busy — try again shortly.`
					: `${esc(msg.by)} declined.`;
				showStatus(text, 'rgba(218,54,51,0.1)', 'var(--red)');
			} else {
				showStatus('Challenge expired — opponent didn\u2019t respond in time.', 'rgba(218,54,51,0.1)', 'var(--red)');
			}
			// On the invitee side, remove the pending invite banner so the UI
			// doesn't show a stale Accept/Decline card for a dead challenge.
			if (msg.challengeId) {
				const buttons = document.querySelectorAll(`.challenge-incoming button[onclick*="'${msg.challengeId}'"]`);
				buttons.forEach(b => (b as HTMLElement).closest('.challenge-incoming')?.remove());
			}
			break;
		case 'chat':
			if (msg.from && msg.from !== myNametag) {
				addChatMessage(msg.from, msg.message, false);
			}
			break;
		case 'challenge-start': {
			clearPending();
			// Redirect straight to the game — match is already started
			const p = new URLSearchParams({
				tournament: '1', matchId: msg.matchId, seed: msg.seed,
				side: msg.youAre, opponent: msg.opponent,
				startsAt: String(msg.startsAt), name: myNametag!,
				tid: msg.tournamentId,
				bestOf: String(msg.bestOf || 1),
				wager: String(msg.wager || 0),
			});
			location.href = 'dev.html?' + p;
			break;
		}
		// Other ServerMessage variants (match-start, match-end, etc) only
		// reach the in-game page; nothing to do here.
	}
}

// ─── Online roster rendering ─────────────────────────────────────

// Persist wager/bestof across re-renders
let savedWager = '0';
let savedBestOf = '3';

function render(): void {
	const el = $('online-list');
	const others = onlinePlayers.filter(n => n !== myNametag);
	$('online-count').textContent = `${others.length} online`;

	// Save current values before re-render
	const wagerEl = document.getElementById('wager-input') as HTMLInputElement | null;
	const bestofEl = document.getElementById('bestof-input') as HTMLSelectElement | null;
	if (wagerEl) savedWager = wagerEl.value;
	if (bestofEl) savedBestOf = bestofEl.value;

	if (!others.length) {
		el.innerHTML = '<div class="empty">No other players online right now</div>';
		return;
	}
	el.innerHTML = `<div style="margin-bottom:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
		<label style="font-size:12px;color:var(--text2)">Wager:</label>
		<input type="number" id="wager-input" value="${esc(savedWager)}" min="0" step="10" style="width:70px;padding:6px 8px;background:rgba(0,0,0,0.3);border:1px solid var(--border-hi);border-radius:var(--r);color:var(--text);font-size:13px;text-align:center">
		<span style="font-size:12px;color:var(--text3)">UCT</span>
		<label style="font-size:12px;color:var(--text2);margin-left:8px">Best of:</label>
		<select id="bestof-input" style="padding:6px 8px;background:rgba(0,0,0,0.3);border:1px solid var(--border-hi);border-radius:var(--r);color:var(--text);font-size:13px">
			<option value="1"${savedBestOf === '1' ? ' selected' : ''}>1</option>
			<option value="3"${savedBestOf === '3' ? ' selected' : ''}>3</option>
			<option value="5"${savedBestOf === '5' ? ' selected' : ''}>5</option>
		</select>
	</div>` + others.map(n =>
		`<button class="player-btn" onclick="challenge('${esc(n)}')"${pendingChallenge ? ' disabled' : ''}>${esc(n)}</button>`
	).join('');
}

// ─── Outgoing challenges ─────────────────────────────────────────

let pendingChallenge: string | null = null; // challengeId while waiting
let pendingTimer: ReturnType<typeof setInterval> | null = null;
let pendingStart = 0;

async function challenge(opponent: string): Promise<void> {
	if (pendingChallenge) return; // already waiting
	pendingChallenge = 'sending'; // guard immediately, before any await
	render(); // disable buttons instantly

	const wagerInput = document.getElementById('wager-input') as HTMLInputElement | null;
	const bestofInput = document.getElementById('bestof-input') as HTMLSelectElement | null;
	const wager = parseInt(wagerInput?.value || '0', 10);
	const bestOf = parseInt(bestofInput?.value || '1', 10);

	showStatus(`Sending challenge to ${esc(opponent)}...`, 'var(--cyan-dim)', 'var(--cyan)');

	try {
		const r = await fetch('/api/challenges', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ from: myNametag, opponent, wager: Math.max(0, wager), bestOf }),
		});
		const data = await r.json();
		if (!r.ok) {
			clearPending();
			showStatus(data.message || data.error || 'Challenge failed', 'rgba(218,54,51,0.1)', 'var(--red)');
			return;
		}
		// Challenge sent — show waiting status with countdown
		pendingChallenge = data.challengeId || 'pending';
		pendingStart = Date.now();
		showPendingStatus(opponent);
		pendingTimer = setInterval(() => showPendingStatus(opponent), 1000);
		// Auto-clear after 30s (server expires challenges at 30s)
		setTimeout(() => {
			if (pendingChallenge) {
				clearPending();
				showStatus('Challenge expired — no response.', 'rgba(218,54,51,0.1)', 'var(--red)');
			}
		}, 32_000);
		render(); // disable buttons
	} catch (err) {
		clearPending();
		showStatus('Could not reach server — check your connection', 'rgba(218,54,51,0.1)', 'var(--red)');
	}
}

function showPendingStatus(opponent: string): void {
	const elapsed = Math.floor((Date.now() - pendingStart) / 1000);
	const remaining = Math.max(0, 30 - elapsed);
	showStatus(
		`Challenge sent to ${esc(opponent)} — waiting for response (${remaining}s)`,
		'var(--cyan-dim)', 'var(--cyan)',
		false, // don't auto-hide
	);
}

function clearPending(): void {
	pendingChallenge = null;
	if (pendingTimer) { clearInterval(pendingTimer); pendingTimer = null; }
	render(); // re-enable buttons
}

function showStatus(text: string, bg: string, color: string, autoHide = true): void {
	const el = $('challenge-status');
	el.style.display = 'block';
	el.style.background = bg;
	el.style.color = color;
	el.innerHTML = text;
	if (autoHide) setTimeout(() => { el.style.display = 'none'; }, 5000);
}

const shownChallenges = new Set<string>();
function showIncoming(msg: ChallengeReceivedMessage): void {
	// Remove any existing challenge from the same sender (dedup)
	const box = $('incoming-challenges');
	box.querySelectorAll('.challenge-incoming').forEach(el => {
		if (el.getAttribute('data-from') === msg.from) el.remove();
	});
	// Don't show the same challengeId twice
	if (shownChallenges.has(msg.challengeId)) return;
	shownChallenges.add(msg.challengeId);
	const div = document.createElement('div');
	div.className = 'challenge-incoming';
	div.setAttribute('data-from', msg.from);
	const wagerText = msg.wager > 0 ? ` for <strong style="color:var(--orange)">${msg.wager} UCT</strong>` : '';
	const boText = msg.bestOf > 1 ? ` (best of ${msg.bestOf})` : '';
	div.innerHTML = `
		<span><strong>${esc(msg.from)}</strong> challenges you${wagerText}${boText}</span>
		<span>
			<button class="btn btn-primary" style="padding:8px 16px;font-size:10px" onclick="accept('${msg.challengeId}',this)">Accept</button>
			<button class="btn btn-ghost" style="padding:8px 16px;font-size:10px;margin-left:4px" onclick="decline('${msg.challengeId}',this)">Decline</button>
		</span>`;
	box.appendChild(div);
}

async function accept(id: string, btn: HTMLElement): Promise<void> {
	btn.closest('.challenge-incoming')?.remove();
	showStatus('Starting match...', 'var(--cyan-dim)', 'var(--cyan)');
	try {
		const r = await fetch(`/api/challenges/${encodeURIComponent(id)}/accept`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ by: myNametag }),
		});
		const data = await r.json();
		if (!r.ok) {
			showStatus(data.message || data.error || 'Accept failed', 'rgba(218,54,51,0.1)', 'var(--red)');
			return;
		}
		// Single fetch → direct redirect. No extra bracket/tournament
		// fetches that can race with the page's redirect poll.
		const p = new URLSearchParams({
			tournament: '1', matchId: data.matchId, seed: data.seed || '0',
			side: data.youAre, opponent: data.opponent, name: myNametag!,
			tid: data.tournamentId, bestOf: String(data.bestOf || 1),
			startsAt: String(Date.now() + 3000),
		});
		location.href = 'dev.html?' + p;
	} catch (err) {
		showStatus('Network error', 'rgba(218,54,51,0.1)', 'var(--red)');
	}
}

async function decline(id: string, btn: HTMLElement): Promise<void> {
	btn.closest('.challenge-incoming')?.remove();
	try {
		await fetch(`/api/challenges/${encodeURIComponent(id)}/decline`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ by: myNametag }),
		});
	} catch {}
}

// ─── Chat ────────────────────────────────────────────────────────

function enableChat(): void {
	const inp = document.getElementById('chat-input') as HTMLInputElement | null;
	const btn = document.getElementById('chat-send') as HTMLButtonElement | null;
	if (inp) inp.disabled = false;
	if (btn) btn.disabled = false;
}

function addChatMessage(from: string, text: string, isMe: boolean): void {
	const el = document.getElementById('chat-messages');
	if (!el) return;
	const div = document.createElement('div');
	div.style.marginBottom = '4px';
	const nameColor = isMe ? 'var(--cyan)' : 'var(--orange)';
	div.innerHTML = `<strong style="color:${nameColor}">${esc(from)}</strong> ${esc(text)}`;
	el.appendChild(div);
	el.scrollTop = el.scrollHeight;
}

function sendChat(): void {
	const inp = document.getElementById('chat-input') as HTMLInputElement | null;
	const text = inp?.value.trim();
	if (!text || !myNametag) return;
	wsSend({ type: 'chat', message: text });
	addChatMessage(myNametag, text, true);
	if (inp) inp.value = '';
}

document.getElementById('chat-send')?.addEventListener('click', sendChat);
document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
	if ((e as KeyboardEvent).key === 'Enter') sendChat();
});

// ── Network status bar ───────────────────────────────────────────
let lastRestOk = false;
function updateNetStatus() {
	const dot = document.getElementById('net-dot');
	const text = document.getElementById('net-text');
	if (!dot || !text) return;
	const wsOk = ws?.readyState === 1;
	if (wsOk && lastRestOk) {
		dot.style.background = '#2ea043';
		dot.style.boxShadow = '0 0 6px rgba(46,160,67,0.5)';
		text.style.color = '#2ea043';
		text.textContent = `Connected as ${myNametag || '?'} | ${onlinePlayers.length} online`;
	} else if (wsOk || lastRestOk) {
		dot.style.background = '#f97316';
		dot.style.boxShadow = '0 0 6px rgba(249,115,22,0.5)';
		text.style.color = '#f97316';
		text.textContent = wsOk ? 'WS OK, REST issues' : 'REST OK, WS reconnecting…';
	} else {
		dot.style.background = '#c1121f';
		dot.style.boxShadow = '0 0 6px rgba(193,18,31,0.5)';
		text.style.color = '#c1121f';
		text.textContent = 'Disconnected — reconnecting…';
	}
}
// Check REST health on every online poll
const origPoll = setInterval(async () => {
	try {
		const r = await fetch('/api/online');
		lastRestOk = r.ok;
	} catch { lastRestOk = false; }
	updateNetStatus();
}, 3000);
updateNetStatus();

// Expose handlers used by inline `onclick=` attributes in the rendered HTML.
window.challenge = challenge;
window.accept = accept;
window.decline = decline;

// ── REST poll: online players ────────────────────────────────────
// Replaces the WS-based roster entirely. No more vanishing players
// on refresh — this is the single source of truth.
setInterval(async () => {
	if (!myNametag) return;
	try {
		const r = await fetch('/api/online');
		if (!r.ok) return;
		const { players } = await r.json();
		onlinePlayers = players || [];
		render();
	} catch {}
}, 3000);
// Initial fetch
if (myNametag) fetch('/api/online').then(r => r.json()).then(d => { onlinePlayers = d.players || []; render(); }).catch(() => {});

// Redirect poll removed — accept does a direct redirect,
// challenger gets redirect via WS challenge-start.
