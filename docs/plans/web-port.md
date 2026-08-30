# Porting this game's web layer onto the template

Status: the web port is DONE. `svelte-check` is at 0 errors (from 57 when this was written), the whole suite passes, and `pnpm build localhost` succeeds. What is left is listed under "Follow-ups" at the bottom, and none of it blocks playing.

## The shape of it, in one paragraph

`web/src/lib/context/game.ts` has a literal line in it that says "everything below is what a descendant replaces; everything above is the framework it plugs into". Above the line: chain time, epochs, the round, the camera, canvas events, onchain state, view state. Below the line used to be imports from `$lib/placement/*`, the template's own demo game; they are `$lib/world/*` now. The port was to replace those imports with this game's equivalents and satisfy the exported `Game` type. That is the whole job stated correctly, and it is why it could not be done in slices: the renderer needs the view state, which needs the board reader, which needs the onchain state, so they landed together.

## Do not delete `lib/placement/` first

**Done, and it worked.** It was the only worked example of every seam below, and it was small enough to read in full (`commit-reveal.ts` 235 lines, `state.ts` 129, `view.ts` 67, `render/board-renderer.ts` 71, `render/index.ts` 95). It went in the same commit that replaced it, and it is recoverable with `git show stem/main:web/src/lib/placement/...`.

## The mapping

