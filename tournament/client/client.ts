/**
 * Tournament client SDK. Wraps the WebSocket protocol into a typed,
 * callback-driven interface that the game entry point consumes.
 *
 * Works in both browser (native WebSocket) and Node (via the `ws`
 * package). The caller provides a WebSocket constructor via the
 * options — in the browser this is just `window.WebSocket`, in Node
 * it's `require('ws').WebSocket`.
 *
 * Usage:
 *   const client = new TournamentClient({
 *     url: 'ws://localhost:7101',
 *     nametag: '@alice',
 *     pubkey: '00'.repeat(32),
 *     onLobbyState: (msg) => ...,
 *     onBracket: (msg) => ...,
 *     onRoundOpen: (msg) => ...,
 *     onMatchStart: (msg) => ...,
 *     onOpponentInput: (msg) => ...,
 *     onMatchEnd: (msg) => ...,
 *     onTournamentEnd: (msg) => ...,
 *     onError: (msg) => ...,
 *   });
 *   await client.connect();
 *   client.join(tournamentId, entryTxHash, amount, coinId);
 *   client.ready(matchId);
 *   client.sendInput(matchId, tick, payload);
 *   client.submitResult(matchId, ...);
 *   client.disconnect();
 */

import {
	PROTOCOL_VERSION,
	type BracketMessage,
	type ErrorMessage,
	type LobbyStateMessage,
	type MatchEndMessage,
	type MatchStartMessage,
	type OpponentInputMessage,
	type OpponentReadyMessage,
	type RoundOpenMessage,
	type ServerMessage,
	type TournamentEndMessage,
} from '../protocol/messages';

type MaybeCallback<T> = ((msg: T) => void) | undefined;

export interface TournamentClientOptions {
	/** WebSocket server URL. */
	url: string;
	/** Player nametag (including @). */
	nametag: string;
	/** Hex-encoded public key. */
	pubkey: string;
	/** WebSocket constructor. In browser: window.WebSocket. In Node: require('ws').WebSocket. */
	WebSocketCtor?: new (url: string) => WebSocket;

	onLobbyState?: MaybeCallback<LobbyStateMessage>;
	onBracket?: MaybeCallback<BracketMessage>;
	onRoundOpen?: MaybeCallback<RoundOpenMessage>;
	onOpponentReady?: MaybeCallback<OpponentReadyMessage>;
	onMatchStart?: MaybeCallback<MatchStartMessage>;
	onOpponentInput?: MaybeCallback<OpponentInputMessage>;
	onMatchEnd?: MaybeCallback<MatchEndMessage>;
	onTournamentEnd?: MaybeCallback<TournamentEndMessage>;
	onError?: MaybeCallback<ErrorMessage>;
	onClose?: () => void;
}

export class TournamentClient {
	private ws: WebSocket | null = null;
	private readonly opts: TournamentClientOptions;

	constructor(opts: TournamentClientOptions) {
		this.opts = opts;
	}

	/**
	 * Open the WebSocket connection. Resolves when the socket is open.
	 * Rejects if the connection fails.
	 */
	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			const Ctor = this.opts.WebSocketCtor ?? WebSocket;
			const ws = new Ctor(this.opts.url);
			this.ws = ws;

			ws.onopen = () => resolve();
			ws.onerror = (e) => reject(e);
			ws.onclose = () => {
				this.ws = null;
				this.opts.onClose?.();
			};
			ws.onmessage = (e) => {
				let msg: ServerMessage;
				try {
					msg = JSON.parse(
						typeof e.data === 'string' ? e.data : e.data.toString(),
					) as ServerMessage;
				} catch {
					return;
				}
				this.dispatch(msg);
			};
		});
	}

	disconnect(): void {
		this.ws?.close();
	}

	isConnected(): boolean {
		return this.ws !== null && this.ws.readyState === 1; // 1 = OPEN
	}

	// ── Protocol actions ──────────────────────────────────────────────

	join(
		tournamentId: string,
		txHash = 'stub',
		amount = '10',
		coinId = 'stub',
		signature = 'stub',
	): void {
		this.send({
			type: 'join',
			v: PROTOCOL_VERSION,
			tournamentId,
			identity: { nametag: this.opts.nametag, pubkey: this.opts.pubkey },
			entry: { txHash, amount, coinId },
			signature,
		});
	}

	ready(matchId: string): void {
		this.send({ type: 'match-ready', v: PROTOCOL_VERSION, matchId });
	}

	unready(matchId: string): void {
		this.send({ type: 'match-unready', v: PROTOCOL_VERSION, matchId });
	}

	sendInput(matchId: string, tick: number, payload: string): void {
		this.send({
			type: 'input',
			v: PROTOCOL_VERSION,
			matchId,
			tick,
			payload,
		});
	}

	submitResult(
		matchId: string,
		finalTick: number,
		score: Record<string, number>,
		winner: 'A' | 'B',
		inputsHash: string,
		resultHash: string,
	): void {
		this.send({
			type: 'result',
			v: PROTOCOL_VERSION,
			matchId,
			finalTick,
			score,
			winner,
			inputsHash,
			resultHash,
		});
	}

	leave(reason?: string): void {
		this.send({ type: 'leave', v: PROTOCOL_VERSION, reason });
	}

	// ── Internal ──────────────────────────────────────────────────────

	private send(msg: Record<string, unknown>): void {
		if (!this.ws || this.ws.readyState !== 1) { // 1 = OPEN
			console.error('[tournament-client] send() called but not connected');
			return;
		}
		this.ws.send(JSON.stringify(msg));
	}

	private dispatch(msg: ServerMessage): void {
		switch (msg.type) {
			case 'lobby-state':
				this.opts.onLobbyState?.(msg);
				break;
			case 'bracket':
				this.opts.onBracket?.(msg);
				break;
			case 'round-open':
				this.opts.onRoundOpen?.(msg);
				break;
			case 'opponent-ready':
				this.opts.onOpponentReady?.(msg);
				break;
			case 'match-start':
				this.opts.onMatchStart?.(msg);
				break;
			case 'opponent-input':
				this.opts.onOpponentInput?.(msg);
				break;
			case 'match-end':
				this.opts.onMatchEnd?.(msg);
				break;
			case 'tournament-end':
				this.opts.onTournamentEnd?.(msg);
				break;
			case 'error':
				this.opts.onError?.(msg);
				break;
		}
	}
}
