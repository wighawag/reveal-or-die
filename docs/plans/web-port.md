# Porting this game's web layer onto the template

Status: plan. The contracts are done; this is what is left. 57 `svelte-check` errors, and the count is a poor guide to the work, because about twenty of them are one deletion and the rest are one connected rewrite.

## The shape of it, in one paragraph

`web/src/lib/context/game.ts` has a literal line in it that says "everything below is what a descendant replaces; everything above is the framework it plugs into". Above the line: chain time, epochs, the round, the camera, canvas events, onchain state, view state. Below the line: imports from `$lib/placement/*`, which is the template's own demo game. The port is to replace those imports with this game's equivalents and satisfy the exported `Game` type. That is the whole job stated correctly, and it is why the work cannot be done in slices: the renderer needs the view state, which needs the board reader, which needs the onchain state, so they land together or not at all.

## Do not delete `lib/placement/` first

It is the only worked example of every seam below, and it is small enough to read in full (`commit-reveal.ts` 235 lines, `state.ts` 129, `view.ts` 67, `render/board-renderer.ts` 71, `render/index.ts` 95). Port against it with both open, and delete it in the same commit that replaces it. It is recoverable afterwards with `git show stem/main:web/src/lib/placement/...`, but reading it from a dead ref while writing its replacement is worse than having it on disk.

## The mapping

