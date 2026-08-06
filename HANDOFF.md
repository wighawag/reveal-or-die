# Handoff: making template-commit-reveal the shared commit-reveal template

Working document for whoever picks this up. Delete it when the work is done.

## The goal

Four games exist that are all commit-reveal, all written independently, and all
carrying their own copy of the same machinery. The aim is one template they can
all descend from, with the parts they disagree about expressed as seams rather
than forked code.

```
jolly-roger (main)                   generic app template
  └── variant/full                   + backend-requiring bits (hosted sign-in)
        ├── template-commit-reveal   + the commit-reveal framework  <- THIS REPO
        │     ├── reveal-or-die      avatar in a maze
        │     │     └── bomber-world reveal-or-die + bombs
        │     └── conquest-v1        empires and star systems
        └── (stratagems, eventually) board placement, deferred - see below
```

Each descendant is its own repo, tracks its parent as `upstream`, and merges
down. Contracts are NOT inherited: every game writes its own. The template's
contracts are a reference to start from.

## Where things stand

| repo                     | state                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `jolly-roger`            | done, ours merged. **1 unpushed commit that is not ours** (`c93ded2 route: accept relative paths`)                            |
| `template-commit-reveal` | **3 unpushed commits, in progress.** Contracts done and green; web not started                                                |
| `conquest-v1`            | done and pushed, descends from jolly-roger directly. **1 unpushed commit that is not ours** (`deb8127`, same change as above) |
| `reveal-or-die`          | untouched. Still on a jolly-roger from ~497 commits back                                                                      |
| `bomber-world`           | untouched. reveal-or-die + ~6 commits (bombs)                                                                                 |
| `stratagems`             | untouched, deliberately deferred                                                                                              |

The two unpushed `route:` commits appeared during this work and were not made by
the previous session. Leave them alone; ask before touching.

### template-commit-reveal, specifically

`main` was reset onto `upstream/variant/full` and has three commits. The
previous history is preserved on the `old` branch. **Nothing is pushed**, and
the eventual push is a force-push (agreed), keeping `old` as an archive.

**Git tracking is deliberately hybrid, do not "fix" it blindly.**

```
branch.main.remote     = upstream          (jolly-roger)
branch.main.merge      = refs/heads/variant/full
branch.main.pushRemote = origin            (template-commit-reveal)
```

So `git push` goes to this repo's own origin, while `git status` compares
against jolly-roger's `variant/full`. That makes `git status` say "your branch
and 'upstream/variant/full' have diverged, ahead N and behind M", which reads
like a problem and is not: **ahead** is our work, **behind** is upstream work
not yet merged down. Merge it with `git merge upstream/variant/full`.

Once the force-push to `origin/main` has happened, switching to
`git branch -u origin/main main` is the tidier end state (that is how
`conquest-v1` is set up), with upstream merged in explicitly.

```
d34ad44  contracts on jolly-roger's variant/full
29df48f  the seams, and the framework the four games agree on
095cee4  address-based, staked, shared-cell template game
```

`pnpm contracts:test` -> 5 passing. `web:check` still fails, expected: the web
layer is still jolly-roger's GreetingsRegistry demo.

## Environment gotchas

- **`pnpm` is not on PATH.** Use `~/.volta/bin/pnpm`. Bare `pnpm` fails; `corepack pnpm` also works.
- **Check ports before e2e.** A dev chain of the user's often runs on 8545. Run
  e2e with `E2E_RPC_PORT=8555` so it starts its own node instead of reusing and
  polluting theirs. `scripts/run-e2e-tests.sh` silently reuses whatever is on
  8545 otherwise. Check with `fuser 8555/tcp` first; 8080 has been in use by an
  unrelated process.
- **`vite preview` can serve a stale output dir** (every asset 404s, no CSS).
  For real browser checks serve the actual build:
  `pnpm exec ipfs-emulator --only -d build -p 8081`.

## Decisions already made (do not relitigate without reason)

1. **Contracts stay independent per game.** Not inherited. The template's are a
   reference. Conquest's are 11/17 diverged from the old template's already.
2. **Identity is a type parameter**, not a naming convention. Three real models:
   `address` (template, stratagems), `avatarID` bigint (reveal-or-die,
   bomber-world), `empireID` bigint (conquest). Stratagems keys commitments by
   `msg.sender` directly, which is why this is a seam and not a rename.
3. **The template is deliberately an address game, not an avatar game.** An
   avatar game gives you one entity to control and your identity is a thing in
   the world; an address game gives you no identity but your account and your
   action. Making the template the second kind means the first descendant port
   (reveal-or-die) has to exercise `PlayerIdentity` rather than inherit it.
4. **`OnchainStateStore` is a seam, with indexer support first-class.** Kept to
   value + status + `update()` because polling and event-replay share nothing
   else. Stratagems builds state with `ethereum-indexer-browser`; the template
   ships a camera-scoped poller as one implementation.
5. **The renderer is a seam**, parametrised by surface: pixi (reveal-or-die,
   conquest) and raw WebGL (stratagems) must both fit.
6. **Framework lives in `web/src/lib/game/core/` and `web/src/lib/game/render/`.**
   Never in `web/src/lib/core/`, which is jolly-roger's and must stay mergeable.
   The camera deliberately has no pixi import, because the state layer depends
   on it and that would force pixi on every game.
7. **Embedded play and TEVM are removed.** They will come back later using
   `embedded-eth-node`, not tevm.
8. **Stake, not implicit joining.** The template gates with a token reserve
   bonded at commit and forfeited on missed reveal. reveal-or-die gates with NFT
   custody instead. The framework only requires that _something_ is forfeited.

