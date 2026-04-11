# Tournament Protocol

A game-agnostic protocol for running knockout tournaments with deterministic,
verifiable matches and on-chain entry fees / payouts on Unicity.

**Status:** draft v0. Not yet implemented. Will be extracted to its own repo
(`unicity-tournaments`) once validated against two independent games.

## Goals

- Run 2–N player single-elimination tournaments with random seeding.
- **Synchronous live matches inside a 24h ready window**: each round opens a
  24h window in which both players must click *ready for match*. When both
  are ready simultaneously, a live head-to-head match starts and one game
  decides the winner.
- Verifiable matches without the server ever executing game logic.
- Trust-minimized entry fees and prize payouts against the Unicity chain.
- Zero per-game code in the tournament server.

## Non-goals (v0)

- **Audience spectating.** Deferred to v1. The two players in a match
  stream inputs to each other, but there is no third-party viewer
  endpoint in v0. Validation does not need spectators (see Validation),
  and the UX / fairness / bandwidth cost of audience streaming is out of
  scope until the core loop is proven.
- Best-of-N matches. v0 is one game per match.
- Non-elimination formats (round-robin, Swiss, ladders).
- Real-time continuous games where "input" isn't discrete events.
- Team play.
- Cross-game tournaments.
- Matchmaking across ready-state over multiple rounds (ready state is
  scoped to a single match; clicking ready in round 1 does not carry into
  round 2).

## Core concepts

| Term | Meaning |
|---|---|
| **Tournament** | A scheduled bracket with an entry fee, a prize pool, and a start condition. |
| **Match** | A single live 1v1 contest within a tournament. Both players face the same seeded world simultaneously; first-to-die (or highest score at time cap) wins. |
| **Round window** | A fixed wall-clock interval (default 24h) during which both players of a match must click *ready for match*. The match itself is live and synchronous; the window only governs when that match can start. |
| **Ready state** | A server-side flag set by the `match-ready` message and cleared on disconnect. A match starts the instant both players in it hold the ready flag. |
| **Seed** | A 32-byte value derived as `hash(tournamentId \|\| roundIndex \|\| matchIndex \|\| sortedPlayerPubkeys)`. Used by the game to generate a reproducible world. Both players of a match receive the same seed. Including player pubkeys prevents cross-tournament seed collision where identical bracket positions would otherwise yield the same world. |
| **Input payload** | **Opaque bytes** representing one player action. The server never decodes this — only relays and timestamps. |
| **Tick** | Logical simulation step, 60 per second by convention. Defined by the game, not the server; server treats ticks as monotonic integers. |
| **Result hash** | A hash of `(seed, inputs[], finalTick, reportedScore)` computed by each player who ran the full match sim. Match validity is determined by comparing the two players' hashes. |
| **Observer** | Either of the two players in a match. In v0 there are always exactly two observers. Each runs the full match sim (own inputs + relayed opponent inputs) to render the game, so a complete `resultHash` falls out of normal play. |

## Opaque payload discipline

This is the one rule that makes the protocol game-agnostic and must not be
violated:

> The tournament server MUST NOT inspect, decode, or depend on the contents
> of `input.payload`, `match.seed`, or `result.scoreContext`. It sees them as
> byte strings to relay, store, and hash.

If the server needs to know anything game-specific to advance the state
machine, the abstraction has failed and we fix the protocol.

## Determinism, time, and resource limits

**Clock ownership.** Each client owns its own match clock, started from
the `startsAt` timestamp in `match-start`. There is no server-issued tick
watermark. The client runs a fixed-step simulation loop (60 ticks per
second by convention; game-specific) derived from its local monotonic
clock.

**Tick-tagged inputs.** Every `input` message carries a `tick` field
equal to the sender's local tick when the input occurred. Receivers apply
opponent inputs at the *tagged tick*, not at the tick they happen to be
on when the message arrives. In practice this means the receiver may
need to:

- Buffer the input briefly if it arrives ahead of the receiver's clock
- Apply it slightly late (with light rollback or tolerance) if it
  arrives after the receiver has already advanced past the tagged tick

The amount of tolerance is game-specific. A game MUST be able to apply
an opponent input 1–2 ticks late without diverging from the authoritative
simulation. Games that cannot (e.g., frame-perfect fighting games) need
a rollback netcode implementation in the client; the protocol does not
mandate a specific scheme.