| this game, before the port | what it became | seam |
|---|---|---|
| `lib/onchain/writes.ts` | `CommitRevealAdapter<bigint, Action>` | `game/core/seams.ts:109` |
| `lib/onchain/zones-fetcher.ts`, `direct-read.ts` | board reader + `zonesForCamera` | cf. `placement/state.ts` |
| `lib/onchain/avatars.ts` | `lib/world/deposited.ts` | cf. `placement/reserve.ts` |
| `lib/private/localState.ts` | `RoundStorage<Action>` | `game/core/round.ts:136` |
| `lib/private/auto-commit-reveal.ts` | the round's `autoCommit` / `autoReveal` | `game/core/round.ts:143` |
| `lib/render/*`, `lib/core/render/*` | `GameRenderer<Container>` via `createStatefulRenderer` | `game/render/stateful.ts:85` |
| `lib/core/epoch/*` | deleted; `game/core/epoch` | |
| `lib/core/time/*` | deleted; `game/core/chain-time` | |
| `lib/view/index.ts` (this game's, now replaced) | a `mergeView` producing the renderer's view | cf. `placement/view.ts` |
| `lib/ui/flows/purchase/*` | nothing yet, see Follow-ups | this was wrong: `ui/credits` tops up GAS, and the purchase bought an NFT |
| `lib/screens/*`, `lib/ui/*` | `routes/play` plus context members | |

### The identity is the avatar, and the seam already allows it

`PlayerIdentity = bigint | \`0x${string}\`` (`seams.ts:34`), and `createRound<TIdentity extends PlayerIdentity, TAction>`. The template's game is keyed by account address; this one commits per avatar, so it is `RoundStore<bigint, Action>` keyed by avatar id. Nothing needs widening.

**Decided: one active avatar per client.** A player who wants to run two avatars opens a second browser.

The decision stands; only where it is READ changed while wiring. `Game.identity` stayed as the account address, because the account/signer distinction is a separate thing the UI has to be able to ask about, and the avatar id is `Game.activeAvatarID`. That is what the round, the commitment and the storage key are keyed by, undefined until one is chosen, and `lib/world/active-avatar.ts` is what chooses and remembers it.

Three consequences follow, and the second one is the one that will bite.

**The round storage key must include the avatar id.** Switching the active avatar in one browser would otherwise load the previous avatar's planned actions and commit them for the new one.

**Nothing on chain partitions authority per avatar, so "one at a time" is a client convention and not a guarantee.** That is the direct consequence of choosing account-wide delegation: `_requireAccountForAvatar` resolves the avatar's owner and asks whether the sender may act for that ACCOUNT, so every signer the account has delegated can move every avatar it owns. Two browsers signed into the same account therefore hold two signers that are each fully authorised over both avatars, and only the client's choice keeps them apart.

If two clients do pick the same avatar, the failure is a lost turn rather than anything unsound. Verified against a local chain: a second `commit` for the same avatar in the same epoch REPLACES the first, because `_makeCommitment` only rejects a commitment left over from a DIFFERENT epoch. So the later client's commitment stands, and the earlier client then fails its reveal with `CommitmentHashNotMatching`, since the stored hash is no longer the one its secret matches. With `autoCommit` on this repeats every epoch. A client can detect it cheaply (`getCommitment(avatarID).epoch` is the current epoch but the hash does not match anything it planned) and should say so rather than silently losing turns.

**Two browsers on two DIFFERENT accounts need none of this.** Each account owns its own avatars and the two never touch: separate delegations, separate commitments, separate storage. If the point is simply to play two avatars at once, that is the clean way to do it, and it is the only one the contract actually enforces.

## Order

1. ~~**Board reader and view.**~~ **DONE**, `lib/world/state.ts` and `lib/world/view.ts`, with 15 tests. `zoneID` went into the contracts js package because it has to match `PositionUtils.getZone` exactly, and is pinned from both sides. Not wired into the context yet, so the error count did not move.
2. ~~**The renderer.**~~ **DONE**, `lib/world/render/`.
3. ~~**The adapter.**~~ **DONE**, `lib/world/commit-reveal.ts`, with the packing in the contracts package so the contract tests exercise it.
4. ~~**Wire `context/game.ts`**~~ **DONE**, both halves. 4a added the five modules; 4b did the wiring, deleted `lib/placement/` and then deleted the whole pre-port app behind it.
5. ~~**The UI**~~ **DONE**, as part of 4b. Where each pre-port component went:

| pre-port | now | why |
|---|---|---|
| `ui/GameClock.svelte` | `world/ui/GameClock.svelte` | kept, as a props-only dial. It used to read `twoPhase`, `localState` and `deployments` itself; everything it decided is in `world/ui/hud.ts` |
| `ui/GameInfo.svelte` | `world/ui/DeathNotice.svelte` | kept, asking a question that can actually be true |
| `ui/tutorial/` | `world/ui/{Tutorial.svelte,tutorial.ts}` | kept. The `seen` flag was the last thing left on `private/localState.ts` |
| `ui/flows/enter/` | the avatar picker and the `instruction` line in `GameHud` | its whole state machine (sign in, have avatars, deposit, ready) is `setupNeeded` plus `deposited` |
| `ui/structure/TopBar.svelte` | the template's `ui/navbar/` | superseded. It was a second `fixed top-0 z-50 h-12` bar, so it would have sat ON TOP of the navbar. Its one unique thing, the moves counter, is in the HUD |
| `screens/GameScreen*.svelte` | `routes/play/+page.svelte` + `core/ui/AppShell.svelte` | superseded |
| `ui/flows/purchase/` | `world/purchase.ts` plus the `buy` action on the setup gate | rewritten, not ported: the old one branched over a faucet key and a payment rail, and one `AvatarsSale.purchase` call replaces both |

### Step 4b is DONE: the context plays this game

`context/game.ts` below its line is `$lib/world` throughout, `context/types.ts` points at `WorldState`/`WorldView`, and `routes/play/+page.svelte` mounts this game's renderer and HUD. `lib/placement/` and its four test files are gone, and so is `lib/core/time/`, which was the last `framework-boundary` offender.

**The `Game` type changed shape, and the shape follows what is at stake.** No `reserve` and no `cost`: this game bonds nothing per round, it stakes an AVATAR the contract already holds. So `deposited` answers the question `reserve` answered, the per-round price disappears rather than being renamed to zero, and the setup gate's third step is `deposit` rather than `stake`. `identity` stays as the ACCOUNT, because the account/signer split is still the safety property of the design; `activeAvatarID` is what the round, the commitment and the storage key are keyed by.

Two decisions in the wiring are not transcription:

- **`currentPosition` comes from `avatarsPerOwner`, not from the board.** The board is camera-scoped, so a player who panned away from their own avatar would have it read as "not in the world" and their next click would be planned as an entry rather than a step.
- **The click handler branches on it**, because the contract makes the two irreversibly different. `_enter` sets `stopProcessing`, so an Enter is the whole turn; a refused Move sets it too and silently drops the REST of the turn. `enterAt` replaces the plan and `stepTo` refuses an illegal step for exactly those reasons.

**The pre-port app was then deleted whole**, because it hung off `screens/GameScreen.svelte`, which nothing had imported since the wiring landed. `lib/world/active-avatar.ts` was the one module 4a had not anticipated: something has to choose the avatar and remember the choice.

Two defects were found while porting rather than fixed in passing:

- The old "your avatar died" modal asked whether the ACTIVE avatar had run out of life. It could never have fired, because nothing sane picks a dead avatar to play, so the question was false from the instant it became true. It now asks about the account's avatars.
- The tour pointed at `#arena`, an id nothing has ever had, so that step silently did nothing.

### Step 4a is DONE: the five modules exist

`lib/world/` holds `config.ts`, `storage.ts`, `planning.ts`, `deposited.ts` and `missed-reveal.ts` alongside `state.ts`, `view.ts`, `commit-reveal.ts`, `errors.ts` and `render/`. Nothing was wired at the end of 4a, so the tree was green at 54 errors with 40 `lib/world` tests passing.

4b then wired them, and is written up above.

### What step 4 needed (for reference)

`context/game.ts` imports eleven things from `$lib/placement`. Five have replacements (`commit-reveal`, `errors`, `render`, `state`, `view`); `cells` has no equivalent and goes. The remaining five have to be written, about 690 lines of template code to re-express, and three of them carry real design content rather than being transcription:

- ~~**`config.ts`**~~ done.
- ~~**`storage.ts`**~~ done. The key includes the avatar, and `data` persists as a STRING because a packed position exceeds `Number.MAX_SAFE_INTEGER` once y is non-zero.
- ~~**`planning.ts`**~~ done, with 17 tests. It mirrors the contract's rules, including that nothing may follow an `Enter` and that an obstacle step is refused before it can silently drop the rest of the turn.
- ~~**`reserve.ts`**~~ done as `deposited.ts`. It ignores the contract's `more` flag and terminates on an empty page instead, which is correct whichever way the flag lies.
- ~~**`missed-reveal.ts`**~~ done. About unblocking play rather than reporting a loss, since acknowledging currently forfeits nothing.

Also needed while wiring, and correctly predicted: something has to choose the avatar. That became `lib/world/active-avatar.ts`, the sixth module. See the active-avatar decision above.

## What the renderer port fixed on the way

From the audit, all verified against the pre-port source before it was deleted. Adopting the template's layer removed four live bugs rather than merely relocating code: `viewport.resize()` called with no arguments, the `setTimeout(..., 10)` drag/click hack, the `($camera.y + y || 0)` precedence bug in `core/render/camera.ts:43`, and a scene that never cleared on state reset. Three files were already dead and were not carried across: `WallRenderer.ts`, `world.epochSeen` (written, never read), and the grid built in `PixiCanvas.svelte` and never added to the stage.

The blocker the audit named was real: `render/renderer.ts` constructed `createOperations` plus keyboard and gamepad handling INSIDE the renderer, and the seam cannot express that. Click handling moved to the context's `start()` as planned. Keyboard and gamepad did not move, they went: see Follow-ups.

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

## Known failing while this was mid-flight, all resolved

Both groups were consequences of the contracts already being this game's while the web was still the template's, and both went with `lib/placement/`.

- ~~**6 context tests**~~ (`fatal.test.ts`, `ssr-context.test.ts`): `resolvePlacementConfig` read `Game.linkedData.placementCost` and `linkedData.tokens`, which belong to the template's game.
- ~~**`framework-boundary.test.ts`**~~: `core/time/index.ts` was the last file importing `$app/*` outside `lib/kit`. The splash moved to `lib/ui/loading/` earlier in the port, so `KNOWN_LEAKS` is still empty.

## Follow-ups

None of these blocks playing. In rough order of what a player would miss first.

- ~~**Getting an avatar.**~~ **DONE**, `lib/world/purchase.ts`, wired to the `deposit` step of the setup gate. This was estimated as "its own piece of work" on the strength of how big the pre-port `onchain/writes.ts` version was; that turned out to be wrong, and the reason is worth remembering. What made the old one big was the faucet private key and the payment-rail branching, neither of which is needed: `AvatarsSale.purchase` mints straight into the Game in ONE transaction, and `contracts/test/js/Game.test.ts` had been calling it correctly the whole time. Reading the passing test was the whole investigation. The id packing and the argument order live in the contracts package for the usual reason, and the contract test now exercises both.
- **The Exit action is unreachable.** `planning.ts` can name an exit for display but has no `exitAt`, and the only affordance was the D-pad's "instant / exit" button, deleted with the pre-port renderer. The exit tile is drawn now, so the goal is at least visible; reaching it still needs the action, which pairs with the controls below.
- **Keyboard, gamepad and the on-screen D-pad.** Deleted with the pre-port renderer. `docs/audits/03-renderer.md` 3.4 wants them rebuilt as intent recognisers in the shape `gestures.ts` uses, and names four defects not to carry over, including `stopListening()` calling `removeAllListeners()` on an emitter the canvas also uses, which would deafen the click handler.
- **The reveal animation.** Needs a `CommitmentRevealed` log feed, which `lib/world/state.ts` deliberately does not do: it reads standing avatars out of storage, and history is a different question.
- **Drop `pixi-viewport`**, along with the `ssr.noExternal` entry in `web/vite.config.ts` that exists only for it. Nothing imports it any more. `gsap`, `pretty-ms` and `@pixi/devtools` went unreferenced with the old renderer too and can go in the same pass.
- ~~**`test/lib/context/fatal.test.ts` times out in full runs on this repo.**~~ **FIXED UPSTREAM**, and it was never that test. Vitest defaulted to one worker per core and ran both projects at once, so a suite that touches the app barrel had 48 forks competing for memory; the hang guard was simply the first thing to notice. `maxWorkers: '50%'` plus running the two projects one after the other takes this repo from 115-478s and three failures in four runs to 1249 tests in 24 seconds.
- **Withdrawing an avatar**, which is the only thing to do with a dead one. `DeathNotice` says to do it and offers no button. `Game.withdraw(avatarID, to)` is the call; it is the mirror of the purchase and should sit beside it in `lib/world/purchase.ts`.
- **`contracts/js/avatars.ts` is dead**, and exported from the package index. It is the pre-port camera reader, superseded by `lib/world/state.ts`, and it still contains the inverted `more` flag this repo's version was written to avoid. Nothing imports it from anywhere: web, tests or scripts. Delete it, but check no sibling repo has picked it up from the package first.

## Still open, not part of this

- `Avatars.mint` has no access control, so the stake costs nothing. Recorded in `Avatars.sol` and in `identity-without-consent.md`. Closing it is a decision about who may mint.
- `_enter` accepts an obstacle as an entry position, so an avatar can stand inside a wall. The `basic test` walks out of one.
- A rejected move sets `stopProcessing` and silently drops the remaining actions in the same reveal, which is indistinguishable from a reveal that did nothing.