## Two rules that are easy to break

Both are in `AGENTS.md`. They are repeated here because the previous session got
the first one wrong twice in a single message.

- **A reveal must not branch on state another reveal in the same epoch could
  have changed.** "First reveal wins" and "reject an occupied cell" both look
  reasonable and both make the outcome depend on mempool ordering, which hands
  the game to whoever pays the most gas. Accumulate (`+=`). Stratagems does this
  correctly with `cellUpdate.delta += enemyOrFriend`.

  `contracts/test/Game.test.ts` asserts this by replaying the same commitments
  in both reveal orders. It has been verified to have teeth: reintroducing the
  reject-if-occupied rule fails that test while the other three still pass.

- **Something must be at stake or nobody has to reveal.** A player who dislikes
  what they committed to just goes quiet. This was `// TODO burn / stake ....`
  before, meaning the template shipped commit-reveal with no reason to reveal.

## What exists now

**Contracts** (`contracts/src/`), all address-keyed:

- `game/interfaces/` - `IGame` (commit/reveal/getters), types, events, errors
- `game/internal/UsingGameStore.sol` - reserve, commitments, cells
- `game/internal/UsingGameInternal.sol` - the round; `_place` is the
  order-independent accumulation, commented as such
- `game/routes/` - `GameCommit`, `GameReveal`, `GameGetters` behind a router+proxy
- `tokens/GameToken.sol` - freely mintable ERC20, template-only
- `utils/PositionUtils.sol` - zone maths (16x16 zones), pre-existing

Key surface: `addToReserve` / `withdrawFromReserve` / `makeCommitment(hash,
bond, payee)` / `reveal(player, placements, secret, payee)` /
`acknowledgeMissedReveal(player)` / `getCellsInZone(zone)`.

`reveal` takes `player` rather than using `msg.sender` so a third party can
reveal for someone who is offline. That is also the precondition for stratagems'
fuzd-scheduled reveal.

**Web framework** (`web/src/lib/game/`):

- `core/seams.ts` - all the seam types, no implementation. Read this first.
- `core/epoch.ts` - timed and manual epoch trackers. Framework, not a seam: all
  four games compute the epoch identically including the `+ 2` offset.
- `core/chain-time.ts` - chain-synced clock the timed epochs read. Ported from
  conquest where it is proven.
- `render/camera.ts` - renderer-agnostic camera.
- `web/src/lib/onchain/state.ts` - the seam re-exported plus
  `createPollingOnchainState`, the camera-scoped implementation.
- `web/src/lib/view/index.ts` - the view seam, `createViewState` taking a
  game-supplied `merge`.

## What is left

1. **The template's own web game.** Grid, click to plan placements, commit as
   the phase closes, reveal. This is what proves `OnchainStateStore`,
   `CommitRevealAdapter`, `ViewMerge` and `GameRenderer` actually fit together.
   `getCellsInZone` exists precisely so the poller is real rather than
   hypothetical. Port the pixi canvas from conquest (`web/src/lib/render/`),
   which is already debugged.
2. **Decompose `createContext`.** It still wires the GreetingsRegistry demo.
   Split into a core part (jolly-roger's) and a game part (the framework's), so
   descendants call both and add their own. The old template's monolithic
   `createGameDependenciesForRemotePlay()` in `git show refs/heads/old:web/src/lib/index.ts`
   shows what it used to do; do not reproduce its module-level singletons and
   `globalThis` assignments.
3. **Delete the remaining demo**: `routes/demo` is gone but greetings tests and
   `lib/onchain` remnants may linger. `web:check` will tell you.
4. **Port reveal-or-die.** First real test of the seams. Expect
   `CommitRevealAdapter` to need changing - see risks.
5. **Port bomber-world** onto reveal-or-die. Small: ~18 files differ, and 64 of
   81 shared web files are byte-identical.
6. **Port conquest** onto the template. Second bigint identity, different
   actions. Note this is a rewrite of working, tested code (406 unit + 11 e2e),
   so it needs the same scrutiny: the bugs found there (black map, click offset,
   scrollbar overflow) were all found by measuring in a real browser, not by
   reasoning.
7. **Reassess stratagems** once three ports are done.

## Known risks

- **The seams are unproven.** Nothing compiles against them yet. They were
  derived by reading four codebases, which is better than guessing but not the
  same as working.
- **`CommitRevealAdapter` is the one most likely to be wrong.** It assumes the
  framework owns the round and the game owns the calls. Stratagems reveals from
  a timelock-encrypted commitment via a scheduling service (fuzd), which may not
  fit. Find out during the reveal-or-die port rather than hardening around it.
- **Contract override is a permanent conflict zone.** Each game replaces the
  template's `contracts/src/`. Accepted, but expect merges to conflict there.

## Stratagems: why it is deferred

Not a variant of this stack, a different generation of it: Svelte **4** (no
runes), `web3-connection`, `ethereum-indexer-browser`, twgl.js WebGL, hardhat 2 +
rocketh 0.10, plus fuzd / tlock-js / missiv and extra `common`, `indexer` and
Cloudflare-worker workspaces. 1137 commits, 1022 files, no common ancestor with
jolly-roger.

Integrating it means a Svelte 4->5 migration, a connection-library swap, a
state-model swap, a renderer swap and a hardhat 2->3 + rocketh 0.10->0.19
migration, each about the size of the whole conquest graft. The user wants it
merged (histories preserved, no force-push) eventually.

It has already earned its keep as a design input: it is why identity is a type
parameter and why the state store is a seam. Use it to check seam decisions;
do not port it yet.
