---
title: Tables for reveal-or-die - a game for a fixed set of avatars, created by anyone, that ends
slug: tables-for-reveal-or-die
spec: play-modes, games-on-this-foundation (template-commit-reveal work)
blockedBy: [reveal-or-die-adopts-the-commit-reveal-base]
home: reveal-or-die (bomber-world takes it by cascade)
---

# The template has tables; this game cannot offer them until its contracts stand on the base

Asked for by the bomber-world maintainer, 2026-11-03 ("I still do not see option for lobby"). The home menu's "Tables" entry and the `/lobby/` route arrived by cascade and stay hidden, by design: they appear only when the game's `$app-specific` module exports a `lobby`, and this game cannot yet.

## Start here, from a cold context

```sh
git -C ../template-commit-reveal show with/all:web/src/lib/placement/table.ts       # the reference game's lobby: 33 lines
git -C ../template-commit-reveal show with/all:contracts/deploy/030_deploy_lobby.ts # GameLobbyImplementation via a router + CommitRevealGameFactory
git show main:contracts/src/commit-reveal/CommitRevealLobby.sol                     # initializeLobby, start, forfeitMember, getRoster, getEnd, getGameOptions
git show main:web/src/lib/game/lobby/table.ts | head -80                            # TableLobby: factory, deploymentsAt, options
git -C ../template-commit-reveal show work:work/tasks/backlog/reveal-or-die-adopts-the-commit-reveal-base.md
```

## Why it is blocked

A table is a clone of a lobby implementation (`CommitRevealGameFactory.createGame`), and the lobby is the commit-reveal base (`CommitRevealLobby is UsingCommitReveal`): roster, start, end after the cycles its creator chose, game options. reveal-or-die's `Game` is its own mechanism (1,422 lines apart from the template's `UsingGameInternal`, one-array reveal, manual phase) and its deploys stop at `020_deploy_sale`. The prerequisite is the existing backlog task `reveal-or-die-adopts-the-commit-reveal-base` (template-commit-reveal `work`), whose timing is this repo's maintainer's call.

## bomber-world's port is not this repo's port plus nothing (added 2026-11-03)

bomber-world's contracts are this repo's plus bombs: `BombLogic.sol`, the `PlaceBomb`/`PlaceBombDelayed` actions, `_bombs`/`_explosions`, `MAX_BOMBS_PER_SUBMISSION`, `BOMB_REACH`, and death by blast in `_getResolvedAvatar` (some 369 lines). Landing the base adoption here and cascading it does not port bomber-world: the cascade will conflict in exactly the files that carry the bombs, and the port there must carry the bomb logic onto the base too, with the order-independence argument (`BombLogic` writes only cycles after the revealing one) re-checked against the base's chunked reveal. Plan the two ports together.

## The steps (after the base adoption)

1. Contracts: a lobby implementation of this game (its routes plus the lobby route, as the reference game's 030 does), a factory, `030_deploy_lobby.ts`. Decide what a table's avatars are: today an avatar lives in the one open world; at a table the roster is the avatars seated at creation. Game options worth asking at creation: number of cycles (the base's end rule), and one game option to prove the path (e.g. bombs per turn).
2. Client: `world/table.ts` exporting `lobby: TableLobby` (`factory`, `deploymentsAt`, `options.describe`), re-exported from `world/game.ts`, so Home shows "Tables" and `/lobby/` lists and creates them.
3. AI at a table is OUT of scope here: an online table's seats are people. (The offline world's Bomber seats are `a-bomber-ai-for-world-seats`.)
4. e2e: create a table for two, both sit, play to the end, the board takes no turn after it.

## Acceptance

- The base adoption's acceptance holds first.
- Tables e2e green in reveal-or-die and bomber-world; "Tables" appears on Home only in this game's build.
- The order of reveals never changes the outcome at a table either.

## Open questions for the maintainer

1. Avatars at a table: the same NFT moved into the table (custody), or a per-table avatar? This decides the contract shape.
2. Who pays gas and stake at a table, and what a forfeit costs there (the base makes it configurable).
3. Hotseat at a table (play-modes PRD, open question 1, needs an ADR) is not part of this task.

## Decisions, the maintainer, 2026-11-04 (answers to the questions above and to the plan)

- **A missed reveal does NOT kill yet**: keep today's allowance (`numMissesAllowed`, 3) until the game's front end is well tested; later, kill. On the base this is the game's `_forfeit`, so the switch is configuration.
- **A dead avatar stops blocking the cycle** through a permissionless game route that checks it is dead and calls `_stopWaitingFor`; the advance client and the world's seats call it before advancing. The base is unchanged (its attendance is an O(1) tally by design).
- **One chunk per turn**: `ACTIONS_PER_REVEAL` covers the longest turn that can resolve (moves + 2 bombs + an exit), `furtherActions` is zero, the hash is the base's one encoding, the client keeps one reveal.
- **A table's game option is `numMoves`** (the number of cycles is already the base's).
- **Spawn**: anywhere on chain for now; the client limits entry to the centre zone (bomber-world `world/spawn.ts`, landed 2026-11-04). Bounding the map on chain comes later.
- **A table has a winner, by loot, and so does the open world** (bomber-world's part, after its port): a dead avatar leaves a skull worth one unit (a fixed unit now; the avatar's purchase price minus a fee, later, possibly both); a move over a skull claims it, everyone claiming in the first cycle it is claimed splits it, later claims get nothing; a dead carrier's skull carries its claims; exiting mints the loot carried out (claims from finished cycles, through a separate `cashOut`), only exited skulls count, nothing mints for exiting empty. At a table the winner is who cashed out the most; a table keeps a tally rather than minting the world's token, for now.
- **Prerequisite: `a-dead-avatar-stays-dead`** (this branch): without it a skull of one's own second avatar is free loot.
