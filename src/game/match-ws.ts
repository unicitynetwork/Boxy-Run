/**
 * WebSocket connection for multiplayer matches.
 * Used ONLY for: input relay (opponent-input) and chat.
 * All flow transitions are REST-polled — WS is never relied on for state changes.
 */

import type { CharacterAction } from '../sim/state';

export interface MatchWS {
	send: (msg: Record<string, unknown>) => void;
	close: () => void;
}

export function connectMatchWS(opts: {
	playerName: string;
	matchId: string;
	onOpponentInput: (tick: number, action: CharacterAction) => void;
	onChat: (from: string, message: string) => void;
	onChallengeStart?: (msg: any) => void;
	onSeriesNext?: (msg: any) => void;
}): MatchWS {
	const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
	const wsUrl = `${wsProto}//${location.host}`;
	let ws: WebSocket | null = null;
	let intentionalClose = false;
	let lastMessageAt = 0;
	let watchdog: ReturnType<typeof setInterval> | null = null;
	const pendingSends: string[] = [];

	function connect() {
		ws = new WebSocket(wsUrl);
		lastMessageAt = Date.now();
		ws.onopen = async () => {
			lastMessageAt = Date.now();
			// Server requires a Sphere-signed session for register. There's
			// a race here: the WS can open before sphere-connect.ts has
			// finished its wallet handshake. If `authSession` is null,
			// trigger (or wait on) the handshake before sending register.
			// Without this we'd ship sessionId=null and get hard-closed by
			// the server, then auto-reconnect into a tight rejection loop.
			const wallet = (window as any).SphereWallet;
			let sessionId: string | null = wallet?.authSession ?? null;
			if (!sessionId && typeof wallet?.ensureAuthSession === 'function') {
				try {
					sessionId = await wallet.ensureAuthSession();
				} catch (err) {
					console.error('[match-ws] auth handshake failed', err);
				}
			}
			if (!sessionId) {
				// No session means the user hasn't connected a wallet (or
				// declined to sign). Stop reconnecting — without this the
				// client hammers /api/auth/* and the server logs forever.
				console.warn('[match-ws] no auth session — closing without register; will retry on next user-initiated connect');
				intentionalClose = true;
				try { ws!.close(); } catch {}
				return;
			}
			ws!.send(JSON.stringify({
				type: 'register',
				identity: { nametag: opts.playerName },
				sessionId,
			}));
			while (pendingSends.length && ws!.readyState === 1) {
				ws!.send(pendingSends.shift()!);
			}
		};
		ws.onmessage = (e) => {
			lastMessageAt = Date.now();
			try {
				const msg = JSON.parse(e.data);
				if (msg.type === 'heartbeat') return;

				if (msg.type === 'opponent-input' && msg.matchId === opts.matchId) {
					try {
						const action = atob(msg.payload) as CharacterAction;
						if (action === 'up' || action === 'left' || action === 'right' || action === 'fire') {
							opts.onOpponentInput(msg.tick, action);
						}
					} catch {}
				}
				if (msg.type === 'chat' && msg.from) {
					opts.onChat(msg.from, msg.message);
				}
				if (msg.type === 'challenge-start') {
					opts.onChallengeStart?.(msg);
				}
				if (msg.type === 'series-next') {
					opts.onSeriesNext?.(msg);
				}
			} catch {}
		};
		ws.onclose = () => {
			if (watchdog) { clearInterval(watchdog); watchdog = null; }
			if (!intentionalClose) setTimeout(connect, 3000);
		};
		watchdog = setInterval(() => {
			if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMessageAt > 25_000) {
				console.warn('[ws] idle >25s — forcing reconnect');
				try { ws.close(); } catch {}
			}
		}, 5000);
	}

	connect();

	return {
		get wsState() { return ws?.readyState ?? 3; },
		send(msg: Record<string, unknown>) {
			const json = JSON.stringify(msg);
			if (ws?.readyState === 1) {
				ws.send(json);
			} else {
				pendingSends.push(json);
			}
		},
		close() {
			intentionalClose = true;
			if (watchdog) clearInterval(watchdog);
			ws?.close();
		},
	};
}
