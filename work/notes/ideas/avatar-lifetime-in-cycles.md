---
title: An avatar lives a fixed number of cycles, then leaves the world whatever gas it has left
type: idea
status: incubating
created: 2026-09-28
relates-to: contracts/src/game/internal/UsingGameInternal.sol (_resolveActions, _exit, _getResolvedAvatar), contracts/js/gas.ts, web/src/lib/world/config.ts (TURNS_OF_GAS), bomber-world
---

# Why

The play key that signs moves is funded once, at purchase, with a stipend sized for `TURNS_OF_GAS` (100) turns (`web/src/lib/world/config.ts`, from the one figure in `contracts/js/gas.ts`). When it runs dry mid-game the remedy today is a top-up, and online that is the wrong moment to ask for one: the clock is ticking, a top-up is a wallet round trip, and missing the reveal window costs the turn and blocks the next one. Refilling automatically is worse, because it moves the player's money without asking at an arbitrary point in a game.

So bound the other side instead: **an avatar entered into the world gets a fixed number of cycles (100 to start with), and when they are up the contract takes it out, whatever gas its key still holds.** The stipend then covers a whole life by construction, and "my key ran out mid-game" stops being a state a player can reach online.

Surfaced while diagnosing the offline world freezing at cycle 16 (reveal-or-die `8de8612e`), where the key ran dry for a different reason (it also pays for pushing the manual cycle). Offline is fixed by giving the key play money; online has no equivalent, hence this.

# The rule, as proposed

- **Lifetime counted from entry.** `_resolveActions` already stamps `startCycleNumber` when an avatar enters (`UsingGameInternal.sol` around line 447), so the end of life is `startCycleNumber + LIFETIME` and needs no new storage. `LIFETIME` is a constructor parameter, read into `linkedData` like `numMoves`, so the client and the contract share it.
- **What "taken out" means is a MODE, not decided yet, and worth play-testing both:**
  - **exit**: the avatar leaves as if it had walked onto an exit tile (`_exit` sets `resolution.left`): it goes back to its owner, out of the world, and can be entered again. The gentle version, and the first intent.
  - **die**: it dies, exactly like missing too many reveals (`life = 0`). The harsh version, which makes the clock part of the game: get to an exit before your time is up.
  A game picks one at deploy; bomber-world might want to try both.
- **Offline: on, but optional.** Offline has no clock pressure and gas is play money (the world refills it), so the reason for the limit is gone there. Keep it available (it is part of the game's rules, and the "die" mode is gameplay, not just economics) and let the offline world configure it off or longer.

# The warning other players need

Other players must see that an avatar is about to leave, or it vanishes (or dies) from the board with no explanation, which reads as a bug.

- **How early:** the principled number is **3x the turns needed to reach an exit from the farthest possible cell**, which depends on the map. Start with a flat **5 turns** left and derive it from the map later.
- **Where:** it is world-space UI (it belongs to an avatar and moves with it), so it is a pixi mark on `AvatarObject`, not a DOM badge. For the player's own avatar, also the HUD's avatar line ("N moves and M bombs left" gains "K cycles left" once the warning starts).
- Pure decision in a `.ts` beside the renderer, like `bombMarks` in `world/render/bombs.ts`: `cyclesLeft(avatar, cycleNumber, lifetime)` and whether to warn, unit-tested; the pixi layer only draws it.

# Open questions to settle before a spec

1. **Lazy or written?** Death is computed lazily in `_getResolvedAvatar` (no transaction ever kills an avatar). Expiry could be computed the same way, but an EXIT also has to take the avatar out of its zone's list and out of `_waitedFor`, which are writes. Who does them: the avatar's next action, anyone calling a public `expire(avatarID)`, or the cycle advance? Check how a lazily-dead avatar is handled in those lists today; expiry in "die" mode may simply reuse it.
2. **Does the manual cycle stop waiting for an expired avatar** at the exact cycle its life ends? It must, or an expired avatar that never acts freezes the manual cycle (the same trap the offline `:v2` key reset avoided).
3. **What a last turn can do.** Is the expiry cycle itself playable (so a player can walk out on their own), or does life end at the start of it?
4. **Does re-entering reset the clock** in "exit" mode? If so, the stipend has to cover several lives, and `TURNS_OF_GAS` should be stated in terms of `LIFETIME`.
5. **Tie to gas explicitly:** `TURNS_OF_GAS` should become `LIFETIME` (plus the cycle-pushing a manual game adds), so the two numbers cannot drift the way `creditsGasMultiplier` did.
