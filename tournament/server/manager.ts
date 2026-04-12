/**
 * TournamentManager — handles multiple concurrent tournaments,
 * the 1v1 challenge system, and the rolling quick-match queue.
 *
 * Players first `register` with their identity, then can:
 *   - Send/accept challenges (creates a 2-player tournament)
 *   - Join the rolling queue (auto-creates tournaments on countdown)
 *   - Get assigned to a Grand Final (weekly, from qualifier points)
 *
 * Once assigned to a tournament, the existing Tournament class handles
 * the bracket, match lifecycle, and results.
 */

import { Tournament, type Delivery } from './state';
import type { PublicIdentity } from '../protocol/messages';
import { PROTOCOL_VERSION } from '../protocol/messages';

import type {
	ChallengeDeclinedMessage,
	ChallengeReceivedMessage,
	ChallengeSentMessage,
	PlayerOnlineMessage,
	QueueStateMessage,
	RegisteredMessage,
	TournamentAssignedMessage,
} from '../protocol/messages';

const V = PROTOCOL_VERSION;

interface RegisteredPlayer {
	identity: PublicIdentity;
	/** Which tournament this player is currently in (null if in lobby). */
	tournamentId: string | null;
}

interface PendingChallenge {
	id: string;
	from: string; // nametag
	to: string;   // nametag
	wager: number;
	createdAt: number;
}

export interface ManagerDelivery {
	to: string;
	message: unknown;
}

export class TournamentManager {
	private registered = new Map<string, RegisteredPlayer>();
	private tournaments = new Map<string, Tournament>();
	private playerToTournament = new Map<string, string>();
	private challenges = new Map<string, PendingChallenge>();
	private queue: string[] = [];
	private queueStartsAt: number | null = null;
	private nextId = 1;

	/** Rolling queue countdown in ms. */
	readonly queueCountdownMs: number;
	/** Min players to start a rolling tournament. */
	readonly queueMinPlayers: number;
	/** Max players in a rolling tournament. */
	readonly queueMaxPlayers: number;
	/** Ready rate limit for created tournaments. */
	readonly readyRateLimitMs: number;

	constructor(opts: {
		queueCountdownMs?: number;
		queueMinPlayers?: number;
		queueMaxPlayers?: number;
		readyRateLimitMs?: number;
	} = {}) {
		this.queueCountdownMs = opts.queueCountdownMs ?? 120_000; // 2 min
		this.queueMinPlayers = opts.queueMinPlayers ?? 4;
		this.queueMaxPlayers = opts.queueMaxPlayers ?? 8;
		this.readyRateLimitMs = opts.readyRateLimitMs ?? 3000;
	}

	// ── Registration ─────────────────────────────────────────────

	register(identity: PublicIdentity): ManagerDelivery[] {
		const tag = identity.nametag;
		if (this.registered.has(tag)) {
			// Re-registration: update identity, treat as success.
			// This handles page refreshes and game-page redirects where
			// the player is already registered from tournament.html.
			const existing = this.registered.get(tag)!;

			// Clear stale tournament assignment if the tournament is done
			if (existing.tournamentId) {
				const oldT = this.tournaments.get(existing.tournamentId);
				if (!oldT || oldT.getPhase() === 'DONE') {
					this.playerToTournament.delete(tag);
					existing.tournamentId = null;
				}
			}

			this.registered.set(tag, { identity, tournamentId: existing.tournamentId });
			const others = Array.from(this.registered.keys()).filter((t) => t !== tag);
			const deliveries: ManagerDelivery[] = [{
				to: tag,
				message: {
					type: 'registered', v: V,
					nametag: tag,
					onlinePlayers: others,
				} satisfies RegisteredMessage,
			}];
			// If the player is already in a tournament (e.g., redirected
			// from tournament.html after accepting a challenge), re-send
			// the tournament state so the game page picks up where it
			// left off.
			if (existing.tournamentId) {
				const t = this.tournaments.get(existing.tournamentId);
				if (t) {
					deliveries.push({
						to: tag,
						message: { type: 'tournament-assigned', v: V,
							tournamentId: existing.tournamentId,
							tournamentType: 'challenge' as const,
						} satisfies TournamentAssignedMessage,
					});
					const bracket = t.buildPublicBracket();
					if (bracket) deliveries.push(asMD({ to: tag, message: bracket }));
					// Re-send round-open for any READY_WAIT match this player is in
					for (const match of t.getAllMatches()) {
						if (match.phase === 'READY_WAIT' &&
							(match.playerA === tag || match.playerB === tag)) {
							const opponent = match.playerA === tag ? match.playerB! : match.playerA!;
							deliveries.push({
								to: tag,
								message: {
									type: 'round-open', v: V,
									matchId: match.matchId,
									roundIndex: match.roundIndex,
									opponent,
									openedAt: Date.now(),
									deadline: Date.now() + 24 * 60 * 60 * 1000,
								},
							});
						}
					}
				}
			}
			return deliveries;
		}
		this.registered.set(tag, { identity, tournamentId: null });

		const others = Array.from(this.registered.keys()).filter((t) => t !== tag);
		const deliveries: ManagerDelivery[] = [];

		// Tell the new player who's online
		deliveries.push({
			to: tag,
			message: {
				type: 'registered', v: V,
				nametag: tag,
				onlinePlayers: others,
			} satisfies RegisteredMessage,
		});

		// Tell everyone else this player came online
		const onlineMsg: PlayerOnlineMessage = {
			type: 'player-online', v: V,
			nametag: tag, online: true,
		};
		for (const other of others) {
			deliveries.push({ to: other, message: onlineMsg });
		}

		return deliveries;
	}

