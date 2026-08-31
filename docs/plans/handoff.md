# Handoff: where reveal-or-die is, and how to work on it

Written at `37bcceb` and updated at `c0d232f`, on `port/template-commit-reveal`.
Read this before `web-port.md`, which is the detailed record; this is the
orientation.

## State

The web port is done. The game is playable end to end: sign in, buy an avatar,
spawn, move, leave, and the round commits and reveals by itself.

| | |
| --- | --- |
| branch | `port/template-commit-reveal`. **Never work on `main`**, which is the pre-port app and 50+ commits behind |
| `cd web && pnpm check` | 0 errors |
| `cd web && pnpm test:unit` | 1317 + 53, all passing, about 25 seconds |
| `cd contracts && pnpm test` | 7 passing |
| `cd web && pnpm build localhost` | clean |

Run `pnpm test:unit`, NOT a bare `vitest`: it runs the two projects one after
the other, and running them together makes the suite take minutes and fail. See
the note in `web/vite.config.ts`, which measured it.

## The single most important thing to understand

This repo is a DESCENDANT of `template-commit-reveal`, which descends from
`jolly-roger`. The `stem` remote points at the template.

**`web/src/lib/core/` and `web/src/lib/game/` are not ours.** They are
byte-identical to upstream, 129 and 19 files, and keeping them that way is what
makes merging free. Before changing anything under those paths, check whether it
is identical to `stem/main`; if it is, the change almost certainly belongs
upstream instead.

What IS ours: `lib/world/` (this game), `lib/context/game.ts` below its stated
line, `lib/world/ui/`, `lib/input/`, `contracts/`, and `routes/play`.

`lib/input/` is the odd one and deliberately so. It is generic (keyboard and
gamepad intent recognisers, in the shape `game/render/gestures.ts` uses) and is
a BACKPORT CANDIDATE with its own README saying where it would land upstream. It
lives outside `lib/game/` because that tree is byte-identical to the template:
something that belongs upstream goes upstream and arrives here by merge, not by
being written into the merged tree by hand.

### Merging from upstream

    git fetch stem
    git merge-tree --write-tree HEAD stem/main    # exit 0 means clean
    git merge --no-ff stem/main

Conflicts are almost always in `web/src/lib/placement/**` (the template's own
demo game, which this repo deleted and replaced with `lib/world/`). The
resolution is to keep them deleted, but **read the diff first**. At `37bcceb` one
of those conflicts carried a real behavioural fix to
`placement/commit-reveal.ts`, the file `lib/world/commit-reveal.ts` was written
from, and deleting our copy of theirs would have discarded it silently. A
modify/delete conflict on a `placement/` file is the only signal that the
template improved something we inherited.

The fanout tool does not reach this repo: it targets `reveal-or-die@main` while
the work is here, so it has been removed from the registry
(`~/.offshoot-stems/template-svelte.json`, `ignore: ["reveal-or-die"]`). Merges
are by hand until that is sorted.

## How the last stretch of work has gone, and the lesson in it

Roughly a dozen defects were found by actually playing the game. The pattern,
which held five or six times:

**Before writing anything in `lib/world/`, check whether the shared layer
already has it.** Payer selection, gas reserves, stale-wallet-balance handling,
a payer chooser, a consent step before a signature: every one of those was
written here first and already existed in `core/funding` or
`ui/credits/top-up-flow.ts`, better, with the reasoning recorded. Each time the
private copy was deleted afterwards. `web/src/lib/ui/credits/README.md` and
`web/src/lib/core/funding/README.md` are the two files worth reading before
building anything that touches money.

**Defects in shared code go upstream, not here.** Five have now been fixed in
`jolly-roger` (or `@etherplay/connect`) and merged back: the "Wallet Action
Required" modal firing on silent signer sends, the funds modal assuming only two
possible payers, the top-up modal opening beneath the modal that raised it, a
delegation signature that no dialog announced, and the test suite's worker
contention. Writing a prompt and waiting is slower per fix and much cheaper
overall, because every sibling gets it and this repo keeps a clean merge.

