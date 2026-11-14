---
title: The stake is in the avatar, and a body is shared by whoever collects it
slug: stake-in-the-avatar
spec: games-on-this-foundation (template-commit-reveal work)
blockedBy: [a-dead-avatar-stays-dead]
home: reveal-or-die (bomber-world takes it by cascade)
---

# The stake in the avatar, and its bodies

Built from stratagems' port plan, step R1a (stratagems `main`, `work/plans/join-template-commit-reveal.md`, sections "Step R" and its R1a decisions), decided with the maintainer on 2026-11-12. It replaces the loot of 2026-11-04 and 11-05 in `tables-for-reveal-or-die` (a skull worth one minted unit) with ETH staked in the avatar: "exiting should give you the staked token in the avatar"; avatars must not trust any game, present or future; "each avatar should always carry the same amount ... exiting should be about paying what you collected and leave the avatar whole"; and no unbounded loop, except the collects a turn names. Tables (R1b) and bomber-world's bomb kills (R2) build on it.

## Done, 2026-11-12, on local preview branches `pr1a/*`, NOT pushed

**reveal-or-die `main`** (from `origin/main` c596f966):

- `a83e4586` the tests first (failing): `contracts/test/js/Loot.test.ts`; `Action.data` widened to `uint256` (a body is named by its 256-bit avatar id; every existing hash is unchanged, `abi.encode` pads both to a word) and `ActionType.Collect`; the sale's `stake` in the deploy data; `actionsPerReveal` 14 (10 moves, 3 collects, an exit).
- `78b76803` the contracts: `Avatars.stakeOf`, fixed by a payable `mint` and paid out only by `burn(id, data)` from the avatar's HOLDER (the `data` is the call the stake arrives with, because the game's proxy rejects plain ETH: the game names its `receiveStake`); a burned id cannot be minted again (solidity-kit's burn leaves a nonce). The sale charges fee plus stake and mints with the stake; the free-list waives the fee, never the stake. The game: `Collect` (at most `MAX_COLLECTS` = 3 a turn) checked against the avatar's cell at that point of its turn and the body dead in this cycle, recorded after the turn as a claim (`_claims`, a count per body, the first claimed cycle); `settleClaim(collector, body)`, anyone, once that cycle is over: the first settlement burns the body (its holder is the game), its pot is the stake plus what it carried, each share `pot / claimants` (the remainder stays), added to what the collector carries while the game holds it, paid to its owner otherwise; a body with claims of its own open is not released (`BodyHasOpenClaims`); a withdrawal pays what the avatar carries. The order-independence argument is at `_collect`; `Loot.test.ts` replays a shared body in two orders.
- `38fa0b4c` an avatar's open claims are a LIST (swap-and-pop, O(1)), with `getOpenClaims`, so a client finds the bottom of a dead carrier's chain without scanning logs.
- `f8c18f24`, `e3af7535` the web: the purchase pays price and stake; `world/loot.ts` (the bodies where the plan ends, a random choice when a turn has no room for all, the shares, settling a chain from the bottom up, withdrawing, burning a held avatar), `planning.collect`, `ui/LootPanel.svelte`; a Collect moves nothing, so the plan's end and the drawn path skip it.
- `070176ee` `e2e/tests/loot.e2e.ts`: a node account's avatar left to die, ours collects it from the HUD, takes its share once final, walks out by the exit, is taken out of the game and paid exactly the stake (`CarriedPaid`), its own stake unchanged. Also the loot store followed nothing (a `derived` of a constant emits once).

**bomber-world `main`** (from `origin/main` 4a44e654), by merge (`26d6520d`): ten conflicts, all resolved by keeping both sides: `Collect` after `PlaceBomb` and `PlaceBombDelayed` in the enum (5 in this game), `ACTIONS_BESIDES_MOVES` = 2 bombs + 3 collects + 1, `actionsPerReveal` 16, `_placeBomb` taking the widened `uint256`, the planner's bombs beside its collects, the HUD's character picker beside the loot panel. A body killed by a blast is collectible like one dead of misses (`_getResolvedAvatar` decides both); R2 re-checks the order argument for blast deaths.

## Deviations from the decisions, and why

- **No settlement inside a reveal or a withdrawal** (R1a-5 had "at its next reveal, at its withdrawal, or by anyone"): settling in a reveal would make a turn's Collects depend on whether another transaction of the same cycle had settled a body first, which is order dependence. Settling is `settleClaim` alone (the HUD's "Take your shares"); a withdrawal pays what is settled, and a claim settled after it is paid to the owner directly.
- **A body's value is shown in the HUD where the plan ends, not drawn on the board** (R1a-8): the board's skull is unchanged.
- **`burn(id, data)`**, not `burn(id)`: the game's proxy rejects plain transfers (`ETHER_REJECTED`), measured.

## Measured

- Contracts: reveal-or-die **68 passing** (from 56: 12 in `Loot.test.ts`, the longest turn and the configuration floor updated); bomber-world **70 passing**. A reveal with 10 moves and 3 collects stays under `REVEAL_GAS` (5 M).
- Unit: reveal-or-die **2217 + 78** (from 2208 + 78), bomber-world **2307 + 78** (from 2298 + 78); check 0 errors and 0 warnings in both; dangling imports clean.
- e2e: reveal-or-die **55 passed, 2 skipped** (6.4 min, `loot.e2e.ts` included; the skips are the offline AI and hotseat suites, as before), `loot.e2e.ts` alone 4.8 min; bomber-world **57 passed, 2 skipped** (6.5 min).