	unregister(nametag: string): ManagerDelivery[] {
		const player = this.registered.get(nametag);
		if (!player) return [];

		// Remove from queue if present
		this.leaveQueue(nametag);

		// Remove from any active tournament
		if (player.tournamentId) {
			const t = this.tournaments.get(player.tournamentId);
			if (t) {
				const tDeliveries = t.removePlayer(nametag);
				this.playerToTournament.delete(nametag);
				// Convert tournament deliveries
				// (simplified — in production we'd handle forfeit properly)
			}
		}

		this.registered.delete(nametag);

		// Cancel any pending challenges involving this player
		for (const [id, ch] of this.challenges) {
			if (ch.from === nametag || ch.to === nametag) {
				this.challenges.delete(id);
			}
		}

		// Notify others
		const offlineMsg: PlayerOnlineMessage = {
			type: 'player-online', v: V,
			nametag, online: false,
		};
		const deliveries: ManagerDelivery[] = [];
		for (const tag of this.registered.keys()) {
			deliveries.push({ to: tag, message: offlineMsg });
		}
		return deliveries;
	}

	/** Clear a player's tournament assignment if the tournament is finished. */
	private clearStaleTournament(player: RegisteredPlayer, nametag: string): void {
		if (!player.tournamentId) return;
		const t = this.tournaments.get(player.tournamentId);
		if (!t || t.getPhase() === 'DONE') {
			this.playerToTournament.delete(nametag);
			player.tournamentId = null;
		}
	}

	isRegistered(nametag: string): boolean {
		return this.registered.has(nametag);
	}

	// ── Challenge ────────────────────────────────────────────────

	sendChallenge(from: string, opponent: string, wager: number): ManagerDelivery[] {
		if (!this.registered.has(from)) return [err(from, 'not_registered', 'register first')];
		if (!this.registered.has(opponent)) return [err(from, 'opponent_offline', `${opponent} is not online`)];
		if (from === opponent) return [err(from, 'self_challenge', 'cannot challenge yourself')];

		const fromPlayer = this.registered.get(from)!;
		const toPlayer = this.registered.get(opponent)!;
		this.clearStaleTournament(fromPlayer, from);
		this.clearStaleTournament(toPlayer, opponent);
		if (fromPlayer.tournamentId) return [err(from, 'in_tournament', 'you are already in a tournament')];
		if (toPlayer.tournamentId) return [err(from, 'opponent_busy', `${opponent} is in a tournament`)];

		const challengeId = `ch-${this.nextId++}`;
		this.challenges.set(challengeId, {
			id: challengeId,
			from,
			to: opponent,
			wager,
			createdAt: Date.now(),
		});

		return [
			{
				to: from,
				message: {
					type: 'challenge-sent', v: V,
					challengeId, opponent,
				} satisfies ChallengeSentMessage,
			},
			{
				to: opponent,
				message: {
					type: 'challenge-received', v: V,
					challengeId, from, wager,
				} satisfies ChallengeReceivedMessage,
			},
		];
	}

