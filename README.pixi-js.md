# `with/pixi-js`

The pixi host, this game's pixi board, and the sprite pipeline. Everything that
needs a rendering library installed, and nothing else.

`main` carries the render SEAM and the host that needs no install (the immediate
renderer on a canvas-2d surface). This branch carries the LIBRARY and its build.
The choice of renderer was already a seam and stays one; what earns a branch is
the 79M install, which is the largest single one in the tree and the cost a
non-adopter would otherwise pay. See D11 in
`work:work/specs/proposed/games-on-this-foundation.md`.

## The shared-file edit list

This is rule **N1**'s budget, and the number this branch is judged on. Every
file here also exists on `main`, so every one of them is a place a future
cascade can conflict. Growing the list needs a reason.

| file | what the branch changes | kind |
| --- | --- | --- |
| `web/src/lib/placement/render/index.ts` | selects the pixi host instead of the canvas-2d one | **the point of the branch** |
| `web/vite.config.ts` | an import, and `assetpackPlugin()` in `plugins` | dependency wiring |
| `web/package.json` | `pixi.js`, `@assetpack/core` | dependency |
| `pnpm-lock.yaml` | generated | dependency |

**Two of those are real and two are bookkeeping.** The lockfile and
`package.json` are what any branch that adds a dependency must touch; both are
generated or append-only, and they merge without a human. The ones that can
actually go wrong are the other two.

It was five until the pipeline's `.gitignore` entries moved to `main`. They
belong there anyway - a checkout that has been on this branch leaves generated
files behind, and on a base that did not ignore them `format:check` went red on
a generated manifest - so the base pays four lines about a build it does not
have, and this branch stops holding a difference in a file every descendant
edits.

- **`placement/render/index.ts` is the intended difference** and is close to
  free: it is this repo's own file, nothing upstream develops it, and it is the
  one file the template already documented as "the one file to edit to change
  the renderer". This is the `mode.ts`/`TARGET_STEP` shape from N2 applied to a
  different axis.
- **`web/vite.config.ts` is the one that will hurt**, and it is a known,
  recorded problem rather than a surprise. That file is **byte-identical to
  jolly-roger's** on `main`, so it is developed two repos up, and reveal-or-die
  restructured it wholesale downstream. The pipeline is a vite plugin, so it has
  to be wired in somewhere.

  The branch's edit is kept to two lines on purpose: `assetpackPlugin()` returns
  `false` when there is no art and under vitest, and vite filters falsy plugins,
  so the caller has no condition in it. Both copies this was reconciled from put
  the `existsSync` check in `vite.config.ts` and paid four lines for it.

  **The structural fix is jolly-roger's, not this branch's** - a config that can
  be extended by adding a file rather than by editing it. Written up in
  `work:work/notes/observations/the-vite-config-is-the-asset-pipelines-conflict-site.md`,
  with the trigger: the second branch that needs a vite plugin.

### What is NOT on the list, and why that took work

- **`web/src/routes/play/+page.svelte`.** It mounts whichever host the selector
  names and passes `cellSize` and `gridCells`, which only a scene-graph host
  uses. The canvas-2d host on `main` accepts and ignores them, which is what
  keeps this route byte-identical on both nodes. `web/test/render-host-boundary.test.ts`
  fails if the page passes a prop the selected host does not declare, and it
  binds to whichever host is selected, so it protects the invariant from BOTH
  sides.
- **`web/src/lib/game/render/README.md`.** It describes both nodes, deliberately,
  and lives on `main`.
- **The loading gate.** reveal-or-die's splash covers the whole application,
  which would mean editing a layout or a route. This one is rendered by
  `PixiCanvas.svelte`, a file only this branch has, so it costs nothing. It also
  covers the region that is actually unpainted.
- **`stateful.ts` and `reconcile.ts`.** They import no rendering library and stay
  on `main`, where a three.js or twgl host finds them. Shared machinery
  exercised by a feature branch rather than by the base is the normal shape of a
  fan.