| this game, today | what it must become | seam |
|---|---|---|
| `lib/onchain/writes.ts` | `CommitRevealAdapter<bigint, Action>` | `game/core/seams.ts:109` |
| `lib/onchain/zones-fetcher.ts`, `direct-read.ts` | board reader + `zonesForCamera` | cf. `placement/state.ts` |
| `lib/onchain/avatars.ts` | the deposited-avatar store | cf. `placement/reserve.ts` |
| `lib/private/localState.ts` | `RoundStorage<Action>` | `game/core/round.ts:136` |
| `lib/private/auto-commit-reveal.ts` | the round's `autoCommit` / `autoReveal` | `game/core/round.ts:143` |
| `lib/render/*`, `lib/core/render/*` | `GameRenderer<Container>` via `createStatefulRenderer` | `game/render/stateful.ts:85` |
| `lib/core/epoch/*` | delete; use `game/core/epoch` | |
| `lib/core/time/*` | delete; use `game/core/chain-time` | |
| `lib/view/index.ts` (this game's, now replaced) | a `mergeView` producing the renderer's view | cf. `placement/view.ts` |
| `lib/ui/flows/purchase/*` | the template's `ui/credits` top-up flow | it is a strict superset |
| `lib/screens/*`, `lib/ui/*` | `routes/play` plus context members | |

### The identity is the avatar, and the seam already allows it

`PlayerIdentity = bigint | \`0x${string}\`` (`seams.ts:34`), and `createRound<TIdentity extends PlayerIdentity, TAction>`. The template's game is keyed by account address; this one commits per avatar, so it is `RoundStore<bigint, Action>` keyed by avatar id. Nothing needs widening.

**Decided: one active avatar per client.** `Game.identity` is the active avatar id, undefined until one is chosen, and the round is keyed by it. A player who wants to run two avatars opens a second browser.

Three consequences follow, and the second one is the one that will bite.

**The round storage key must include the avatar id.** Switching the active avatar in one browser would otherwise load the previous avatar's planned actions and commit them for the new one.

**Nothing on chain partitions authority per avatar, so "one at a time" is a client convention and not a guarantee.** That is the direct consequence of choosing account-wide delegation: `_requireAccountForAvatar` resolves the avatar's owner and asks whether the sender may act for that ACCOUNT, so every signer the account has delegated can move every avatar it owns. Two browsers signed into the same account therefore hold two signers that are each fully authorised over both avatars, and only the client's choice keeps them apart.

If two clients do pick the same avatar, the failure is a lost turn rather than anything unsound. Verified against a local chain: a second `commit` for the same avatar in the same epoch REPLACES the first, because `_makeCommitment` only rejects a commitment left over from a DIFFERENT epoch. So the later client's commitment stands, and the earlier client then fails its reveal with `CommitmentHashNotMatching`, since the stored hash is no longer the one its secret matches. With `autoCommit` on this repeats every epoch. A client can detect it cheaply (`getCommitment(avatarID).epoch` is the current epoch but the hash does not match anything it planned) and should say so rather than silently losing turns.

**Two browsers on two DIFFERENT accounts need none of this.** Each account owns its own avatars and the two never touch: separate delegations, separate commitments, separate storage. If the point is simply to play two avatars at once, that is the clean way to do it, and it is the only one the contract actually enforces.

## Order

1. ~~**Board reader and view.**~~ **DONE**, `lib/world/state.ts` and `lib/world/view.ts`, with 15 tests. `zoneID` went into the contracts js package because it has to match `PositionUtils.getZone` exactly, and is pinned from both sides. Not wired into the context yet, so the error count did not move.
2. ~~**The renderer.**~~ **DONE**, `lib/world/render/`. Still to do when `pixi-viewport` finally goes: drop the `ssr.noExternal` entry in `vite.config.ts` that exists only for it.
3. ~~**The adapter.**~~ **DONE**, `lib/world/commit-reveal.ts`, with the packing in the contracts package so the contract tests exercise it.
4. **Wire `context/game.ts`**, satisfy the `Game` type, delete `lib/placement/` in the same commit. THIS IS THE NEXT STEP and it is the one that finally moves the error count, because it is the first that deletes rather than adds.

### Step 4a is DONE: the five modules exist

`lib/world/` now holds `config.ts`, `storage.ts`, `planning.ts`, `deposited.ts` and `missed-reveal.ts` alongside `state.ts`, `view.ts`, `commit-reveal.ts`, `errors.ts` and `render/`. Nothing is wired, so the tree is green at 54 errors and 40 `lib/world` tests pass.

**What is left is 4b, the wiring, and it is one commit because it is the one that deletes.** In order: rewrite `context/game.ts` below its line against the modules above, satisfy the exported `Game` type (which changes shape here: no `reserve` or `cost`, but an `activeAvatarID` and a `deposited`), update `context/types.ts`, point `routes/play/+page.svelte` at the new renderer, delete `lib/placement/` and its four test files, and then fix this game's old UI components, which is the long tail: `GameClock`, `TopBar`, `GameInfo`, `EnterFlow`, `PurchaseFlow`, `Tutorial` and `GameScreen` all read a context shape that no longer exists. Deleting `lib/placement` is what clears the 6 failing context tests, and deleting `lib/core/time` clears the last framework-boundary failure.

### What step 4 needed (for reference)

`context/game.ts` imports eleven things from `$lib/placement`. Five have replacements (`commit-reveal`, `errors`, `render`, `state`, `view`); `cells` has no equivalent and goes. The remaining five have to be written, about 690 lines of template code to re-express, and three of them carry real design content rather than being transcription:

- ~~**`config.ts`**~~ done.
- ~~**`storage.ts`**~~ done. The key includes the avatar, and `data` persists as a STRING because a packed position exceeds `Number.MAX_SAFE_INTEGER` once y is non-zero.
- ~~**`planning.ts`**~~ done, with 17 tests. It mirrors the contract's rules, including that nothing may follow an `Enter` and that an obstacle step is refused before it can silently drop the rest of the turn.
- ~~**`reserve.ts`**~~ done as `deposited.ts`. It ignores the contract's `more` flag and terminates on an empty page instead, which is correct whichever way the flag lies.
- ~~**`missed-reveal.ts`**~~ done. About unblocking play rather than reporting a loss, since acknowledging currently forfeits nothing.

Also needed while wiring: `Game.identity` becomes the active avatar id, and something has to choose it. See the active-avatar decision above.
5. **The UI**, which is the long tail: `getUserContext` is `getAppContext` now, and the legacy modals under `core/ui/modal/legacy-*.svelte` go when their callers do.

## What the renderer port fixes on the way

From the audit, all verified in the current source. Adopting the template's layer removes four live bugs rather than merely relocating code: `viewport.resize()` called with no arguments, the `setTimeout(..., 10)` drag/click hack, the `($camera.y + y || 0)` precedence bug in `core/render/camera.ts:43`, and a scene that never clears on state reset. Three files are already dead and should not be carried across: `WallRenderer.ts`, `world.epochSeen` (written, never read), and the grid built in `PixiCanvas.svelte` and never added to the stage.

One thing will block it and is worth knowing before starting: `render/renderer.ts` currently constructs `createOperations` plus keyboard and gamepad handling inside the renderer, and the seam cannot express that, so all three move to the context's `start()`.

### Assets are the APP's problem, not the framework's

The template calls `onAppStarted` the moment the app is ready and loads nothing, because it has nothing to load. That is correct and is not a gap to backport: `template-commit-reveal` is a commit-reveal framework, and an app built on it need not be a game with art at all, so a game-asset gate does not belong there.

So the gate is app-level here, the shape `bomber-world` already uses: `lib/world/render/assets.ts` owns the bundle and publishes progress, `lib/ui/loading/` presents it, and `+layout.svelte` covers the app until it completes. The scene objects still build texture-dependent parts lazily, because the splash hides the window rather than removing it: the canvas mounts underneath, so an object CAN be created before the bundle lands, it just cannot be seen.

One silent-failure risk: `markAsPlayerControlled` runs on every emission today, but the template's stateful renderer only calls `update` when the diff says something changed. "Which avatar is mine" is not part of the entity, so unless it becomes one, the player's own avatar can render as somebody else's indefinitely.

## Backports this port should produce

These are things this game has and the template lacks, which a sibling would want. They belong upstream, at `template-commit-reveal`, not here.

- `Reconciler` iteration: `reconcile.ts` exposes no `values()`, yet `game/render/README.md` sells the stateful renderer for per-object animation.
- Object pooling, as an optional recycle seam on the reconciler rather than a pool class, so `reconcile.ts` stays pure and pixi-free.
- Keyboard and gamepad as intent recognisers, in the shape `gestures.ts` already uses.
- Zoom-aware grid alpha, which `seams.ts:220` already says the template wants.
- Cursor pagination `(startIndex, limit) -> (items, more)` on unbounded getters. The template's `GameGetters._cellsInZones` is unbounded and its own comment records the previous version blowing the `eth_call` cap. Write the arithmetic fresh: this repo's version has the `more` flag inverted.
- `SignerOutOfFundsError` and the `send()` funnel in `commit-reveal.ts`. Nothing in either is about a particular game: one names the single failure a player can act on (the local signer is out of gas, so top up the SIGNER and not the wallet), the other is the wait-for-inclusion plus classify-once boundary every write goes through. Both were copied out of `placement/` verbatim, which is the signal: a second descendant would copy them again.

## Known failing while this is mid-flight

Both groups are consequences of the contracts already being this game's while the web is still the template's, and both resolve when `lib/placement/` goes.

- **6 context tests** (`fatal.test.ts`, `ssr-context.test.ts`): `resolvePlacementConfig` reads `Game.linkedData.placementCost` and `linkedData.tokens`, which belong to the template's game.
- **`framework-boundary.test.ts`**: `core/time/index.ts`, `core/ui/loading/SplashScreen.svelte` and `core/ui/loading/splash.ts` import `$app/*` outside `lib/kit`. `core/time` is already marked for deletion above; the splash screen needs to move behind the kit seam or be added to `KNOWN_LEAKS` with a reason.

## Still open, not part of this

- `Avatars.mint` has no access control, so the stake costs nothing. Recorded in `Avatars.sol` and in `identity-without-consent.md`. Closing it is a decision about who may mint.
- `_enter` accepts an obstacle as an entry position, so an avatar can stand inside a wall. The `basic test` walks out of one.
- A rejected move sets `stopProcessing` and silently drops the remaining actions in the same reveal, which is indistinguishable from a reveal that did nothing.
