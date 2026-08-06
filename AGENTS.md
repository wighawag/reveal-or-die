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

## Commit-reveal rules

This template exists to build simultaneous-turn games. Two rules follow from
that, and both are easy to break by accident.

- **A reveal must not branch on state another reveal in the same epoch could
  have changed.** Reveals arrive in whatever order the mempool delivers them,
  so the board after a set of commitments must not depend on that order. If it
  does, whoever pays the most gas decides the outcome, and committing bought
  nothing. Accumulate (`+=`); do not compare against another player's state.

  Rules like "the first to reveal takes the cell" or "reject a cell that is
  already taken" look reasonable and violate this. `contracts/test/Game.test.ts`
  asserts the property directly by replaying the same commitments in two
  different orders; keep that test working when you change resolution rules.

- **Something must be at stake, or nobody has to reveal.** A player who dislikes
  what they committed to can simply go quiet. The template makes this concrete
  with a token reserve bonded at commit time and forfeited by
  `acknowledgeMissedReveal`. A game may gate differently (custody of an NFT, for
  instance); what the framework needs is only that *something* is lost by not
  revealing.