**Hash over input stream, not over wall time.** The `resultHash` is
computed against `(seed || tick-ordered-input-list || finalTick || scoreA || scoreB || winner)`.
Rendering-time clock skew therefore does not affect hash agreement —
only the tick tags on inputs matter, and those are assigned once by the
sender and never mutated. Two clients that apply the same input list in
the same order at the same tagged ticks MUST produce the same hash.

**Resource limits per match:**

| Limit | Value | Purpose |
|---|---|---|
| `input.payload` size | 256 bytes max | Prevents smuggling; generous for any discrete-event game |
| Input rate per player | 60 inputs/sec max | ~15 KB/s ceiling per stream |
| Total input stream size per player | 1 MB max | ~16 min of max-rate input; well above any expected match |
| Match wall-clock duration | tournament-configurable, default 10 min | Backstop against stuck matches |

Exceeding any limit causes the server to reject the offending input and
transition the match to `MATCH_FLAGGED` for operator review. Limits are
enforced by the server without inspecting payload contents — only the
message size, rate, and cumulative total are checked.

## Tournament lifecycle

```
                         ┌─────────┐
                  create │ PENDING │
                         └────┬────┘
                              │ join (fills or countdown)
                              ▼
                         ┌─────────┐
                         │  LOBBY  │
                         └────┬────┘
                              │ fill reached OR lobbyDeadline expires
                              ▼
                         ┌─────────┐
                         │ SEEDING │ bracket generated, seeds derived
                         └────┬────┘
                              │ broadcast bracket
                              ▼
                         ┌─────────────────┐
                 ┌──────▶│ ROUND_N_OPEN    │ 24h window begins
                 │       │                 │ both players notified
                 │       └────┬────────────┘
                 │            │
                 │            │ window closes (deadline or all matches resolved)
                 │            ▼
                 │       ┌─────────────────┐
                 │       │ ROUND_N_RESOLVE │ winners determined, forfeits applied
                 │       └────┬────────────┘
                 │            │
                 │            │ winners advance
                 │            ▼
                 │       ┌─────────────────┐
                 └───────│ ROUND_N+1_OPEN  │
                 more    └─────────────────┘
                 rounds
                              │ final resolved
                              ▼
                         ┌─────────┐
                         │ PAYOUT  │ distribute prize pool on chain
                         └────┬────┘
                              ▼
                         ┌─────────┐
                         │  DONE   │
                         └─────────┘
```

**Total duration:** with default 24h rounds, a 32-player bracket runs for up
to 5 days (5 rounds × 24h) in the worst case, but can finish much faster if
players are eager — most matches will resolve within minutes of both
players coming online. The 24h is a maximum, not a target. The
`roundWindow` is tournament-configurable; a tournament may shorten it
(e.g. 2h for a speed format) as long as it's announced before LOBBY closes.

**Notifications (implementer responsibility, not protocol):** with long
round windows, players will not be watching the tab when their round
opens. The protocol exposes `round-open` with `openedAt` and `deadline`
so UX layers can drive notifications, but the notification mechanism
itself (browser push, email, wallet event, etc.) is out of scope for the
protocol. Implementers SHOULD provide at least one out-of-band
notification channel for any `roundWindow ≥ 2h`. Tournament operators
SHOULD choose `roundWindow` in light of their audience — 24h is
appropriate for casual play with notifications, 1–2h for scheduled
competitive events where players stay connected, shorter for sprint
formats.

**Round advance condition:** a round window closes when either (a) the
wall-clock deadline is reached, or (b) all matches in the round have been
resolved (played live or decided by forfeit). Early closure is common
because there is no reason to wait once all matches are done.

Failure branches:

- A player never clicking `match-ready` before the round window deadline →
  opponent advances by forfeit with **no run required**. The forfeit is
  instant: the winner does not need to play a solo run against the seeded
  world.
- **Dual forfeit**: if neither player clicks `match-ready` within the
  window, the match is resolved as `dual-forfeit`. Both players are
  eliminated; the winner's slot in the next round receives a bye. This is
  preferable to stalling the bracket.
- **Late window edge case**: if both players click `match-ready` with less
  than the match's typical duration remaining in the window, the match
  still runs to completion. Once started, the live match is not tied to
  the round window; the window only governs when a match may *start*.
- A tournament failing to fill by `lobbyDeadline` → either start with byes
  (if `allowByes`) or refund and cancel.
