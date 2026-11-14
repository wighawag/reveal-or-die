---
title: A body appears the cycle after its death, and collecting ends the movement
slug: bodies-appear-after-death
spec: games-on-this-foundation (template-commit-reveal work); stratagems' port plan, step R2
blockedBy: [stake-in-the-avatar, tables-for-reveal-or-die]
home: reveal-or-die (bomber-world takes it by cascade)
---

# A body appears the cycle after its death, and collecting ends the movement

## Done, 2026-11-15, on local preview branches `pr2/*`, NOT pushed

Built from stratagems' port plan, step R2 (`main`, `work/plans/join-template-commit-reveal.md`, section "Step R"), its decisions R2-1 to R2-11 taken with the maintainer on 2026-11-14 ("a body killed by a blast is collectable only from the next cycle", "collection should [end the] moves ... other players might want to put a direct bomb in the path", "you can only die where you finish your moves"). The two rules are reveal-or-die's so that both games keep one rule set and the shared `_collect` never conflicts; they are harmless where there are no bombs.

**The decisions taken here**:

- **R2-2a, a body is collectable from the cycle after its death**: `_collectable` asks `_getResolvedAvatar(body, cycleNumber - 1)`, for every death (misses, and in bomber-world a blast). It reads only cycles before the revealing one, so the order argument holds as before. In bomber-world the blast a body died in is the one the screen shows going off in that cycle, so a player could otherwise plan a Collect on an avatar the board had not killed yet. A table closed before a body becomes collectable counts it as a leftover, as before.
- **R2-2b, collecting ends the movement**: once a turn has collected, a later Move is refused as a refused step is (`stopProcessing`), so the turn ends there; Collects (up to `MAX_COLLECTS`) and, in bomber-world, bombs may still follow the first Collect. A collector therefore finishes its turn on the body, where a bomb revealed in the same cycle can catch it. An Exit after a Collect is unchanged (it is not a Move), and a table drops every Exit anyway.
- **The client**: `bodiesAt` offers a body only when its resolved `lastCycleNumber + 1` (its death cycle) is before the cycle being planned; planning offers no step after a Collect (`movesLeft` 0, `stepTo` refused), more Collects still; the HUD counts a turn of Collects alone as planned, so it can be committed (found by bomber-world's `tables-bombs.e2e.ts`: since a body appears a cycle late, a collector already standing on it names it without moving, and the HUD counted only the path, which has no Collect on it).

**`main`** (from `origin/main` 683d8e65):

- `05b92347` the tests first (failing): a body not collectable in its death cycle, collectable in the next; a Move after a Collect ends the turn, Collects still resolve; the two gas cases walk their ten moves before the three collects.
- `168b93ad` the contract: `_collectable` at `cycleNumber - 1`, `_move` refused once the turn has collected; `Tables.test.ts`' `aBodyAt` waits the extra cycle; the world's reveal of 10 moves then 3 collects re-pinned, 564,993 gas (563,916 for the same turn under R1b's rules; 560,811 was R1b's pin, with the collects first).
- `bd6f098f`, `fe21fdbd` the client's tests first, then `bodiesAt` and planning.
- `6495c258` `loot.e2e.ts` waits for the cycle after the death before collecting.
- `eac2e3ae`, `c2ba3eac` the HUD's test first, then a turn of Collects alone committable.

**bomber-world `main`** (from 898de4f1): `8e509de7` the cascade (one conflict, its own gas pin: 674,951), then bomber-world's own half of step R2 (blast bodies tested in `Blasts.test.ts`, the order argument's text in `BombLogic.sol`, its tables shown, `tables.e2e.ts` back and its own `tables-bombs.e2e.ts`), recorded in stratagems' plan and in the commit messages, and `c823bc25` the second cascade (the HUD fix).

## Measured

- contracts **87 passing** (85 plus 2); the world's reveal of 10 moves and 3 collects 564,993 gas, pinned; `GameReveal` 18,898 bytes deployed, `GameTableReveal` 19,674, every route under 24,576.
- check 0 errors and 0 warnings; unit **2243 + 78** (2241 + 78 plus 2); e2e **57 passed, 2 skipped** (10.2 min, RPC 8557, app 4183, free before and after); `nix build git+file://$PWD#lan` passes at c2ba3eac; dangling imports clean, omissions cover all 56 paths.
- bomber-world: contracts **98** (87 plus 2 cascaded plus 9 of its own), unit **2337 + 78**, e2e **60 passed, 2 skipped** (13.1 min: its 57 plus `tables.e2e.ts`' two stories and `tables-bombs.e2e.ts`), the LAN build passes.
