# setup

`pnpm i`

# frontend

in ./web
for typescript checks: `pnpm check`
for tests: `pnpm test`

## Svelte conventions

- **`.svelte` files must be logic-less or logic-minimal.** They should only
  render UI and wire props/stores together. Small presentational conveniences
  are fine (a display formatter, a class toggle, a UI-only animation, local
  open/closed modal state). Anything else, business/domain logic, async
  blockchain calls, transaction building, balance checks, data
  fetching/derivation, non-trivial computation, filtering/sorting/aggregating
  domain data, network error handling, belongs in a plain `.ts` module (a
  helper, a store, or a service) that the component imports.

- **Never create `.svelte.ts` files.** Do not use Svelte runes
  (`$state`, `$derived`, `$effect`, ...) outside of `.svelte` components. Put
  reusable logic in plain `.ts` files and expose reactivity with Svelte stores
  (`writable`/`readable`/`derived` from `svelte/store`). Components consume
  those stores with the `$store` syntax and own any `$effect`/lifecycle wiring
  themselves.

- Logic lives in `.ts`, reactivity crosses the boundary as stores. Prefer
  factory functions that return `{subscribe, ...actions}` (see the existing
  stores under `src/lib/**` and `src/routes/**/lib/stores/`).

## The framework boundary

- **Only `web/src/lib/kit` may import `$app/*`.** Everything under `web/src/lib/core` takes what it needs from the framework as a parameter (`PathResolver`, `ServiceWorkerEnvironment`), and `web/src/routes/**` is exempt because routes are the framework's own surface. `web/test/framework-boundary.test.ts` enforces this and `web/src/lib/kit/README.md` states the scope, including what the rule deliberately does not cover.

- **`web/src/lib/index.ts` is where the app is composed**, which is why it may import both `./kit/*` and the environment. Anything that composes THIS app belongs there rather than in `core/`.

- The two boundary tests and this section are INHERITED from `template-svelte`, the root of this template tree, where they are also enforced. A change to either that is meaningful for a sibling belongs there rather than here, or every sibling silently misses it.

## Commit-reveal rules

This template exists to build simultaneous-turn games. Two rules follow from
that, and both are easy to break by accident.

- **A reveal must not branch on state another reveal in the same epoch could
  have changed.** Reveals arrive in whatever order the mempool delivers them,
  so the board after a set of commitments must not depend on that order. If it
  does, whoever pays the most gas decides the outcome, and committing bought
  nothing. Accumulate (`+=`); do not compare against another player's state.

  Rules like "the first to reveal takes the cell" or "reject a cell that is
  already taken" look reasonable and violate this.
  `contracts/test/js/Game.test.ts` asserts the property directly by replaying the same commitments in two
  different orders; keep that test working when you change resolution rules.

  The test is whether the ORDER can change what a player GETS, not whether
  shared state is read at all. There is exactly one place here that reads it on
  purpose: `_place` checks whether a cell has ever been claimed so it can add it
  to a per-zone index once, and the indexed set, every stake and every player's
  position come out identical either way (only the array order and which reveal
  pays for the append differ). That argument is written next to the code and
  pinned by a test that compares the zone listing as a SET in both orders. If
  you need the same exemption, do both of those things; if you cannot make the
  argument, you are looking at the rule, not at an exception to it.

- **Something must be at stake, or nobody has to reveal.** A player who dislikes
  what they committed to can simply go quiet. The template makes this concrete
  with a token reserve bonded at commit time and forfeited by
  `acknowledgeMissedReveal`. A game may gate differently (custody of an NFT, for
  instance); what the framework needs is only that _something_ is lost by not
  revealing.

## Where the plan and the handoff live: the `work` branch

**They are not in this working tree, so `ls` and `find` will not show them.** Every repo in this tree keeps its maintainer material on an orphan branch called `work`, which has no merge base with anything and therefore never cascades into a descendant. Nothing checks it out. Start by asking what this repo's branch holds, rather than assuming a path:

```bash
git ls-tree -r --name-only work        # what THIS repo keeps there
git show work:<path>                   # read one
git worktree add ../<repo>-work work   # or check it out beside the repo
```

**The plan for the whole template tree lives on `template-commit-reveal`'s `work` branch**, at `work/specs/proposed/games-on-this-foundation.md`. It is the source of truth for intent: the phase order, the decisions with their reasoning, the measured baselines for the template and its descendants, and what each phase deliberately does NOT do. A game built from this template does not carry a copy, by design, so read it there. Alongside it are `HANDOFF.md` (repo state and environment gotchas) and `work/tasks/` (staged work items).

If reality contradicts the plan, change the document in the same commit as the code that proved it wrong, and say which claim was wrong.

The README's ADR section points at `work:docs/adr/`. That is **jolly-roger's** branch layout, and a repo further down this tree may hold nothing at that path; the listing command above is the reliable route. The README is byte-identical to the stem's in this repo and is deliberately left that way.

Two environment facts worth having before the first command, because both have cost real time: **`pnpm` is not on PATH** (use `~/.volta/bin/pnpm`), and **`web/src/lib/deployments.ts` is generated and gitignored**, so a `check` failure inside `$lib/core` that the stem does not have means regenerate it before touching anything shared. The rest are in the handoff.