	acceptChallenge(nametag: string, challengeId: string): ManagerDelivery[] {
		const ch = this.challenges.get(challengeId);
		if (!ch) return [err(nametag, 'invalid_challenge', 'challenge not found or expired')];
		if (ch.to !== nametag) return [err(nametag, 'not_your_challenge', 'this challenge is not for you')];

		this.challenges.delete(challengeId);

		// Create a 2-player tournament
		const tournamentId = `challenge-${this.nextId++}`;
		const tournament = new Tournament({
			id: tournamentId,
			capacity: 2,
			minPlayers: 2,
			readyRateLimitMs: this.readyRateLimitMs,
		});
		this.tournaments.set(tournamentId, tournament);

		// Assign both players
		const fromPlayer = this.registered.get(ch.from);
		const toPlayer = this.registered.get(ch.to);
		if (!fromPlayer || !toPlayer) {
			return [err(nametag, 'player_gone', 'opponent disconnected')];
		}

		fromPlayer.tournamentId = tournamentId;
		toPlayer.tournamentId = tournamentId;
		this.playerToTournament.set(ch.from, tournamentId);
		this.playerToTournament.set(ch.to, tournamentId);

		// Add both players — second add triggers auto-start
		const deliveries: ManagerDelivery[] = [];
		const assignMsg = (tag: string): TournamentAssignedMessage => ({
			type: 'tournament-assigned', v: V,
			tournamentId, tournamentType: 'challenge',
		});
		deliveries.push({ to: ch.from, message: assignMsg(ch.from) });
		deliveries.push({ to: ch.to, message: assignMsg(ch.to) });

		const d1 = tournament.addPlayer(fromPlayer.identity);
		const d2 = tournament.addPlayer(toPlayer.identity);
		deliveries.push(...d1.map(asMD), ...d2.map(asMD));

		return deliveries;
	}

	declineChallenge(nametag: string, challengeId: string): ManagerDelivery[] {
		const ch = this.challenges.get(challengeId);
		if (!ch) return [err(nametag, 'invalid_challenge', 'challenge not found')];
		if (ch.to !== nametag) return [err(nametag, 'not_your_challenge', 'this challenge is not for you')];

		this.challenges.delete(challengeId);
		return [{
			to: ch.from,
			message: {
				type: 'challenge-declined', v: V,
				challengeId, by: nametag,
			} satisfies ChallengeDeclinedMessage,
		}];
	}

	// ── Rolling queue ────────────────────────────────────────────

	joinQueue(nametag: string): ManagerDelivery[] {
		if (!this.registered.has(nametag)) return [err(nametag, 'not_registered', 'register first')];
		const player = this.registered.get(nametag)!;
		this.clearStaleTournament(player, nametag);
		if (player.tournamentId) return [err(nametag, 'in_tournament', 'already in a tournament')];
		if (this.queue.includes(nametag)) return [err(nametag, 'already_in_queue', 'already queued')];

		this.queue.push(nametag);

		// Start countdown when we hit min players.
		// The actual firing happens in tick() which runs every second.
		if (this.queue.length >= this.queueMinPlayers && !this.queueStartsAt) {
			this.queueStartsAt = Date.now() + this.queueCountdownMs;
		}

		return this.broadcastQueueState();
	}

	leaveQueue(nametag: string): ManagerDelivery[] {
		const idx = this.queue.indexOf(nametag);
		if (idx === -1) return [];
		this.queue.splice(idx, 1);

		// Cancel countdown if we dropped below min
		if (this.queue.length < this.queueMinPlayers) {
			this.queueStartsAt = null;
		}

		return this.broadcastQueueState();
	}

	/** Called when the queue countdown expires. Creates a rolling tournament. */
	private fireQueue(): ManagerDelivery[] {
		this.queueStartsAt = null;
		console.log(`[queue] fireQueue: ${this.queue.length} players in queue`);

		if (this.queue.length < 2) return [];

		// Take up to queueMaxPlayers from the queue
		const players = this.queue.splice(0, this.queueMaxPlayers);
		const tournamentId = `rolling-${this.nextId++}`;
		const tournament = new Tournament({
			id: tournamentId,
			capacity: players.length,
			minPlayers: players.length,
			readyRateLimitMs: this.readyRateLimitMs,
		});
		this.tournaments.set(tournamentId, tournament);

		const deliveries: ManagerDelivery[] = [];
		for (const tag of players) {
			const player = this.registered.get(tag);
			if (!player) continue;
			player.tournamentId = tournamentId;
			this.playerToTournament.set(tag, tournamentId);

			deliveries.push({
				to: tag,
				message: {
					type: 'tournament-assigned', v: V,
					tournamentId, tournamentType: 'rolling',
				} satisfies TournamentAssignedMessage,
			});
			deliveries.push(...tournament.addPlayer(player.identity).map(asMD));
		}

		// Broadcast updated queue state (now empty or smaller)
		deliveries.push(...this.broadcastQueueState());

		return deliveries;
	}