- Chain verification failing during PAYOUT → tournament enters `PAYOUT_STUCK`,
  requires operator intervention. Funds remain in the escrow wallet; no
  automatic retry that could double-pay.

## Match lifecycle

```
                    ┌──────────────────┐
           round    │ WAITING_READY    │ 24h window; A and/or B not yet ready
           opens  ─▶│                  │◀─ ready flags cleared on disconnect
                    └────┬─────────────┘
                         │
          ┌──────────────┼──────────────┐
          │              │              │
    both ready     deadline, one  deadline, neither
    (same instant) player ready   player ready
          │              │              │
          ▼              ▼              ▼
  ┌──────────────┐  ┌──────────┐  ┌──────────────┐
  │ MATCH_ACTIVE │  │ FORFEIT  │  │ DUAL_FORFEIT │
  │ live sync    │  └────┬─────┘  └──────┬───────┘
  │ inputs       │       │               │
  │ streaming    │       │               │
  └──────┬───────┘       │               │
         │               │               │
   ┌─────┼─────┐         │               │
   ▼     ▼     ▼         │               │
 first  time  player     │               │
 death  cap   disconnect │               │
   │     │     + grace   │               │
   │     │     expired   │               │
   │     │         │     │               │
   │     ▼         │     │               │
   │  compare      │     │               │
   │  scores at    │     │               │
   │  time cap     │     │               │
   │     │         │     │               │
   └──┬──┴──┬──────┘     │               │
      ▼     ▼            │               │
┌──────────────┐         │               │
│ AWAIT_HASHES │         │               │
└──────┬───────┘         │               │
       │                 │               │
       ▼                 ▼               ▼
              ┌─────────────────┐
              │ MATCH_RESOLVED  │
              └─────────────────┘
```

**Entering `WAITING_READY`**: the server transitions a match here the
moment the round opens. Both players receive `round-open` and are free to
click *ready for match* at any point in the 24h window.

**Transition to `MATCH_ACTIVE`**: happens the instant both ready flags are
set simultaneously. The server emits `match-start` with a shared
`startsAt` timestamp (typically now + 3s) so both clients count down to
the same tick-zero. There is no explicit "both ready" confirmation phase —
readiness is atomic.

**Ready flag persistence**: the ready flag is server-side state tied to
the player's WebSocket session. Disconnecting clears it. If a player
clicks ready and then closes the tab, they are no longer ready and cannot
be matched until they reconnect and re-click. This prevents zombie ready
states from kicking off matches the player isn't watching.

**Forfeit (instant)**: if the round window deadline passes and only one
player is ready (or has ever been ready), that player wins immediately
with no run required. The winner advances; no `MATCH_ACTIVE` state is
entered; no result hashes are collected.

**Dual forfeit**: if neither player is ready at the deadline, both are
eliminated. Recorded as `dual-forfeit` in `match-end.reason`.

**Grace period on in-match disconnect**: during `MATCH_ACTIVE`, a brief
disconnect (default 10s) does not forfeit; see Reconnection.

## Messages

All messages are JSON over WebSocket. Binary framing may be added later for
input streams if bandwidth becomes a concern; the shapes below are the
logical contract.

Every message has `{type, v}` where `v` is the protocol version (currently
`0`). Unknown types MUST be ignored by receivers; unknown fields MUST NOT
cause rejection (forward compatibility).

### Client → Server

