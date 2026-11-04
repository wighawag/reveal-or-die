---
title: A dead avatar can be withdrawn, deposited again and re-entered alive; it must stay dead
slug: a-dead-avatar-stays-dead
spec: games-on-this-foundation (template-commit-reveal work)
blockedBy: []
home: reveal-or-die (bomber-world takes it by cascade)
---

# Death costs nothing today: withdraw, deposit, enter, alive

Found 2026-11-04 while planning bomber-world's skulls; the maintainer had assumed the only way to get an avatar back was to exit. It is not.

## Measured

- `_withdraw` (`contracts/src/game/internal/UsingGameInternal.sol`) refuses only a LIVING in-world avatar (`AvatarStillInGame`); a dead one is taken off its zone, `inGame` cleared, and the NFT returned.
- `_getResolvedAvatar` reads an avatar that is not `inGame` as `life = 1`, and `_resolveActions` sets `life = 1` on an Enter.
- So a dead avatar's owner deposits it again (`_deposit` does not look at its history) and enters: alive. The stake this game is named for (the avatar's life) is lost for one withdraw and one deposit.

## What to do

A death is permanent: the avatar is retired, and an Enter (or a deposit) of a retired avatar is refused. Death is LAZY (`_getResolvedAvatar` computes it from `_explosions` and the miss deadline at read time, with no transaction to hang a write on), so the retirement is recorded where it is first acted on: `_withdraw` of a dead avatar marks it retired before returning it, and `_enter` refuses a retired one (and one whose resolved life is 0). Pin both in `contracts/test/js/Game.test.ts`.

Do it with, or before, `reveal-or-die-adopts-the-commit-reveal-base` (template-commit-reveal `work`): the port touches custody (`_takeSeat`/`_startWaitingFor`) and the life rule (`_forfeit`), which is where this lives. bomber-world needs it for its skulls (a skull must cost a purchased avatar, or collecting one's own is a farm).

## Acceptance

- A dead avatar, withdrawn and deposited again, cannot enter; a test shows it.
- An avatar that EXITED (alive) can still come back, as today.
- The order of reveals still never changes the outcome.
