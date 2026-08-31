# Handoff: where reveal-or-die is, and how to work on it

Written at `37bcceb`, on `port/template-commit-reveal`. Read this before
`web-port.md`, which is the detailed record; this is the orientation.

## State

The web port is done. The game is playable end to end: sign in, buy an avatar,
spawn, move, and the round commits and reveals by itself.

| | |
| --- | --- |
| branch | `port/template-commit-reveal`. **Never work on `main`**, which is the pre-port app and 50+ commits behind |
| `cd web && pnpm check` | 0 errors |
| `cd web && pnpm test:unit` | 1250 + 46, all passing, about 25 seconds |
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
line, `lib/world/ui/`, `contracts/`, and `routes/play`.

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

1. **Controls, and the Exit action.** Keyboard, gamepad and an on-screen D-pad
   went with the pre-port renderer. `planning.ts` can name an Exit but has no
   `exitAt`, so the one goal on the board is drawn and unreachable. These are
   one piece of work. `docs/audits/03-renderer.md` 3.4 wants the input layer
   rebuilt as intent recognisers in the shape `game/render/gestures.ts` uses,
   and lists four defects in the old implementation not to carry over.
2. **A purchase should survive a reload.** Blocked on the payment rail's
   transactions being tracked, which is reported upstream and not yet fixed. Do
   NOT solve it by persisting state here; the operations ledger exists to hold
   exactly this, and the reason a purchase is invisible to it is the upstream
   defect.
3. **The red "you cannot move" border**, which wants restyling to match shadcn.
4. **The home page**, which still shows the template's copy rather than this
   game's.

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

## Verification, and what nobody has checked

Nothing in this repo has an automated end-to-end test against a chain, so the
things below have only ever been confirmed by hand, and two have not been
confirmed at all:

- the faucet aimed at a payment-rail wallet
- the delegation modal now that `@etherplay/connect` 0.11.2 announces the request

Local setup: port 8545 belongs to something else, so start a node elsewhere and
point `contracts/.env.local` at it. `web/src/lib/deployments.ts` is generated and
gitignored; `pnpm install` regenerates it from the committed deployment records,
so a fresh clone typechecks before it has deployed anything.