```ts
// Join a tournament. Sent once after establishing the WS connection.
{
  type: "join",
  tournamentId: string,
  identity: {
    nametag: string,          // Unicity @nametag
    pubkey: string,           // hex, for signature verification
  },
  entry: {
    txHash: string,           // on-chain tx paying the entry fee
    amount: string,           // decimal, for sanity check; server re-verifies on chain
    coinId: string,           // hex
  },
  signature: string,          // signed "(tournamentId|txHash)" proving pubkey ownership
}

// Sent when the player clicks "ready for match". Sets the server-side
// ready flag for this player + matchId. If the opponent is already ready,
// the server immediately emits match-start. The flag is cleared on
// disconnect or by sending match-unready. Re-sending match-ready while
// already ready is idempotent.
//
// Rate limit: match-ready + match-unready combined, max one transition
// per 3000ms per (player, matchId). Rejected toggles return an error
// message; the flag state does not change.
{ type: "match-ready", matchId: string }

// Clear the ready flag before a match has started. Valid only while in
// WAITING_READY state. After match-start the flag is meaningless.
// Subject to the same 3s rate limit as match-ready.
{ type: "match-unready", matchId: string }

// Stream a single game input. Payload is opaque.
{
  type: "input",
  matchId: string,
  tick: number,               // monotonic, game-defined
  payload: string,            // base64-encoded opaque bytes
}

// Heartbeat during an active match. Absence triggers forfeit after timeout.
{ type: "heartbeat", matchId: string, tick: number }

// Report match result. Sent by both players independently when the match
// ends (first-death, time cap, or post-disconnect grace expiry). Each
// player's client derives the hash from its own view of the match
// (own inputs + relayed opponent inputs + shared seed).
{
  type: "result",
  matchId: string,
  finalTick: number,
  score: { A: number; B: number },  // the player's view of BOTH scores
  winner: "A" | "B",                 // the player's view of the winner
  inputsHash: string,                // hash of concatenated input payloads
  resultHash: string,                // hash of (seed || inputsHash || finalTick || scoreA || scoreB || winner)
}

// Graceful disconnect.
{ type: "leave", reason?: string }
```

### Server → Client

```ts
// Sent immediately after a successful join.
{
  type: "lobby-state",
  tournamentId: string,
  players: Array<{ nametag: string; joinedAt: number }>,
  capacity: number,
  startsAt: number | null,    // epoch ms, null if waiting for fill
}

// Sent when the bracket is generated.
{
  type: "bracket",
  tournamentId: string,
  rounds: Array<Array<{
    matchId: string,
    playerA: string | null,   // nametag, null = bye or TBD
    playerB: string | null,
  }>>,
}

// Sent to both players when their next match's ready window opens.
// Players may click "ready for match" any time before `deadline`.
{
  type: "round-open",
  matchId: string,
  roundIndex: number,
  opponent: string,           // nametag; null if opponent TBD (shouldn't happen in v0)
  openedAt: number,           // epoch ms
  deadline: number,           // epoch ms, openedAt + roundWindow
}

// Sent when the opponent's ready state changes. Pure UX hint; does not
// affect match start logic. Useful for showing "opponent is ready" in UI.
{
  type: "opponent-ready",
  matchId: string,
  ready: boolean,
}

// Sent to both players the instant both ready flags are set. Contains
// the shared startsAt for synchronized countdown.
{
  type: "match-start",
  matchId: string,
  seed: string,               // hex, 32 bytes
  opponent: string,           // nametag
  youAre: "A" | "B",
  startsAt: number,           // epoch ms, synchronized countdown
  timeCapTicks: number,       // hard cap for the match
  protocol: {
    heartbeatIntervalMs: number,
    inputAckMode: "none" | "per-tick",
  },
}

// Relayed opponent inputs, so each player's client can run both sides
// of the sim locally and render the opponent.
{
  type: "opponent-input",
  matchId: string,
  tick: number,
  payload: string,
}

// Match result after consensus or resolution.
{
  type: "match-end",
  matchId: string,
  winner: string,             // nametag
  reason: "death" | "timecap" | "forfeit" | "dq",
  scores: { [nametag: string]: number },
}

// Tournament completed.
{
  type: "tournament-end",
  tournamentId: string,
  standings: Array<{ place: number; nametag: string; payout: string }>,
  payoutTxs: Array<{ nametag: string; txHash: string }>,
}

// Generic error.
{ type: "error", code: string, message: string, matchId?: string }
```

## Validation: two-player hash agreement

The server never runs game code. It validates matches by comparing the
`resultHash` reported by each player. No spectators, no voting, no quorum
math — just a 1-bit agreement check.

**Why two players are enough:** in a synchronous 1v1 match, both players
are already running both sides of the sim. Player A receives B's input
stream to render the opponent locally, and vice versa. So each player
naturally computes a full match result covering both players' runs. The
two hashes are independent and adversarial — if either player cheats on
the reported score, the opponent's honest hash will disagree, and
cheating costs the cheater the match plus their entry fee.

**Agreement rule:**
1. Match enters `AWAIT_HASHES` on first death, time cap, or post-
   disconnect grace expiry.
2. Server waits up to `hashTimeoutMs` (default 5000) for a `result`
   message from each player.
3. **If both hashes arrive and agree** → match is `MATCH_RESOLVED`.
   Winner is taken from the agreed `winner` field. Scores from the
   agreed `score.A` / `score.B`.
