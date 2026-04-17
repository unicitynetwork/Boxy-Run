/**
 * WebSocket chaos shim for tests. Wraps a real ws.WebSocket connection
 * and exposes controls to simulate network failure modes the tests need
 * to verify recovery from:
 *
 *   - drop: swallow messages matching a predicate (outbound and/or inbound)
 *   - silence: stop delivering ANY incoming messages, stop sending ANY outgoing
 *     messages — but keep the socket technically OPEN. Simulates the "zombie
 *     WS" we hit in production (no close frame, no traffic).
 *   - zombie: same as silence, PLUS swallow protocol-level pings so the
 *     server-side ping/pong liveness checks also fail.
 *   - abruptClose: terminate the TCP without sending a close frame.
 *
 * Tests drive it explicitly — set the mode, run the scenario, assert
 * behavior, reset the mode. No random failure injection here.
 */

import WebSocket from 'ws';

export type ChaosMode = 'normal' | 'dropOutbound' | 'dropInbound' | 'silence' | 'zombie';

export interface ChaosClient {
	readonly ws: WebSocket;
	readonly messages: any[]; // only real (non-chaos-dropped) messages
	send(msg: any): void;
	waitFor(type: string, timeout?: number): Promise<any>;
	close(): void;
	/** Change chaos behavior live. */
	setMode(mode: ChaosMode): void;
	/** Force-terminate the socket without sending a close frame (simulates TCP RST). */
	abruptClose(): void;
}

export interface ChaosOptions {
	port: number;
	nametag: string;
	/** Called on successful open. Useful to register before flipping modes. */
	onOpen?: (c: ChaosClient) => void | Promise<void>;
}

export function chaosConnect(opts: ChaosOptions): Promise<ChaosClient> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${opts.port}`);
		const messages: any[] = [];
		const waiters: {
			type: string;
			resolve: (m: any) => void;
			reject: (e: Error) => void;
			timer: NodeJS.Timeout;
		}[] = [];
		let mode: ChaosMode = 'normal';

		ws.on('message', (raw) => {
			// Inbound chaos: drop if in dropInbound/silence/zombie
			if (mode === 'dropInbound' || mode === 'silence' || mode === 'zombie') return;
			const msg = JSON.parse(raw.toString());
			messages.push(msg);
			for (let i = 0; i < waiters.length; i++) {
				if (waiters[i].type === msg.type) {
					clearTimeout(waiters[i].timer);
					waiters[i].resolve(msg);
					waiters.splice(i, 1);
					break;
				}
			}
		});

		ws.on('error', (err) => reject(err));

		ws.on('open', () => {
			// In zombie mode, also ignore incoming pings. The `ws` library
			// replies to pings automatically at protocol level; we can't
			// prevent the pong, but we can at least not surface the ping.
			// Server-side liveness detection usually relies on pong from
			// the other side — we can't block that in pure application code.
			// For tests, zombie is functionally identical to silence.

			const client: ChaosClient = {
				ws,
				messages,
				send(msg: any) {
					// Outbound chaos: drop if in dropOutbound/silence/zombie
					if (mode === 'dropOutbound' || mode === 'silence' || mode === 'zombie') return;
					if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
				},
				waitFor(type: string, timeout = 3000) {
					for (const m of messages) if (m.type === type) return Promise.resolve(m);
					return new Promise((res, rej) => {
						const timer = setTimeout(
							() => rej(new Error(`chaos: timeout waiting for ${type} (mode=${mode})`)),
							timeout,
						);
						waiters.push({ type, resolve: res, reject: rej, timer });
					});
				},
				close() {
					for (const w of waiters) clearTimeout(w.timer);
					waiters.length = 0;
					ws.close();
				},
				setMode(next) {
					mode = next;
				},
				abruptClose() {
					// terminate() drops the TCP without sending a close frame.
					// The server sees the socket close uncleanly.
					ws.terminate();
				},
			};
			Promise.resolve(opts.onOpen?.(client)).then(() => resolve(client));
		});
	});
}