## What is on the branch

```
web/vite.assetpack.ts                            the pipeline
web/src/lib/game/render/pixi/PixiCanvas.svelte   the host
web/src/lib/game/render/pixi/world.ts            camera -> pixi container
web/src/lib/game/render/pixi/assets.ts           bundle loading + progress
web/src/lib/game/render/pixi/LoadingGate.svelte  progress -> something on screen
web/src/lib/placement/render/board-renderer.ts   this game's board, diffed
web/src/lib/placement/render/CellObject.ts       one cell, drawn with the sprite
web/test/vite-assetpack.test.ts                  the workaround that earned the node
assets/sprites/cell.png                          one sprite
```

**The sprite has a consumer on purpose.** A pipeline whose output nothing draws
would type-check, build, emit a manifest and prove nothing, which is precisely
the unexercised code D11 exists to remove. `CellObject` draws the tile for a
claimed cell and falls back to vector graphics when there is no sheet, so both
paths are reachable in an ordinary checkout and a clone without `../assets`
still builds and plays.

## The pipeline is a MOVE, and its second half is not done yet

`vite.assetpack.ts` is the reconciliation of two independently authored copies -
`reveal-or-die/web/vite.assetpack.ts` (139 lines) and
`conquest-v1/web/vite-assetpack.ts` (117) - which is what earned this node: two
people wrote it twice and reached the same two workarounds.

**Neither descendant's copy is deleted yet, and that is tracked rather than
forgotten.** Deleting them is only safe once they INHERIT this branch, and
neither does: reveal-or-die stems from `main` until its `stemBranch` moves to
`with/all`, and conquest stems from jolly-roger directly. The exact deletion
list and the trigger are in
`work:work/notes/observations/the-asset-pipeline-move-cannot-complete-until-the-repoint.md`.

## Cascade ritual

```sh
git merge main
pnpm --filter ./web check
pnpm --filter ./web run test:unit
BASE=main FEATURES=with/pixi-js \
  WATCH="web/src/lib/game/render web/src/lib/placement/render" \
  ALLOWED="web/src/lib/placement/render/index.ts" \
  bash <(git show tooling:check-shared-divergence.sh)
```

`tooling` is a LOCAL orphan branch here, adopted verbatim from jolly-roger's
(N6), so the command needs no sibling checkout on disk. It shares history with
nothing and is not in `fanout.config.json`, so it can never arrive through a
merge or be cascaded into.

**It is deliberately NOT pushed to this repo's origin**, which is the whole
point rather than an oversight. jolly-roger's copy is the only canonical one; a
pushed copy here would be a second place it can drift, which is exactly the
failure the script exists to catch, one level up. It is a cache, and it is
rebuilt in one command:

```sh
git fetch stem tooling && git branch -f tooling stem/tooling
```

Run that on a fresh clone, and again whenever jolly-roger's moves. **Do not edit
it here.** If the script needs changing, change it on jolly-roger's `tooling`
branch and re-fetch, or the next person to re-fetch silently loses the fix.

The `ALLOWED` entry is the renderer selector, and it is the exact analogue of
`mode.ts` upstream: the one file that is SUPPOSED to differ, because it is the
switch this branch exists to flip. Anything else drifting under those paths is
the failure the script is for - a cascade whose conflicts were all resolved
correctly and which still left a shared file holding two versions of the same
logic.

**Two things it will not tell you**, both measured on its first real run here:

- It compares `.ts` only, by design upstream. The shared file this branch most
  depends on staying identical is `routes/play/+page.svelte`, which it never
  looks at. That one is covered by `render-host-boundary.test.ts` instead.
- It cannot see a DELETION, because it compares files two branches share. That
  is the shape that makes `main` currently unmergeable into reveal-or-die: the
  pixi host was deleted upstream and is still imported there, and the merge
  reports success on that hunk.
