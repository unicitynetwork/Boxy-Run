# Tournament System V2 — Design Spec

## Overview

Single-elimination bracket tournaments that run over days. Players
sign up during a registration window. Once registration closes, the
bracket is generated and rounds begin. Each round gives players 24h
to play their match. The game runs INLINE on the tournament page —
no page redirects, no WebSocket drops.

## Tournament Lifecycle

```
REGISTRATION → ACTIVE (round 1) → ACTIVE (round 2) → ... → COMPLETE
```

## Key Design Decisions

1. **Operator-created**: tournaments are created manually (not auto-queued)
2. **Free entry**: no UCT deposit for now
3. **24h per round**: configurable per tournament
4. **Inline game**: Three.js renders inside the tournament page (no redirect)
5. **Persistent state**: SQLite database survives server restarts
6. **Server-side replay**: authoritative scores from input trace replay

## Data Model (SQLite)

```sql
CREATE TABLE tournaments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'registration',
    -- registration | active | complete | cancelled
    max_players INTEGER NOT NULL DEFAULT 32,
    round_hours INTEGER NOT NULL DEFAULT 24,
    current_round INTEGER NOT NULL DEFAULT -1,
    -- -1 = registration, 0+ = round index
    created_at TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE TABLE registrations (
    tournament_id TEXT NOT NULL,
    nametag TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    PRIMARY KEY (tournament_id, nametag)
);

CREATE TABLE matches (
    id TEXT PRIMARY KEY,
    -- format: {tournament_id}/R{round}M{slot}
    tournament_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    slot INTEGER NOT NULL,
    player_a TEXT,
    player_b TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    -- pending | ready_wait | active | complete | forfeit
    winner TEXT,
    score_a INTEGER,
    score_b INTEGER,
    seed TEXT,
    started_at TEXT,
    completed_at TEXT,
    round_deadline TEXT
);

CREATE TABLE match_inputs (
    match_id TEXT NOT NULL,
    side TEXT NOT NULL, -- 'A' or 'B'
    tick INTEGER NOT NULL,
    payload TEXT NOT NULL
);
```

## REST API

```
POST   /api/tournaments              — create tournament (operator)
GET    /api/tournaments              — list tournaments
GET    /api/tournaments/:id          — get tournament details + bracket
POST   /api/tournaments/:id/register — register for tournament
GET    /api/tournaments/:id/bracket  — get bracket with match statuses
```

## WebSocket Protocol (simplified)

Only needed during live matches. Players connect to the tournament
page. When both players of a match click Ready, the WebSocket
handles:

```
Client → Server:
  match-ready    { matchId }
  input          { matchId, tick, payload }
  result         { matchId }  // "I'm done, replay my inputs"

Server → Client:
  match-status   { matchId, readyA, readyB }
  match-start    { matchId, seed, youAre, startsAt }
  opponent-input { matchId, tick, payload }
  match-end      { matchId, winner, scoreA, scoreB }
  bracket-update { tournamentId, matches[] }
```

## Tournament Page

Single page at /tournament-v2.html?id={tournamentId}

Sections:
1. **Header**: tournament name, status, round info, countdown
2. **Bracket**: visual bracket showing all matches + results
3. **Your Match**: if you're in the tournament + have a current match,
   shows ready status + READY button. When both ready, game renders
   here inline.

## Round Advancement

Server checks periodically (every 60s):
1. Are all matches in the current round complete/forfeit?
2. If yes → advance bracket (winners populate next round), start next round
3. If deadline passed for a match → forfeit logic

## What This Replaces

The entire tournament/server/manager.ts, the challenge system, the
queue system, the redirect flow, and the multi-tournament complexity.
One tournament at a time, persistent, simple.