	/**
	 * Must be called periodically (e.g., every second) to check if the
	 * queue countdown has expired. Returns deliveries from fireQueue.
	 * This exists because setTimeout callbacks can't return deliveries
	 * through the normal flow.
	 */
	/** Challenge timeout in ms. */
	static readonly CHALLENGE_TIMEOUT_MS = 30_000;

	tick(): ManagerDelivery[] {
		const deliveries: ManagerDelivery[] = [];

		// Queue countdown
		if (this.queueStartsAt && Date.now() >= this.queueStartsAt) {
			deliveries.push(...this.fireQueue());
		}

		// Expire stale challenges
		const now = Date.now();
		for (const [id, ch] of this.challenges) {
			if (now - ch.createdAt > TournamentManager.CHALLENGE_TIMEOUT_MS) {
				this.challenges.delete(id);
				deliveries.push({
					to: ch.from,
					message: { type: 'error', v: V, code: 'challenge_expired', message: `Challenge to ${ch.to} expired` },
				});
			}
		}

		// Check tournament timeouts (ready-wait, result)
		for (const t of this.tournaments.values()) {
			const tDeliveries = t.checkTimeouts();
			deliveries.push(...tDeliveries.map(asMD));
		}

		// Clean up done tournaments
		this.cleanupDone();

		return deliveries;
	}

	private broadcastQueueState(): ManagerDelivery[] {
		const msg: QueueStateMessage = {
			type: 'queue-state', v: V,
			position: 0,
			total: this.queue.length,
			startsAt: this.queueStartsAt,
		};
		// Send to ALL registered players so everyone sees the queue
		// size (not just people in the queue). Queued players get
		// their position; non-queued players get position=0.
		const deliveries: ManagerDelivery[] = [];
		for (const tag of this.registered.keys()) {
			const queueIdx = this.queue.indexOf(tag);
			deliveries.push({
				to: tag,
				message: { ...msg, position: queueIdx >= 0 ? queueIdx + 1 : 0 },
			});
		}
		return deliveries;
	}

	// ── Tournament routing ───────────────────────────────────────

	/** Find the tournament a player is in (for routing match messages). */
	getTournament(nametag: string): Tournament | null {
		const id = this.playerToTournament.get(nametag);
		return id ? this.tournaments.get(id) ?? null : null;
	}

	/** Get a tournament by ID (for spectators). */
	getTournamentById(id: string): Tournament | null {
		return this.tournaments.get(id) ?? null;
	}

	/** All active tournaments (for spectator overview). */
	getActiveTournaments(): Array<{ id: string; tournament: Tournament }> {
		return Array.from(this.tournaments.entries())
			.filter(([, t]) => t.getPhase() !== 'DONE')
			.map(([id, tournament]) => ({ id, tournament }));
	}

	/** Clean up finished tournaments. */
	cleanupDone(): void {
		for (const [id, t] of this.tournaments) {
			if (t.getPhase() === 'DONE') {
				// Release players
				for (const [tag, tid] of this.playerToTournament) {
					if (tid === id) {
						this.playerToTournament.delete(tag);
						const player = this.registered.get(tag);
						if (player) player.tournamentId = null;
					}
				}
				this.tournaments.delete(id);
			}
		}
	}

	// ── Stats ────────────────────────────────────────────────────

	getOnlineCount(): number { return this.registered.size; }
	getQueueLength(): number { return this.queue.length; }
	getActiveTournamentCount(): number {
		return Array.from(this.tournaments.values()).filter(t => t.getPhase() !== 'DONE').length;
	}
}

function err(to: string, code: string, message: string): ManagerDelivery {
	return { to, message: { type: 'error', v: V, code, message } };
}

/** Convert a Tournament Delivery to a ManagerDelivery. */
function asMD(d: { to: string; message: unknown }): ManagerDelivery {
	return { to: d.to, message: d.message as Record<string, unknown> };
}
