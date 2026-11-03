---
title: The offline world's seats play Bomberman (a "Bomber" level), not a three-step random walk
slug: a-bomber-ai-for-world-seats
spec: games-on-this-foundation (template-commit-reveal work)
blockedBy: []
home: split - the plumbing at reveal-or-die (cascades to bomber-world), the Bomber strategy at bomber-world
---

# World seats wander; they should hunt, bomb and run

Asked for by the bomber-world maintainer, 2026-11-03: "plan for lobby including a basic fun ai". This is the AI half, and it needs no contract change, so it comes first.

## Where it lives (corrected 2026-11-03, after this file was first committed)

This file first said the whole task was reveal-or-die's. That was wrong: **reveal-or-die has no bombs**. `BombLogic.sol`, `contracts/js/bombs.ts` and `web/src/lib/world/bombs.ts` exist only in bomber-world (its contracts differ from this repo's by some 369 lines), so a Bomber strategy written here would have nothing to bomb with. The task splits along the framework's seam:

- **reveal-or-die: the plumbing.** `web/src/lib/world/strategy.ts` (the one file a game replaces: `WORLD_SEAT_LEVELS = []`, `createWorldSeatStrategy = undefined`), `offline-players.ts` and `offline.ts` adopting `game/core/strategy.ts` (a seat's `level`, `AI_LEVELS`, `PLAYED_TURNS_STORAGE_KEY`, the stored turn tried first at reveal), and a test with a scripted strategy. This repo still offers no level, so its lobby is unchanged; it cascades to bomber-world unchanged.
- **bomber-world: the Bomber level.** Its own `world/strategy.ts` (levels Random and Bomber, the board read with `world/state.ts`'s `createWorldReader`) and a pure `world/bomber.ts` (`decideBomberTurn`), its tests, the lobby skin and the e2e. Steps 1, 3 and 4 below are bomber-world's; step 2 is this repo's.

## Start here, from a cold context

```sh
git show main:web/src/lib/offline-players.ts | sed -n 130,280p     # today: turnFor, a seeded walk of 3 steps, never a bomb
git show main:web/src/lib/game/core/strategy.ts | head -80          # the framework's seam: Strategy, seededRandom, decidePlayedTurn, AiLevel
git show main:web/src/lib/offline-lobby.ts | sed -n 55,80p          # the lobby offers levels only if $lib/offline exports AI_LEVELS
git -C ../template-commit-reveal show pa1/main:web/src/lib/placement/strategy.ts   # the worked example: the reference game's greedy seat
git -C ../template-commit-reveal show 1f088d01 --stat               # what that adoption touched (offline.ts, offline-players.ts, tests)
git show main:contracts/js/bombs.ts                                 # blastCells: the client's copy of the blast, pinned against the contract
```

## What it has today, measured 2026-11-03

`offline-players.ts` `turnFor`: not in the world, ENTER a seeded cell near the origin; in the world, walk at most `STEPS_PER_TURN = 3` steps, each the first legal neighbour from a seeded rotation; boxed in, the empty turn. Never a bomb. `$lib/offline` exports no `AI_LEVELS`, so the lobby shows no level choice. The framework seam (`game/core/strategy.ts`) is already on main, unused by this game.

## What "basic fun" means (the behaviour, in priority order)

Decided at commit time from what any player can see (the board as revealed so far; other players' commitments are hidden, so the seat knows no more than a person does). One pure function, `decideBomberTurn(view, me, rng, budget)`, in the game's own `strategy.ts`:

1. **Never end a turn in a blast.** No cell in the reach of a bomb that goes off next cycle (instant bombs from this cycle and delayed ones from the last), and no step onto a cell a delayed bomb is sitting on (`_isValidMove` refuses it). A blast of cycle E kills whoever stood in it as E began, so the cell the turn ENDS on is the one that matters.
2. **Attack when it can get away with it.** If some cell C reachable within the move budget has an opponent's current cell in `blastCells(C)`, and from C a safe cell (rule 1, counting this new bomb) is reachable with the moves left: walk to C, drop a bomb, walk to the safe cell. Prefer the instant bomb; a seeded minority of the time the delayed one, which blocks its cell and catches someone a cycle later.
3. **Hunt.** Otherwise walk (BFS over legal cells) toward the nearest living opponent, stopping two or three cells short and on a safe cell.
4. **Wander** when there is nobody to hunt: today's seeded walk, still subject to rule 1.
5. **Spawn** near an opponent but not on top of one (Chebyshev 4 to 7), on a cell no ticking bomb reaches, falling back to today's entry cell.

Personality from `seededRandom`: each seat gets a fixed aggression (how often it takes rule 2 when it can, 40-90%) so seats feel different; a small error rate (it sometimes bombs from one cell further than needed) so it is beatable. Levels: `random` (today's walk, the framework's default, stores nothing) and `bomber` (this).

## The steps

1. Pure strategy and its tests first: `web/src/lib/world/strategy.ts` (or wherever this game's seat logic lives after the AI_LEVELS adoption) with `decideBomberTurn`, its BFS, the safety map from `blastCells` plus live bombs, and the budget (`numMoves`, the bombs a turn may carry).
2. Adopt the seam as the reference game did on pa1: `AI_LEVELS` and `PLAYED_TURNS_STORAGE_KEY` exported from `$lib/offline`; the world's pass calls `decidePlayedTurn` for a `bomber` seat and keeps `turnFor` for `random`. The played-turn storage key is a WIRE from its first build (AGENTS.md, the storage rule).
3. e2e (bomber-world): one person and two Bomber seats, offline; within a few cycles a world seat drops a bomb, and no world seat ever dies in its own blast.
4. Cascade the plumbing to bomber-world; its lobby shows "How does each world seat play?" with Random / Bomber (UI work there, see bomber-world's design/miro/ui-plan.md).

## Acceptance

- Unit: rule 1 holds on every generated board (property test over seeded boards: the decided turn never ends in next cycle's blast given the visible bombs); rule 2 fires when a kill is available and safe; the decision is deterministic for a seed; all actions are legal (`isValidMove`, bomb count, move budget).
- The order of reveals still never changes the outcome (`contracts/test/js/Game.test.ts` untouched and green).
- e2e as in step 3, in bomber-world; verify and e2e green in reveal-or-die (plumbing, no level offered) and bomber-world.
- A person can beat it, and loses to it sometimes: played by the maintainer before it is called done.