4. **If only one hash arrives** (the other player disconnected and did
   not return within the grace window) → the single hash is accepted as
   authoritative. The disconnected player is recorded as a forfeit
   regardless of the hash's stated winner.
5. **If both hashes arrive and disagree** → match enters `MATCH_FLAGGED`.
   One player (or both) either cheated or has a determinism bug. Fall
   through to the plugin validator if one is installed; otherwise,
   operator decides. Do not pay out on a flagged match.

**Escalation (optional, pluggable):**
Games MAY ship a server-side headless sim as a plugin
(`validators/plugin.ts`). When present, the plugin runs on `MATCH_FLAGGED`
and its output is authoritative. Useful for high-value tournaments or
when determinism bugs need distinguishing from cheating. For v0 the
escape hatch exists but no plugin is required.

**Trace retention:** the server stores every match's full input trace
(inputs from both players, tick-ordered) along with the seed and both
reported `resultHash` values. Default retention is **permanent** — input
traces are tiny (a Boxy Run match is ~5 KB; a full 32-player tournament
is under 200 KB) and permanent storage supports late audit of flagged
matches, replay playback, and historical leaderboards without added
cost. Operators MAY configure a TTL if GDPR or storage policy requires
it; this is an implementation knob, not a protocol requirement.

The plugin interface is:

```ts
interface GameValidator {
  gameId: string;
  validate(input: {
    seed: Uint8Array;
    inputs: Array<{ tick: number; side: "A" | "B"; payload: Uint8Array }>;
    timeCapTicks: number;
  }): Promise<{
    winner: "A" | "B" | "draw";
    finalTick: number;
    scores: { A: number; B: number };
    resultHash: string;
  }>;
}
```

## Entry fees and payouts

1. Client pays the entry fee to the tournament escrow wallet (`@<tournament-operator>`)
   via a normal Sphere transfer. Client receives a tx hash.
2. Client sends `join` with `entry.txHash`.
3. Server queries the Unicity chain for the tx and verifies:
   - The recipient is the operator wallet.
   - The amount matches `tournament.entryFee`.
   - The sender's pubkey matches `identity.pubkey`.
   - The tx is confirmed and not previously used for another tournament
     (tracked in a `usedTxHashes` set keyed by `tournamentId`).
4. On successful verification, player is admitted to the lobby.
5. On `PAYOUT`, the server initiates transfers from the escrow wallet to
   winner nametags using server-held keys. Payout split is
   tournament-configurable; default is 60/20/10/10 for champion / runner-up /
   semifinalists.
6. Payout tx hashes are recorded in `tournament-end` for client verification.

**Refund path:** if a tournament cancels (fails to fill, operator abort,
payout stuck), the server emits `refund-initiated` messages and returns
entry fees to the paying addresses. Refund txs are recorded so retries are
idempotent.

## Reconnection

- WebSocket connections are ephemeral; a dropped connection does not
  automatically forfeit a match if reconnected within `reconnectGraceMs`
  (default 10000).
- On reconnection, the client sends `resume` with `{tournamentId, identity, signature}`.
  Server responds with the appropriate state message (`lobby-state`,
  `bracket`, `match-start` + backlog of opponent inputs since the last seen
  tick).
- During a match, if player A reconnects, they receive a `match-catchup`
  equivalent so they can resync their local sim. Their own past inputs are
  replayed locally; they cannot change them.
- If reconnection fails within the grace window, the match resolves as
  `forfeit` with the opponent advancing.

## Security model — what this protocol defends against

| Attack | Defense |
|---|---|
| Forged score claim by one player | Opponent re-derives the score from the same inputs + seed; disagreement flags the match |
| Replayed entry fee across tournaments | Server tracks `usedTxHashes` per tournament |
| Impersonation via stolen nametag | Signature over `(tournamentId \| txHash)` using the wallet pubkey |
| Client tampering with own inputs (post-hoc) | All inputs are streamed to the server in real time; the server stores the input trace and the opponent runs the sim against the same trace |
| Client tampering with opponent inputs (local only) | Harmless — only affects what the cheater's own client renders. The hash is computed against the server-relayed inputs, and the opponent's hash won't match |
| Server tampering with payouts | Payout tx hashes are public and verifiable on chain |
| Replay attack on `join` | Signatures include `tournamentId`; one-time use enforced server-side |
| Disconnect-to-avoid-loss | `result` is sent on the way down; absent result plus expired grace = forfeit. A player who quits a losing match still loses |

