# `with/all`

This repo's single integration branch: `with/pixi-js` and `with/nft-identity`,
merged. It is D11's node, and it is where every real game built on this template
stems from, because a game needs a renderer AND an identity and the fan holds
one axis each.

```
template-commit-reveal@main          the seam, and the host that needs no install
├─ with/pixi-js                      pixi + assetpack + one sprite
├─ with/nft-identity                 identity is a token; acquisition proven
└─ with/all                          ← here: both, and nothing else
   └─ reveal-or-die                  stemBranch points here
```

## It carries no code of its own, and that is the acceptance criterion

An integration branch exists to prove the fan COMPOSES. The moment it holds a
line that is on neither parent, it has stopped being an integration of them and
become a third place to maintain something, which is the lattice Decision 4 of
the plan exists to prevent. So the rule for this branch is sharper than N1's
budget: **its diff against the union of its parents is empty.**

Measured rather than asserted, on creation (2026-09-11), with
`check-shared-divergence.sh` run three ways:

| run | what it proves | result |
| --- | --- | --- |
| `BASE=with/pixi-js` | everything the identity axis changes arrived | exactly `with/nft-identity`'s **12** |
| `BASE=with/nft-identity` | everything the renderer axis changes arrived | exactly `with/pixi-js`'s **1** |
| `BASE=main` | nothing else changed at all | exactly the **13**, which is the union |

All three with `ALLOWED=` empty, which is the run that proves the other 536 of
549 shared files are clean because they are IDENTICAL rather than because the
script matched nothing.

**The merge itself was clean in every file**, which was the prediction and is
worth recording as a number: **0 conflicts**, against the `with/hosted-account`
shape of 3 conflict events in 24 merges that Decision 3 sets as the bar. The two
axes turn out to be disjoint at file granularity - the renderer touches
`placement/render/`, `vite.plugins.ts` and the two dependency files; the identity
touches the contracts, the identity seam and what is at stake - and the one file
either might have fought over, `web/package.json`, is edited by only one of them.

Do not read the zero as luck. It is what the two branches were shaped for: N1's
"the branch ADDS files" and N2's "shared files change by ONE LINE" are exactly
the properties that make two branches mergeable without a human, and this is the
first thing in the tree that tests them TOGETHER rather than each against `main`.

## The shared-file budget is the union, and it is not re-litigated here

Thirteen files, and every one of them is on a parent's list with a reason there.
Read `README.pixi-js.md` and `README.nft-identity.md` for the arguments; this
table exists so the `ALLOWED` list below has a home.

| from | count | files |
| --- | --- | --- |
| `with/pixi-js` | 1 | `placement/render/index.ts` |
| `with/nft-identity` | 12 | `game/identity.ts`, `placement/{stake,reserve,acquisition,config}.ts`, `context/game.ts`, four `test/lib/placement/*.test.ts`, two `e2e/` files |

The dependency files (`web/package.json`, `pnpm-lock.yaml`) are not counted, on
both parents' own reasoning: they are what any branch adding a dependency must
touch, and they are generated or append-only.

## Cascade ritual

`main` reaches here through its two parents, never directly. `offshoot-fanout`
knows that - `with/all` is configured with `stem: ["with/pixi-js",
"with/nft-identity"]` and is reported as an integration node - so the ordinary
run is just the fanout. By hand it is two merges, in either order:

```sh
git merge with/pixi-js
git merge with/nft-identity
pnpm --filter ./web check
pnpm --filter ./web run test:unit
```

Then the three divergence runs, which are the thing that makes this node worth
having. The first is the ritual; the other two are what a plain
`BASE=main` run cannot tell you, because a merge that silently dropped one
parent's change looks identical to one that carried it:

```sh
PIXI="web/src/lib/placement/render/index.ts"
NFT="web/src/lib/game/identity.ts web/src/lib/placement/stake.ts \
web/src/lib/placement/reserve.ts web/src/lib/placement/acquisition.ts \
web/src/lib/context/game.ts web/src/lib/placement/config.ts \
web/test/lib/placement/commit-reveal.test.ts web/test/lib/placement/missed-reveal.test.ts \
web/test/lib/placement/acquisition.test.ts web/test/lib/placement/reserve.test.ts \
web/e2e/fixtures/game.ts web/e2e/tests/game.e2e.ts"

check() { BASE="$1" FEATURES=with/all EXT="ts svelte" WATCH="web/src web/test web/e2e" \
  ALLOWED="$2" bash <(git show tooling:check-shared-divergence.sh); }

check main             "$PIXI $NFT"   # the union: thirteen, and nothing else
check with/pixi-js     "$NFT"         # exactly what the identity axis contributes
check with/nft-identity "$PIXI"       # exactly what the renderer axis contributes
```

**EACH RUN TAKES ITS OWN LIST, and passing the union to all three is wrong in a
way the script now says out loud.** `ALLOWED` is a two-sided contract: everything
off it must be identical, and everything ON it must DIFFER. Against
`with/pixi-js`, the renderer selector is identical - that is the whole point,
since this branch inherits it - so listing it there is a claim that is false, and
the run fails with `ALLOWED BUT IDENTICAL`. Measured when the two-sided check
landed: the earlier version of this README prescribed the union for all three and
the second run failed on exactly that entry.

That is the check earning its keep rather than an inconvenience. Green on run two
now means "`with/all` differs from `with/pixi-js` in exactly the identity axis's
twelve files, ALL of them" - which is the claim this README makes - where before
it only meant "nothing unexpected differs".

Run the `BASE=main` one once more with `ALLOWED=` empty. That is the run that
checks the checker, and on this branch it should name exactly thirteen files and
no others. (That run also means what it says now: `ALLOWED=` used to fall back to
the script's default rather than allowing nothing.) `tooling` is a local orphan
branch adopted verbatim from jolly-roger's and deliberately not pushed;
`README.pixi-js.md` explains why and how to rebuild it.

**What none of it will tell you is a DELETION**, which is the shape that has
already bitten this tree once: a file removed on one side and still imported on
the other leaves nothing to diff. `verify` is what catches that, and on this
node it is the only thing that does.

## e2e

`verify` is deliberately not an e2e gate (too slow to be a gate), so its one
blind spot is a browser. Run it by hand for this node:

```sh
cd web && CI=1 E2E_RPC_PORT=8638 E2E_PORT=4638 pnpm test:e2e
```

**51 of 51, with ONE RETRY, 18.1 minutes at load average 8.0 to 10.0**
(2026-09-11). The retried test is the round test, failing with `Idle` where it
wanted `Revealed` after 120 seconds, which is the exact family the plan's load
finding names; it passed on the retry and the other 50 passed first time.

**Reported as "one retry" rather than "51 passed" deliberately.** The plan's own
note says the retry `CI=1` enables is doing real work and must not be read as
the suite being clean, and this run is also a small correction to it: that note
records the documented failures as being at load 20 and above, and this one is
at 8 to 10.

That is the whole point of running it here. The same 51 tests that click a real
board, miss a reveal, run out of gas and recover a lost round pass against a
game that is BOTH pixi-rendered and token-keyed, which is the only evidence
available that the two axes compose in a browser rather than merely in a type
checker.
