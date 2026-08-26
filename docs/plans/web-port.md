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

1. **Board reader and view.** `zonesForCamera` plus a reader over `getAvatarsInMultipleZones`, then a merge into the view the renderer consumes. Nothing else can be tested until state flows.
2. **The renderer.** This game's pixi objects become a `createStatefulRenderer` over `Container`, replacing `placement/render`. Take the four fixes noted below while moving, and drop `pixi-viewport` with the `ssr.noExternal` entry in `vite.config.ts` that exists only for it.
3. **The adapter.** `writes.ts` becomes `CommitRevealAdapter`. Two things must change here regardless: the deposit payload is now a single `owner` rather than `(owner, controller)`, and the faucet path that signs with `PUBLIC_FAUCET_PRIVATE_KEY` goes, replaced by the template's `PUBLIC_FAUCET_API` and top-up flow.
4. **Wire `context/game.ts`**, satisfy the `Game` type, delete `lib/placement/` in the same commit.
5. **The UI**, which is the long tail: `getUserContext` is `getAppContext` now, and the legacy modals under `core/ui/modal/legacy-*.svelte` go when their callers do.

## What the renderer port fixes on the way

From the audit, all verified in the current source. Adopting the template's layer removes four live bugs rather than merely relocating code: `viewport.resize()` called with no arguments, the `setTimeout(..., 10)` drag/click hack, the `($camera.y + y || 0)` precedence bug in `core/render/camera.ts:43`, and a scene that never clears on state reset. Three files are already dead and should not be carried across: `WallRenderer.ts`, `world.epochSeen` (written, never read), and the grid built in `PixiCanvas.svelte` and never added to the stage.

Two things will block it and are worth knowing before starting. There is no asset-readiness gate: this game reads textures synchronously in constructors and waits for `Assets.loadBundle` before starting, while the template calls `onAppStarted` immediately. And `render/renderer.ts` currently constructs `createOperations` plus keyboard and gamepad handling inside the renderer; the seam cannot express that, so all three move to the context's `start()`.

One silent-failure risk: `markAsPlayerControlled` runs on every emission today, but the template's stateful renderer only calls `update` when the diff says something changed. "Which avatar is mine" is not part of the entity, so unless it becomes one, the player's own avatar can render as somebody else's indefinitely.

## Backports this port should produce

These are things this game has and the template lacks, which a sibling would want. They belong upstream, at `template-commit-reveal`, not here.

- An asset-readiness gate before `onAppStarted` (high value; it blocks this port outright).
- `Reconciler` iteration: `reconcile.ts` exposes no `values()`, yet `game/render/README.md` sells the stateful renderer for per-object animation.
- Object pooling, as an optional recycle seam on the reconciler rather than a pool class, so `reconcile.ts` stays pure and pixi-free.
- Keyboard and gamepad as intent recognisers, in the shape `gestures.ts` already uses.
- Zoom-aware grid alpha, which `seams.ts:220` already says the template wants.
- Cursor pagination `(startIndex, limit) -> (items, more)` on unbounded getters. The template's `GameGetters._cellsInZones` is unbounded and its own comment records the previous version blowing the `eth_call` cap. Write the arithmetic fresh: this repo's version has the `more` flag inverted.

## Still open, not part of this

- `Avatars.mint` has no access control, so the stake costs nothing. Recorded in `Avatars.sol` and in `identity-without-consent.md`. Closing it is a decision about who may mint.
- `_enter` accepts an obstacle as an entry position, so an avatar can stand inside a wall. The `basic test` walks out of one.
- A rejected move sets `stopProcessing` and silently drops the remaining actions in the same reveal, which is indistinguishable from a reveal that did nothing.