When writing such a prompt: say which BRANCH it lands on, and check rather than
guess. `jolly-roger@main` has no local signer and composes no payment rail, so
anything touching either belongs on `with/local-signer`. Say "do not touch
reveal-or-die" explicitly, since the fanout skips it.

**Test that the test bites.** Delete the fix, watch the test fail, put it back.
Three tests written during this stretch passed with the code they covered
removed, including one asserting `not.toThrow()` for a defect whose entire
nature was that it did not throw.

## What is left

In the order I would take it. `web-port.md` has the detail.

1. **The red "you cannot move" border**, which wants restyling to match shadcn.
2. **The home page**, which still shows the template's copy rather than this
   game's.
3. **Decide what the exit tile MEANS.** A game-design question, and the one
   thing the controls work deliberately did not settle. See the note below.

Done since this was first written, all recorded in `web-port.md`: the controls
(keyboard, gamepad and an on-screen d-pad), the Exit action, and a purchase
surviving a reload.

## Things that are known and deliberately not fixed

- **The map is one 16x16 area tiled infinitely.** `areaAt` carries a
  `TODO add in genesis hash ?` and returns `Areas[0]` for every zone. The
  renderer is faithful; the data is a placeholder.
- **The round number is an absolute epoch index** (about 44,700,000), because
  `startTime` is 0 and epochs are counted from the unix epoch.
- **MetaMask can refuse a transaction after a faucet claim**, showing a stale
  balance while the app correctly reads the new one. Diagnosed as MetaMask's own
  UI cache rather than anything readable through its provider, so there is
  nothing to fix here; it is faucet-only and a real deployment would not hit it.
- **`Avatars.mint` has no access control**, and `_enter` accepts an obstacle as
  an entry position. Both are recorded in the contracts and in
  `docs/plans/identity-without-consent.md`.
- **An avatar may leave from ANY cell, not only from the exit tile.** `_exit`
  ignores its action data and `UnableToExitFromThisPosition` is declared and
  thrown nowhere, so `planning.exitAt` permits what the contract permits rather
  than inventing a rule only this client would believe (the pre-port build had
  exactly such a rule). The tile is still drawn as the goal, so the map and the
  contract disagree, and reconciling them is a decision about what the game is:
  either `_exit` gains the check the declared error was written for, or the tile
  stops being drawn as a goal. Recorded next to `_exit` and in `web-port.md`.
- **An Exit committed for an avatar that is NOT in the world corrupts a zone**,
  popping another player out of `_zones[startZone].avatars`. `planning.exitAt`
  refuses to plan one, so this client cannot cause it; nothing on chain stops
  another. Found while building the Exit action; recorded next to `_exit`.

## Verification, and what nobody has checked

Nothing in this repo has an automated end-to-end test against a chain, so the
things below have only ever been confirmed by hand, and two have not been
confirmed at all:

- the faucet aimed at a payment-rail wallet
- the delegation modal now that `@etherplay/connect` 0.11.2 announces the request
- **every part of the controls and the Exit action.** The recognisers, the
  intent-to-action mapping and the key guards are covered by unit tests that
  were each checked by breaking the code under them, but nothing has driven a
  real keyboard or a real gamepad at a real board, and no exit has ever been
  revealed on chain. The pixi ring drawn for a planned exit is not covered by
  anything.
- **purchase recovery across a reload.** Every rule in it is unit tested,
  including the guard, which was checked by restoring the original bug and
  watching the double purchase go through. What is unverified is its premise:
  that a rail-paid purchase actually reaches account data on a real chain. That
  is the upstream fix, merged and never run here against a node.

Local setup: port 8545 belongs to something else, so start a node elsewhere and
point `contracts/.env.local` at it. `web/src/lib/deployments.ts` is generated and
gitignored; `pnpm install` regenerates it from the committed deployment records,
so a fresh clone typechecks before it has deployed anything.
