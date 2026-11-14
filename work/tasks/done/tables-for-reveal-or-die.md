---
title: Tables for reveal-or-die - a game for a fixed set of avatars, created by anyone, that ends
slug: tables-for-reveal-or-die
spec: play-modes, games-on-this-foundation (template-commit-reveal work)
blockedBy: [reveal-or-die-adopts-the-commit-reveal-base]
home: reveal-or-die (bomber-world takes it by cascade)
---

# Tables for reveal-or-die

## Done, 2026-11-14, on local preview branches `pr1b/*`, NOT pushed

Built from stratagems' port plan, step R1b (`main`, `work/plans/join-template-commit-reveal.md`, section "Step R"), its decisions R1b-1 to R1b-19 taken with the maintainer on 2026-11-13. They replace the steps and open questions below, which are kept as what was asked; the decisions of 2026-11-04, 11-05 and 11-12 below still stand except where R1b says otherwise (a table pays the avatar's R1a stake in ETH rather than keeping a tally; the `numMoves` option is deferred).

**The decisions (R1b-1 to R1b-18)**: the mode is the table's `gameOptions`, `{uint8 mode}` (0 avatar, 1 ETH, every other byte zero), refused where it is read; avatar mode seats an avatar carrying exactly the table's stake, ETH mode seats `join()` for exactly that stake, the seat's id the account's address, one per account; the table's stake is the deployment's (`data.Table.stake`, the sale's, recorded on the factory); the death clock starts at the table's start for every seat, entered or not; no exit, and nobody leaves between the start and the close; `closeTable()` by anyone once the last cycle has passed or at most one seat is alive, fixing the end cycle, the survivors and the leftovers; the table keeps its own seated list (a forfeited member's body counts); `releaseLeftover(body)` by anyone after the close, refused while the body has open claims, into a pot the survivors share (the remainder stays), or to the body's owner when nobody survived; table-only routes (`UsingGameTable`, the world's routes with it compiled in, a `GameTable` route), the world byte-identical but for the metadata hash; `data.Table` (`TimedWithEarlyAdvance`, the world's durations, `numMoves` 10, `numMissesAllowed` 1); the lobby asks the mode with a select (template-commit-reveal `work`: `a-table-option-may-offer-choices`); bomber-world takes it by cascade and exports no `lobby` until stratagems' step R2.

**`main`** (from `origin/main` 070176ee):

- `a572f7f5` the template's cascade (`TableOptionField.choices`).
- `e8538fe5` the test first (failing): `Tables.test.ts`, 16 cases: the mode refused where read, the stake equal, a seat leaving before the start, a never-entered seat dying, an exit dropped, the order replay at a table, the close early (refused while two are alive, in a reveal phase, and while the one alive has committed) and after the last cycle, a forfeited member's body, the payouts in both modes, a leftover refused with open claims, the pot and its remainder, nobody surviving, the world's reveal gas pinned.
- `8b2e41ba` seven internals `virtual` (`_deposit`, `_withdraw`, `_commitTurn`, `_exit`, `_getResolvedAvatar`, `_releaseBody`, `_getBody`): the world's routes byte-identical but for the metadata hash.
- `89fc5bfa` `src/game/table/`: `UsingGameTable` (ERC-7201 storage `reveal-or-die.storage.Table`), `GameTableRoutes.sol` (the five world routes with it), `GameTable` (`join`, `closeTable`, `releaseLeftover`, `getTable`, `getSeated`, `getCycle`), `030_deploy_tables.ts` (`GameTableImplementation`, a router, no proxy; `GameTableFactory`, `CommitRevealGameFactory` with the config and the stake as linked data; all deterministic), `data.Table`, and `AVATAR_STAKE` shared by the sale and the tables.
- `90f7d817` the client: `world/table.ts` (the lobby, exported from `world/game.ts`; the table store; every word of the HUD's table lines), the setup's Join in ETH mode and a held avatar's seat, no exit offered at a table, no empty turn once the table is closable (so the close is taken in a commit phase), a table's cycle read from `getCycle`, the offline world without the tables; unit tests.
- `9fd670da` `tables.e2e.ts`, one story per mode; the HUD asks a seated ETH player to authorise over the table's lobby.
- `20e8be0c` the world's reveal gas a named constant, which bomber-world pins to its own.
- `33a22bba` the LAN package's pnpm deps hash recomputed: stale since the lockfile changed in fd51f913 (the T2 cascade), so `nix build .#lan` failed on `main` before this step too.

**bomber-world `main`** (from 26d6520d): `ed403867` the cascade (five conflicts, both sides kept; `GameHud.svelte` kept bomber-world's skin with no table UI; `data.Table.actionsPerReveal` 16, since bombs take two actions and the constructor refuses less); `b0cdccee` `tables.e2e.ts` omitted, `world/game.ts` exporting no `lobby`; `9d90b12e` the second cascade, the gas pin bomber-world's own (670,769, the world's routes byte-identical to 26d6520d).

## Measured

- Contracts: **84 passing** (from 68); bomber-world **86** (from 70). Deployed sizes (EIP-170 24,576): `GameTableGetters` 10,387, `GameTableDeposit` 14,021, `GameTableCommit` 7,832, `GameTableReveal` 19,599, `GameTableLoot` 9,250, `GameTable` 12,830 (bomber-world 12,507, 15,774, 9,558, 21,461, 9,250, 13,777). The world's six routes byte-identical but for the metadata hash, here and in bomber-world; the world's reveal of 3 collects and 10 moves 560,811 gas before and after (bomber-world 670,769). The table router routes 43 selectors in 8 routes.
- Check 0 errors and 0 warnings in both; unit **2239 + 78** (from 2217 + 78), bomber-world **2329 + 78** (from 2307 + 78); dangling imports and omissions clean.
- e2e: **57 passed, 2 skipped** (9.3 min; from 55 and 2), `tables.e2e.ts` included (avatar mode 2.8 min, ETH mode 2.9 min); RPC 8557, app 4183.
- `nix build git+file://$PWD#lan` passes at 33a22bba.

## Surprises

- A seat that never enters could not die (`_getResolvedAvatar` gives life 1 outside the world), the exploit R1b-5 closes.
- The close had to be taken in a commit phase with no living seat committed, or a reveal after it could claim a body counted as a leftover; so the client stops a lone survivor committing empty turns once the table is closable.
- In ETH mode nothing funds the browser's key (a purchase does), and the creator's start is sent by that key: the first e2e run failed on `start` with `NotDelegate`, and the HUD now asks a seated player to authorise over the table's lobby.

## The ETH seat funds the browser's key, the maintainer, 2026-11-14

Asked after the build ("funding could have an option to send eth to an address so the local key can be funded as part of the tx"): `join(address payable stipendTo, uint256 stipend)`, payable with exactly the stake plus the stipend, forwards the stipend to `stipendTo` after the seat is taken, as the avatars' sale does (`NoStipendRecipient` for a stipend with nowhere to go); `fb92d4d7`, one more contract case (17). The client takes an ETH seat through the acquisition rail (`createTableSeatAcquisition`, chosen by `createSeatAcquisition` once the table reads as ETH mode), so taking it funds and authorises this browser's key in the one transaction, as a purchase does; the button says "Join for" the stake plus the stipend; `683d8e65`. The authorise prompt over the lobby stays, for a second browser. bomber-world `898de4f1` (two conflicts, its character choice kept in the avatar purchase).

Measured again: contracts 85 (bomber-world 87); `GameTable` 13,148 bytes; unit 2241 + 78 (bomber-world 2331 + 78); check 0 and 0; e2e 57 passed and 2 skipped in both (9.5 and 6.6 min), the ETH story now with no authorise step; the LAN build passes at 683d8e65.

## What was asked (kept)

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

## The base adoption landed, 2026-11-05

reveal-or-die main 4aaa00bd, bomber-world main c2d706d9 (template-commit-reveal `work`: `work/tasks/done/reveal-or-die-adopts-the-commit-reveal-base.md`). What a table builds on now: custody is a seat (`_takeSeat`, so a closed roster refuses a deposit once started), `_forfeit` is the place a missed reveal would kill, `releaseDeadAvatar` stops the cycle waiting for the dead (a table can drive it from `members()` rather than from the board), and `actionsPerReveal` is immutable per deployment, so a table's `numMoves` option must not exceed the deployment's.

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

## Decisions, the maintainer, 2026-11-05

- **A dead avatar stays in the game for good** (`a-dead-avatar-stays-dead`, landed main 64a5ed00): no withdraw of a dead one; withdraw only out of the world and alive (exited, or never entered). On the base this is custody: a dead avatar never leaves, as a seized one does not on template-commit-reveal `with/nft-identity`.
- **A collected skull clears its body**, after the claim cycle has finished (not in a reveal), and **the NFT is burned**, with the sale refusing an id that has existed before.
- **The claim share is computed after the cycle, not in the reveal**: a reveal records the claim and counts claimants for (skull, cycle) in O(1), reading the skull's first-claim cycle (same answer in any order, the `_place` exemption, to be argued in code and tested in two orders); `cashOut` divides, over finished cycles only.

## Decisions, the maintainer, 2026-11-12 (stratagems' plan, "Step R": R-1 to R-8)

The loot above is replaced by the stake in the avatar (`stake-in-the-avatar`, done on `pr1a/*`): a body holds its avatar's ETH stake and what it collected, shared by whoever collects it in the first cycle it is collected in, and a withdrawal pays what the avatar collected. For TABLES (this task, R1b):

- **No exit at a table**: it ends at its last cycle or as soon as at most one avatar is alive; each survivor withdraws its stake and what it collected; a dead player gets nothing. Bodies uncollected at the end are split equally among the survivors.
- **Two kinds of table, chosen at creation**: avatar mode (the deposited NFT is the stake, a tally) and token mode (a fixed stake a seat in ETH, an ERC20 per implementation later; the avatar for display only, never sent; the character still dies and its body holds the tokens).
- **Death at a table**: `numMissesAllowed` 1 in the table implementation.
- **Gas**: each player their own, through their browser key; the creator pays the creation.