## What this protocol does NOT defend against

- A game that is not actually deterministic. The abstraction assumes that
  given `(seed, inputs)` every observer produces the same result. A
  non-deterministic game will produce consensus failures on every match.
  This is the game author's responsibility.
- A malicious tournament operator running the escrow wallet. Mitigation is
  multi-sig or a programmatic escrow contract; out of scope for v0.
- Timing-based cheating inside a player's own input stream (e.g., frame-perfect
  input the human couldn't produce). Can be addressed by the game author
  with input-rate sanity checks in the plugin validator.
- **Intentional collusion between opponents.** Alice deliberately throws
  the match so Bob advances, then they split winnings off-chain. In a
  knockout this is fundamentally zero-sum for the colluding pair (one of
  them had to lose anyway), so the attack is weak — it only matters if
  they can pre-arrange which one wins the overall tournament, which
  requires trusting each other over multiple rounds. No protocol
  mitigation; this is a social problem addressed at the identity /
  reputation layer if at all.

## Resolved design decisions

Every decision that affects the wire protocol is resolved for v0. This
section is the log.

- **Match concurrency**: matches within a round run independently. Each
  transitions from `WAITING_READY` → `MATCH_ACTIVE` whenever its own pair
  of players are both ready; they do not wait on other matches in the
  round. The round advances when all matches in it are resolved or the
  round window expires.
- **Match format**: synchronous live head-to-head, one game per match,
  gated by a 24h ready window with explicit *ready for match* button.
- **Minimum observers**: two. Both players of the match, no spectators.
  Hash agreement between the two is sufficient; disagreement flags the
  match.
- **Audience spectating**: deferred to v1. Not in the v0 protocol.
- **Seed derivation**: `hash(tournamentId || roundIndex || matchIndex || sortedPlayerPubkeys)`.
  Deterministic but unique per matchup. Pre-computation between bracket
  draw and match start is still theoretically possible; for v0 this is
  accepted as a limitation of short-deadline tournaments. If it becomes a
  real attack in production, escalate to a random-beacon scheme.
- **Tick clock**: client-owned. Each client runs its own fixed-step loop
  from `startsAt`. Inputs carry sender-local tick tags. The `resultHash`
  is computed over the tick-ordered input stream, not over wall-time
  rendering state, so rendering-time skew does not affect hash agreement.
  See the "Determinism, time, and resource limits" section.
- **Resource limits**: 256 B max per input payload, 60 inputs/sec max per
  player, 1 MB max total input stream per player per match, 10 min default
  wall-clock match duration backstop.
- **Ready spam / griefing**: `match-ready` and `match-unready` combined
  are rate-limited to one transition per 3 seconds per (player, matchId).
  No additional commit-window rules in v0; if griefing emerges in
  practice, add them.
- **Notifications**: out of scope for the protocol. Implementers SHOULD
  provide at least one out-of-band notification channel for any
  `roundWindow ≥ 2h`.
- **Input trace retention**: permanent by default. Traces are tiny and
  permanent storage supports audit, replay, and history at negligible
  cost. Operators MAY TTL if policy requires.

## Deferred to v1

Things intentionally left out of v0 that the protocol should be able to
accommodate later without breaking changes:

- Audience spectating (separate WS endpoint, match-feed, bracket-live,
  fairness gating for players-in-pending-matches).
- Random-beacon seed derivation to fully eliminate pre-computation.
- Best-of-N match formats.
- Multi-sig or programmatic escrow for prize pools.
- Cross-game tournaments.
- Plugin validators for high-value competitive play.

## Validation checklist

Before promoting this doc from draft to v0, it must pass:

- [ ] Express a full match for an endless runner (Boxy Run) end-to-end:
      lobby → ready window → match-start → input streaming → first-death
      → hash agreement → next round. Without extending the protocol.
- [ ] Express a full match for a second, structurally different game
      (candidates: 2D platformer race, trick-taking card game, tile-laying
      puzzle). Without extending the protocol.
- [ ] Walk through every failure branch (forfeit, dual forfeit, disconnect
      during match, hash disagreement, payout stuck) and confirm the
      protocol has a message for each transition.
- [ ] Every still-open question resolved or explicitly deferred.
- [ ] Reviewed by one person who has not read this conversation.
