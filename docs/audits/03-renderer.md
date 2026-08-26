<!--
  Point-in-time audit, 2026-08-26, taken BEFORE the port began.
  Kept because its findings are still open: the backport candidates for
  template-commit-reveal, and the renderer risks. Line numbers refer to the
  tree as it was on `main`, not to the port branch, so treat them as
  pointers rather than coordinates.
-->

# ROD renderer to TCR render layer: adoption map, backport candidates, risks

Read-only investigation. Nothing in either repo was modified.

Repos: ROD = `/home/wighawag/dev/github/wighawag/reveal-or-die`, TCR = `/home/wighawag/dev/github/wighawag/template-commit-reveal`. Paths below are relative to `web/src/lib/` in the respective repo unless written out in full.

## 0. The seam, stated up front

TCR's README does define exactly how a game plugs its own drawing in, and it is not a vague "write a renderer": it is a typed seam plus two supplied fillings plus one file to edit.

- The seam is `GameRenderer<TSurface>` in `game/core/seams.ts:238-252`: `onAppStarted(surface)`, `onAppStopped()`, `tick(frame)`. `TSurface` is opaque to the framework.
- `Frame` (`game/core/seams.ts:206-236`) carries `time`, `delta`, `transform`, `screen`, `devicePixelRatio`.
- Three styles, named in `game/render/README.md:19-27`: reactive (Svelte, not a `GameRenderer`), immediate (`game/render/immediate.ts`), stateful (`game/render/stateful.ts`).
- The single switch point is `placement/render/index.ts` (`README.md:29`, and the file's own header at lines 1-46). It names three things: `GameSurface` (line 61), `loadCanvasComponent()` (line 64), `createGameRenderer()` (lines 66-71).
- What a host owes the framework is enumerated in `README.md:112-119`: report size, feed gestures, call `renderer.tick(frame)` built with `createFrameLoop`, apply the transform.

So the ROD adoption target is unambiguous: **ROD becomes a stateful renderer** (`createStatefulRenderer`) over `Container`, mounted by TCR's `game/render/pixi/PixiCanvas.svelte`, wired in a ROD-specific `render/index.ts` in the shape of `placement/render/index.ts`.

TCR's ADRs on the `work` orphan branch: `0004-view-and-system-overlays.md` is about overlays and navigation, not canvas rendering, and does not constrain this work. `0005-core-is-what-does-not-know-this-app.md` and `0006-configuration-is-constructed-once-not-read-everywhere.md` do constrain where any backport may live (see section 3, "where backports must land"). No ADR covers rendering directly; `game/render/README.md` is the authority.

---

## 1. Capability matrix

Verdict vocabulary: **TCR-better** (TCR already does this, and better), **TCR-different** (covered, but with a different shape so ROD must adapt), **TCR-missing** (genuinely absent).

| ROD capability | ROD source | TCR equivalent | Verdict |
| --- | --- | --- | --- |
| **Sprite pooling** (per-tile-type free lists, `returnAll`, `clear`) | `render/SpritePool.ts:4-99` | none. `game/render/reconcile.ts:118-170` creates and destroys objects with no recycling | **TCR-missing** (3.1) |
| **Tile spritesheet / texture lookup** | `render/TileSpritesheet.ts:11-51` | none. TCR loads no assets at all; no `Assets.load` anywhere in TCR `web/src` | **TCR-missing**, but ROD-specific content. The generic half is the asset-ready gate (3.2) |
| **Wall rendering** | `render/WallRenderer.ts` is **types only, imported by nothing** (`grep -rn WallRenderer web/src` matches only its own line 22) | n/a | Dead code in ROD. Delete, do not port |
| **Terrain layer driven by the camera** (visible-bounds rescan, margin 20) | `render/renderer.ts:113-127`, `175-220`, subscribed at `227-229` | `game/render/view-transform.ts:186-201` (`visibleCells`) is the same arithmetic with a `margin` parameter; `stateful.ts:78-80` `tick({frame, surface})` is where to drive it | **TCR-different**: arithmetic exists and is pure/tested; the pattern of a camera-driven background layer inside a stateful renderer is undocumented (3.3) |
| **Camera: pan / pinch / wheel** | delegated to pixi-viewport, `core/render/PixiCanvas.svelte:140-146` | `game/render/gestures.ts` (421 lines, node-testable recogniser + thin DOM half), `game/render/camera.ts:155-172` | **TCR-better** |
| **Camera: zoom clamp** | `clampZoom({minWidth: 5*cellSize, ... maxWidth: 50*cellSize})`, `PixiCanvas.svelte:140-146` | `ZoomLimits` in world units, `view-transform.ts:33-44`; `scaleLimits` 107-134; `clampScale` 136-143 | **TCR-better**: same phrasing, minus the `* cellSize`, and it re-clamps on resize (`camera.ts:150-158`), which ROD does not |
| **Camera: initial fit** | `viewport.fit(true, 20*cellSize, 20*cellSize)`, `PixiCanvas.svelte:147` | `CameraConfig.initialVisible` + deferred first fit, `camera.ts:99-158` | **TCR-better**: TCR waits for the first non-zero size (`needsInitialFit`, lines 108-117); ROD fits on the first layout pass whatever it reports |
| **Camera: follow a point** | `core/render/camera.ts:36-40`, silently a no-op if `viewport` is undefined; hardcodes `* 10` | `camera.ts:174-176`, works with no surface mounted | **TCR-better**. Called once in ROD, `operations/index.ts:154` |
| **Camera: `move(dx, dy)`** | `core/render/camera.ts:41-45` — **dead and buggy**: `($camera.y + y \|\| 0)` is a precedence bug, and no caller exists | `camera.ts:179-185` | **TCR-better**; drop ROD's |
| **Camera: report screen size** | `viewport.resize()` with **no arguments**, `PixiCanvas.svelte:87-90` | `input.ts:57-64` uses `element.clientWidth/clientHeight` through a `ResizeObserver` | **TCR-better**, and `camera.ts:66-77` names ROD's bug as the reason it was rewritten |
| **Click / tap to game** | `PixiCanvas.svelte:55-64` plus a drag-detection hack at `66-85` (`setTimeout(..., 10)` to suppress a click after a drag) | `gestures.ts` click threshold (lines 62-70, 254-262), `events.ts`, `input.ts:38-51` | **TCR-better** |
| **Click coordinate convention** | ROD emits **snapped integer cell coords**: `Math.round(pos.x / cellSize)`, `PixiCanvas.svelte:60-61` | TCR emits **fractional world units**; snapping is the game's rule (`events.ts:11-21`, `input.ts:40-48`, README line 108) | **TCR-different**: ROD must move the `Math.round` into `operations/index.ts`'s `clicked` handler (lines 209-224 assume integers) |
| **Keyboard input** (arrows + WASD + space/enter/backspace) | `render/keyboard-controller.ts:19-118` | **nothing**. No `keydown` anywhere in TCR `web/src` | **TCR-missing** (3.4) |
| **Gamepad input** (rAF poll, edge-triggered, axes + dpad) | `render/gamepads.ts:18-140` | **nothing**. No `getGamepads` in TCR | **TCR-missing** (3.4) |
| **Loading placeholders** (async texture/SVG/bitmap-font swap-in) | `core/render/elements/LoadingSprite.ts`, `LoadingSVG.ts`, `LoadingBtimapText.ts` | none | **TCR-missing** (3.5). Only `LoadingSprite` is actually used (`objects/AvatarObject.ts:38`) |
| **Splash screen + asset load progress** | `core/ui/loading/splash.ts` (155 lines), `SplashScreen.svelte` (146 lines) | none | **TCR-missing** as a capability; ROD's implementation is not backportable as-is (3.6) |
| **Grid** | built at `PixiCanvas.svelte:150-165` and **never added to the stage** (line 167 is `// viewport.addChild(gridPixel)`); `GameScreen.svelte:47` passes `showGrid={false}` | `game/render/grid.ts` (pure geometry, shared by both hosts, pinned by `web/test/lib/game/render/grid.test.ts`) plus `pixi/world.ts:41-75` | **TCR-better**; ROD's grid is dead code |
| **Grid fades with zoom** | `PixiCanvas.svelte:200`, `gridPixel.alpha = viewport.scaled / 48` | TCR pins `gridPixel.alpha = 0.15` (`pixi/PixiCanvas.svelte:101`) | **TCR-missing**, small (3.7). `seams.ts:220` names "a grid that fades out as you zoom away" as a reason `Frame` carries scale, so the intent is documented and unbuilt |
| **Frame loop / tick** | `app.ticker.add` inline, `PixiCanvas.svelte:176-205`; `renderer.tick()` takes **no arguments** (`render/renderer.ts:391-398`) | `frame-loop.ts` plus `Frame`; `stateful.ts:145-148` | **TCR-different**: ROD's per-object `tick()` gains a `Frame` and must be routed through one `tick({frame, surface})` |
| **Entity add/update/remove diffing** | hand-written, `render/renderer.ts:265-320`, keyed on a `processed` Set | `reconcile.ts` plus `stateful.ts` | **TCR-better**: ROD's loop has exactly the failure `reconcile.ts:129-140` documents. It never clears on a reset, and ROD's `ViewState` has no `Unloaded` step at all |
| **Epoch-boundary signal** | ad-hoc `world.epochSeen` state machine with a 2s `setTimeout`, `render/renderer.ts:43`, `223`, `232-266` — **written and never read anywhere** | `stateful.ts:onEpochChanged` (lines 57-68), called before the new epoch's entities are applied | **TCR-better**; ROD's version is dead state |
| **Per-object per-frame tick** | `render/renderer.ts:391-398` iterates `gameObjects` | `stateful.ts` `tick` gets `{frame, surface}`, but the reconciler exposes only `get(key)` and `size` (`reconcile.ts:96-110`) — **no iteration over live objects** | **TCR-missing**, sharp edge (3.8) |
| **Depth sorting by y** | `render/renderer.ts:214-218`, `295-298`, `zIndex = 10 * y` | none | ROD-specific; works unchanged on TCR's `world` container (pixi v8 auto-enables `sortableChildren` from a non-zero `zIndex`: `pixi.js/lib/scene/container/container-mixins/sortMixin.mjs:9-22`). One caveat in 4.6 |
| **pixi devtools hook** | `PixiCanvas.svelte:2`, `96-100` (`initDevtools`, `globalThis.__PIXI_APP__`) | none | **TCR-missing**, trivial (3.9) |
| **Wait for assets before starting the renderer** | `Assets.loadBundle('default').then(() => renderer.onAppStarted(viewport))`, `PixiCanvas.svelte:128-134` | TCR calls `onAppStarted(world)` immediately (`pixi/PixiCanvas.svelte:99-100`) | **TCR-missing**, and it blocks ROD's adoption (3.2, 4.1) |
| **pixi-viewport** (`^6.0.3`) | `core/render/camera.ts:1`, `core/render/renderer.ts:1`, `PixiCanvas.svelte:3` | deliberately absent; rationale at `game/render/README.md:82-88` and `routes/play/+page.svelte:27-37` | **Deliberately avoided, correctly** (3.10) |

---

## 2. Adoption map, file by file

| ROD file | What replaces it in TCR | ROD-specific residue, and where it goes |
| --- | --- | --- |
| `core/render/renderer.ts` (7 lines) | **Deleted.** `GameRenderer<Container>` from `$lib/game/core/seams` | none. ROD's `Renderer` type hardcodes `Viewport`; TCR's is parameterised on the surface |
| `core/render/camera.ts` (62 lines) | **Deleted.** `game/render/camera.ts` | `createCamera()` with no args becomes `createCamera({initialVisible: {width: 20, height: 20}, limits: {minWidth: 5, minHeight: 5, maxWidth: 50, maxHeight: 50}})`, transcribed from `PixiCanvas.svelte:46-49` and `147`. The `* cellSize` disappears: TCR limits are in game units |
| `core/render/PixiCanvas.svelte` (242 lines) | **Deleted.** `game/render/pixi/PixiCanvas.svelte` (172 lines) | Three things do not survive and must be re-expressed: the asset gate (4.1), the devtools hook (3.9), the zoom-dependent grid alpha (3.7). The drag/click hack (55-85) and the `viewport.resize()` bug (89) are simply deleted |
| `render/eventEmitter.ts` (14 lines) | **Split.** `clicked` is `game/render/events.ts:createCanvasEventEmitter`; `up/down/left/right/action/action-2/backspace` are ROD's own | The module-level singleton must become context-owned. TCR builds it at `context/game.ts:295` and passes it through `Render` (`context/game.ts:135-149`). ROD's `GameScreen.svelte:6,64-79` imports the singleton directly and must take it from context |
| `render/renderer.ts` (411 lines) | **Split three ways.** Entity diff (265-320) becomes `createStatefulRenderer`'s `entities`/`changed`/`add`/`update`/`remove`. `tick` (391-398) becomes `tick({frame, surface})`. `onAppStarted`/`onAppStopped` become `onStarted`/`onStopped` | Tile layer (85-146, 160-220) becomes a second, hand-written layer driven from `tick` with `visibleCells` (3.3). `world.epochSeen` (232-266) is deleted in favour of `onEpochChanged`. `operations.startListening()` (154) and the keyboard/gamepad start/stop (152-153, 383-385) must move **out of the renderer** into ROD's equivalent of `context/game.ts:start()` (TCR: `context/game.ts:431-489`) |
| `render/SpritePool.ts` (100 lines) | **Kept in ROD as-is**, called from the tile layer | Nothing in TCR replaces it. If 3.1 is taken, the free-list mechanics move to TCR and ROD keeps only the four `TileType` factory branches (lines 32-49) |
| `render/TileSpritesheet.ts` (51 lines) | **Kept in ROD.** Pure ROD content (`Floor-0.png`, `Wall_2_Single.png`, `exit_0NN.png`) | The `Assets.loadBundle('default')` call (line 18) moves to the preload step (4.1) |
| `render/WallRenderer.ts` (27 lines) | **Deleted** (unused type declarations) | none |
| `render/gamepads.ts` (141 lines) | **Kept in ROD** unless the 3.4 backport is taken | If backported: the `navigator`/rAF half moves to TCR, the ROD button-to-intent mapping stays |
| `render/keyboard-controller.ts` (119 lines) | Same as gamepads | Same |
| `render/objects/GameObject.ts` (15 lines) | **Kept.** TCR's `TObject` type parameter (`stateful.ts:44-56`) is unconstrained, so an abstract base class is fine | `tick?()` should gain the `Frame` |
| `render/objects/AvatarObject.ts` (185 lines) | **Kept.** The ROD analogue of `placement/render/CellObject.ts` | Three couplings need re-expression: 4.3, 4.4, 4.5 |
| `core/render/elements/LoadingSprite.ts` | **Kept in ROD** unless 3.5 is taken | Used only by `AvatarObject.ts:38` |
| `core/render/elements/LoadingSVG.ts`, `LoadingBtimapText.ts` | **Unused today.** Delete, or move with 3.5 | no importer outside `elements/` |
| `core/ui/loading/splash.ts`, `SplashScreen.svelte` | **Kept in ROD**; TCR has no equivalent | Must be reshaped to satisfy ADR-0002/0006 before any backport (3.6) |
| `screens/GameScreen.svelte` | Becomes TCR's `routes/play/+page.svelte` shape: `browser ? loadCanvasComponent() : undefined`, `{#await}` with a `:catch`, props `cameraControl/renderer/eventEmitter/cellSize/gridCells` | The on-screen D-pad (64-79) stays, but must emit into the context-owned emitter |
| `screens/GameScreenLoader.svelte` | Overlaps TCR's dynamic-import-and-await in `routes/play/+page.svelte:41,79-96` | Its `Please wait...` placeholder is where the asset preload gate belongs (4.1) |
| `lib/index.ts:110,191-201` | Becomes ROD's `context/game.ts`, mirroring TCR's `context/game.ts:294-295,385-388,511` | `createRenderer` currently takes ten dependencies including `epochInfo`, `localState`, `avatars`, `enterFlow`, `deployments`. TCR's `createGameRenderer` takes **two** (`viewState`, `cellSize`). Everything beyond view state and camera is game logic that TCR's shape puts in the context, not the renderer (4.2) |

New ROD file required: `render/index.ts` in the shape of `placement/render/index.ts` — `export type GameSurface = Container`, `loadCanvasComponent`, `createGameRenderer`.

---

## 3. Backport candidates

Sibling test applied throughout: **generic to any commit-reveal game with a board = TCR; specific to ROD's avatars/walls/tiles = ROD.**

### Where backports must land

ADR-0005 (`core/` is what does not know this app) plus the render README's own layering constrain placement:

- library-agnostic logic (input recognisers, pooling policy) goes in `game/render/*.ts`
- pixi-specific helpers (`LoadingSprite`, a texture pool) go in `game/render/pixi/*`
- anything touching `getAppContext()` goes in `lib/ui`, never `core/`

Nothing backported may import pixi from `game/render/*.ts` proper: `camera.ts`, `gestures.ts` and `view-transform.ts` are deliberately pixi-free, and `README.md:70-73` makes that a rule.

### 3.1 Sprite/object pooling — BACKPORT (medium value)

**TCR is genuinely missing this, and the generic half is small.**

`reconcile.ts` creates on `add` and destroys on `remove` with no recycling. For a camera-scoped board that pans, that is create/destroy churn proportional to pan distance, which is exactly the workload `SpritePool` exists for. ROD's version (`render/SpritePool.ts:22-70`) is about 50 lines of genuinely generic free-list logic wrapped around 25 lines of ROD tile specifics (the `anchor.set(0, 16/48)` wall and box offsets at lines 41-48).

Sibling test: any TCR game whose board is larger than the screen and whose entities are homogeneous wants this. Passes.

Shape it should take in TCR: not a `TileSpritePool` class, but an optional recycle seam on the reconciler or the stateful renderer, where `remove` returns the object to a caller-supplied pool and `add` is offered a recycled object first. That keeps `reconcile.ts` pure (its stated property, lines 10-14) and keeps pixi out of it.

Do not backport ROD's `(sprite as any).type` and `(sprite as any).tileInfo` tags (`SpritePool.ts:52`, `renderer.ts:207`). They are untyped side channels, and TCR's reconciler already holds the key-to-object map that makes them unnecessary.

### 3.2 An asset-readiness gate before `onAppStarted` — BACKPORT (high value)

**TCR is genuinely missing this, and it blocks ROD's adoption outright.**

ROD's host does `Assets.loadBundle('default').then(() => renderer.onAppStarted(viewport))` (`PixiCanvas.svelte:128-134`). TCR's host calls `renderer.onAppStarted(world)` synchronously once `app.init` resolves (`pixi/PixiCanvas.svelte:99-100`). ROD's objects read textures **synchronously in their constructors**: `objects/AvatarObject.ts:47-55` calls `Assets.get('sprites').textures[...]` in the ctor, and `TileSpritesheet.getTexture` (lines 24-45) does the same. Under TCR's host, the first entity that arrives before the bundle has loaded constructs with `undefined` textures.

Sibling test: every game on this template that uses a spritesheet or a bitmap font hits this on frame one. TCR's own game does not, because `CellObject` draws with `Graphics` only and needs no assets. That is precisely the shape "the template's example is the one case that does not exercise the seam". Passes strongly.

Two candidate shapes, both cheap:

1. an optional `ready?: () => Promise<void>` prop on the canvas hosts, awaited between init and `onAppStarted` (it must handle the unmount-during-await path the way `pixi/PixiCanvas.svelte:129-137` already does for `app.init`); or
2. document it as the page's job, and preload before mounting the canvas, in the shape of ROD's `GameScreenLoader.svelte`.

Option 1 is better for a template, because option 2 is opt-in and silently wrong when forgotten. That is the same argument ADR-0004 makes against a `closeOnNavigation(close)` helper, and the same one `context/game.ts` makes for wrapping dispatch rather than asking each call site to record it.

### 3.3 A camera-driven background layer inside a stateful renderer — DOCUMENT, do not backport code

**TCR-different.** The arithmetic ROD needs already exists and is better than ROD's: `visibleCells(transform, screen, margin)` (`view-transform.ts:186-201`) returns exactly ROD's `getVisibleBounds` (`render/renderer.ts:113-127`), with an explicit empty-range guard ROD lacks.

What is missing is the worked example. `README.md:19-27` presents stateful and immediate as a choice, but ROD needs **both at once**: a diffed entity layer and a per-frame, camera-derived terrain layer. That combination is legal (`stateful.ts:78-80` hands `tick` both the frame and the surface) but undocumented, and a sibling would guess wrong. Worth a paragraph in `game/render/README.md` rather than any code.

While re-expressing it, fix ROD's cost: `render/renderer.ts:227-229` rescans on **every camera store emission**, which during a drag is once per pointer move, and each scan is `(w+40) x (h+40)` cells, about 8100 iterations at ROD's 50-cell zoom-out. Driving it from `tick` and skipping when the integer bounds are unchanged is a one-line guard.

### 3.4 Keyboard and gamepad input — BACKPORT the recogniser shape, not ROD's code (medium value)

**TCR is genuinely missing this.** No `keydown` handler and no `getGamepads` call exists anywhere in TCR's `web/src`.

Sibling test: directional / confirm / cancel input is generic to a large class of board games (any game where the player moves a cursor or a piece); the mapping from intent to game action is not. That is the same split TCR already made for pointers: `gestures.ts` emits `GestureIntent`, and `input.ts:38-51` refuses to decide what a click means. So the generic artefact is a `game/render/keys.ts` and `game/render/gamepad.ts` emitting intents in `gestures.ts`'s two-part shape (pure state machine plus thin DOM binding), while ROD keeps `operations/index.ts:167-231`.

Do not copy ROD's implementations verbatim. Concrete defects not to carry over:

- `render/gamepads.ts:66-67` reads `gamepad.buttons[3].pressed` unguarded, and only to `console.log` it; `buttons[12..15]` at lines 82-96 assume the standard mapping. A controller reporting fewer buttons throws inside a `requestAnimationFrame` callback, every frame.
- `render/gamepads.ts:126-131`: `start()` re-adds the window listeners on each call, and the rAF loop is stopped only by the `running` flag, so a second `start()` before the previous loop notices runs two loops.
- `render/keyboard-controller.ts:100`: listeners are bound to `document`, unconditionally, with no `preventDefault` and no check for focus in a text input. Arrow keys and space therefore act on the game while the player types in any of ROD's flow modals. TCR's `connectSurfaceInput` takes an element for exactly this reason (`input.ts:26-31`).
- Both files declare unused local wrappers (`gamepads.ts:35-49`, `keyboard-controller.ts:24-46`), dead on arrival.
- `render/renderer.ts:395` calls `operations.stopListening()`, which is `eventEmitter.removeAllListeners()` (`operations/index.ts:234-236`). On a shared emitter that also removes the **canvas's** `clicked` listener. Under TCR's shape, where the emitter is context-owned and shared with the host, that is a live bug: tearing down the game half silently deafens the canvas half. TCR removes exactly the one handler it added (`context/game.ts:485`).

### 3.5 Async asset placeholders (`LoadingSprite` and friends) — BACKPORT one, fixed (low to medium value)

**TCR-missing.** `game/render/pixi/` contains `world.ts` and the canvas only.

Sibling test: "show an entity now, swap its remote texture in when it arrives" is generic to any game that draws per-player identity art (blockies, PFPs, NFT images). `LoadingSprite` passes. `LoadingSVG` and `LoadingBtimapText` do not currently earn it: both are unused in ROD, and the second is misspelled in its own filename.

Two defects must be fixed before it goes into a template, both invisible until they bite:

- `LoadingSprite.ts:20-25`: the `Assets.load(...).then(...)` has no cancellation. If the container is destroyed while the load is in flight, `onLoaded` calls `addChild` on a destroyed container. That is exactly the unmount race `pixi/PixiCanvas.svelte:129-137` is careful about, so shipping the unguarded version would contradict the host beside it.
- `LoadingSprite.ts:14-19` calls `Assets.add({alias: url, ...})` on every construction, so two avatars with the same owner register the same alias twice.

### 3.6 Splash screen and asset-load progress — CONCEPT ONLY, do not backport this code

**TCR-missing as a capability.** The sibling test passes on the idea: any game with assets wants a load-progress bar and a first-run splash.

But `core/ui/loading/splash.ts` violates two TCR ADRs as written:

- **ADR-0002 (synchronous, SSR-inert context) and ADR-0006 (configuration constructed once).** Lines 126-155 run at **module import time**: `Assets.init({manifest})` and `Assets.loadBundle('default')` fire on import in the browser, and a `setInterval` fires on the server. `TextureStyle.defaultOptions.scaleMode = 'nearest'` is a global mutation at line 7. `export const splash = createSplashStore(assetLoading)` at line 149 is a module singleton, and line 152 pins it on `window`.
- **ADR-0006** again: `params['logo']` is read at lines 55, 87 and 90 as an ambient debug switch, and `MAX_STAGE = 2` plus the two 2000ms timings (line 59) are hardcoded policy.

What is worth taking is the shape: a `Readable<number>` progress store fed by `Assets.loadBundle`'s progress callback (line 130), a `complete` flag derived from stage and progress (lines 33-38), and the first-visit `localStorage` skip (lines 19-23). All of that is about 30 lines when constructed rather than imported. Recommendation: backport as a constructed `createAssetLoader({manifest, bundle})` in `game/render/pixi/`, feeding the 3.2 gate, with the splash component left to each game.

### 3.7 Grid alpha as a function of zoom — BACKPORT (small, cheap)

**TCR-missing, and TCR already says it wants it.** `seams.ts:216-221` names "a grid that fades out as you zoom away" as one of the two reasons `Frame` carries the scale, but `pixi/PixiCanvas.svelte:101` sets `gridPixel.alpha = 0.15` flat, and `canvas2d/draw.ts` has the equivalent. ROD does it at `PixiCanvas.svelte:200` (`viewport.scaled / 48`).

Sibling test passes trivially: a grid that is unreadable at full zoom-out affects every game on the template. Do not copy ROD's magic `/48` (it is a scale in pixi content-pixel units, meaningless after the unit change to game units). Express it against `frame.transform.scale` and the zoom limits, and put it in `grid.ts` so both hosts share it, which is `grid.ts:1-13`'s whole stated reason for existing.

### 3.8 Iterating live scene objects for per-frame animation — BACKPORT (small, sharp)

**TCR is genuinely missing this, and it is a hole in a capability TCR advertises.**

`README.md:23` sells stateful as good for "anything with per-object animation", and `stateful.ts:78-80` provides `tick({frame, surface})`. But `Reconciler` exposes only `get(key)` and `size` (`reconcile.ts:96-110`), so there is no way to enumerate the live objects. A game that animates every object per frame, which ROD does at `render/renderer.ts:391-398`, must keep a **parallel collection** in sync by hand. That is the duplication `reconcile.ts` was written to remove.

Fix: add `values()` or `entries()` to `Reconciler` and expose it from `createStatefulRenderer`, which already returns an extra member (`lastDiff`, lines 84-87). Two lines, no new concepts, and it closes the gap between what the README promises and what the API allows.

### 3.9 pixi devtools hook — BACKPORT the one line, not the dependency

`globalThis.__PIXI_APP__ = app` (`ROD PixiCanvas.svelte:100`) needs no dependency and makes the pixi devtools extension work. `initDevtools({app})` (line 98) needs `@pixi/devtools`, and ROD's own comment says it "does not seem to work anymore". Take the former under a dev-only guard; leave the latter.

### 3.10 pixi-viewport — NOT a missing capability; deliberately avoided, and the avoidance is right

ROD depends on `pixi-viewport@^6.0.3` (`web/package.json`). TCR does not, and documents why at `game/render/README.md:82-88` and `routes/play/+page.svelte:27-37`.

Judgement: **deliberately avoided, and nothing ROD actually uses is lost.** ROD's entire use of the library is four calls: `drag().pinch().wheel().clampZoom({...})` (`PixiCanvas.svelte:140-146`), `fit()` (147), `moveCenter()` (126, 149, and `core/render/camera.ts:38,43`), and `toWorld()` (58). Every one has a TCR equivalent, named in the matrix above. The features TCR dropped (inertia, bounce, world-bounds clamping, snap, animated follow, mouse-edge scroll: README lines 86-87) are used by ROD **nowhere**; there is no `.decelerate`, `.bounce`, `.clamp(`, `.snap(` or viewport `.follow(` anywhere in ROD.

Two ROD bugs are direct consequences of the library and disappear with it: `viewport.resize()` with no arguments (`PixiCanvas.svelte:89`, which `camera.ts:66-77` calls out by name), and `toWorld(event.x, event.y)` being correct only while the canvas is flush with the page origin (README lines 88-89). ROD happens to escape the second because `GameScreen.svelte`'s `.canvas` is `position: absolute; top: 0; left: 0` full-bleed, but it is one navbar away from wrong.

So: removing `pixi-viewport` from ROD is a strict improvement, and TCR should not add it back.

### Not backported: stays in ROD (sibling test fails)

- `TileSpritesheet.ts` — ROD's four tile types and its `exit_0NN.png` frame naming.
- `AvatarObject.ts` — blockie sprite, entering animation, green/red squares, dead cross, planned-path drawing.
- `gsap` movement tweening (`AvatarObject.ts:145-157`). Generic-ish as "animate between epochs", but it is one dependency and one game's easing policy. The framework already gives `frame.delta` and `onEpochChanged`, which is the right amount of help.
- `WallRenderer.ts` — dead.
- The y-sorted depth convention (`zIndex = 10 * y`) — a top-down tile-game rule, not a board-game rule.

---

## 4. Risks in the adoption

Ordered by cost.

### 4.1 Assets are not loaded when `onAppStarted` fires — BLOCKER, high

Covered in 3.2. Concretely: `render/objects/AvatarObject.ts:47-55` and `render/TileSpritesheet.ts:24-45` both call `Assets.get('sprites')` synchronously. Under TCR's host, `onAppStarted` runs as soon as `app.init` resolves (`pixi/PixiCanvas.svelte:87-100`), and the stateful renderer subscribes to view state immediately (`stateful.ts:93-116`), so the first `add()` can precede the bundle. Symptom: `undefined` textures, constructors throwing inside a store subscription, or invisible entities that never recover.

Cost if TCR does not address it: ROD adds a bespoke gate to its own copy of the canvas, forking the file TCR wants identical across hosts (README line 105: "if you add a prop to one host, add it to the other"). Cost if addressed: one optional prop plus its unmount-race handling in two components, roughly 15 lines.

### 4.2 The renderer is currently ROD's game-logic hub — high, but a refactor rather than a seam problem

`render/renderer.ts:46-77` takes `epochInfo`, `localState`, `epochConfig`, `avatars`, `enterFlow` and `deployments`, and **constructs `createOperations` inside the renderer** (lines 70-81), then starts and stops it in `onAppStarted`/`onAppStopped` (154, 385). The keyboard and gamepad controllers are likewise owned by the renderer (88-89, 152-153, 383-384).

TCR's seam cannot express this, and is right not to: `createStatefulRenderer`'s handlers receive `{key, entity, object, surface}` only, and TCR puts click-to-game-rule in `context/game.ts:433-445`, not in the renderer. So the adoption **requires** moving `createOperations`, the keyboard controller and the gamepad controller out of the renderer into ROD's context `start()`.

That is a genuine improvement (it decouples "the game is listening" from "a canvas is mounted"), but it changes lifetimes: today input stops when the canvas unmounts. After the move, ROD must decide explicitly whether input survives a canvas unmount. TCR gives no guidance on this; worth deciding once.

### 4.3 `playerControlled` is not part of the entity, so the diff will miss it — medium, silent

`render/renderer.ts:299-306` calls `markAsPlayerControlled` on **every** view-state emission, outside any change check. Under `createStatefulRenderer`, `update` is called **only when `changed` returns true** (`reconcile.ts:60-66`, `stateful.ts:114`). "Which avatar is mine" comes from `$viewState.avatar?.id`, not from the entity, so at the moment the player's identity resolves, the relevant avatar entity may be byte-identical and **never receive an update**: the player's own avatar renders as someone else's, permanently, until something unrelated changes it.

Fix: fold `playerControlled` into the view entity in ROD's `view/` merge and include it in the `changed` comparison, exactly as `placement/render/board-renderer.ts:24-38` folds `planned` into `CellView`. `reconcile.ts:29-40` already warns that this is the failure mode of hand-written dirty checks; the ROD version reaches it from the other side.

### 4.4 Shared mutable scene state between entities (`world.pathDisplayObject`) — medium

`AvatarObject.update` calls `this.world.pathDisplayObject.removeChildren()` and repopulates it (`AvatarObject.ts:108-125`), and `markAsPlayerControlled`/`onRemoved` do the same (175, 182). One entity object mutating a container shared with all the others is legal under TCR's seam (the surface is handed to every handler), but it combines badly with 4.3: if `update` is skipped by the diff, the planned-path overlay is not redrawn.

The planned path is per-epoch local intent, which is precisely what `stateful.ts:onEpochChanged` (lines 57-68) exists for. Recommendation: hoist the path layer out of `AvatarObject` into the renderer, cleared on `onEpochChanged` and rebuilt from the view state, rather than as a side effect of one entity's update.

### 4.5 `Object` entity map vs `Keyed`, and the missing `Unloaded` step — low to medium, mechanical

ROD's `ViewState.entities` is a plain object (`view/index.ts:18-24`, iterated with `Object.keys` at `renderer.ts:288`). `StatefulRendererParams.entities` wants `Keyed<TKey, TEntity>` = `ReadonlyMap | Iterable<[K,V]>` (`reconcile.ts:16-17`). `Object.entries(...)` satisfies it, but allocates the whole entity list on every emission, and `reconcile.ts:48-53` explicitly designed the diff to allocate in proportion to changes. Better: make ROD's view merge produce a `Map`.

Also: ROD's `ViewState` has **no `Unloaded` step**, while `ViewStateValue<TView>` (`seams.ts:80-81`) requires `{step: 'Unloaded'} | ({step: 'Loaded'; epoch: number} & TView)`. ROD's view state must grow that discriminator. This is not busywork: `stateful.ts:96-103` uses `Unloaded` to empty the scene on an account switch or a chain reset, which ROD currently cannot do at all.

### 4.6 Grid z-order under y-sorting — low

TCR's host adds the grid `Graphics` to the same `world` container the renderer draws into (`pixi/PixiCanvas.svelte:95-98`). ROD sets `zIndex = 10 * y` on tiles and avatars (`renderer.ts:216`, `295-297`), which in pixi v8 auto-enables sorting on the parent (`sortMixin.mjs:15-22`). The grid's `zIndex` is 0, so it would sort into the middle of ROD's tile stack rather than under everything. Trivially fixed with a very negative `zIndex`, but it reads as "the renderer is broken". ROD currently passes `showGrid={false}` (`GameScreen.svelte:47`), so it only bites if ROD turns the grid on.

### 4.7 Click coordinates change meaning — low, but silent if missed

ROD's `clicked` payload is snapped integers (`PixiCanvas.svelte:58-63`); TCR's is fractional world units (`events.ts:11-21`). `operations/index.ts:209-224` feeds `pos.x`/`pos.y` straight into `zoneLocalCoord` and `areaAt`. Un-rounded fractional input there does not throw, it indexes the wrong cell near boundaries, which looks like flaky click detection. One `Math.round` in ROD's handler, mirroring `context/game.ts:441-444`.

### 4.8 Module-singleton event emitter — low

`render/eventEmitter.ts:3-12` is a module-level singleton, imported directly by `GameScreen.svelte:6` and used for the on-screen D-pad at lines 64-79. TCR constructs it per context (`context/game.ts:295`) and hands it down through `Render` (`context/game.ts:135-149`) to the page (`routes/play/+page.svelte:83`). ADR-0004's central complaint is precisely module-level globals for UI state. Combined with `removeAllListeners()` (3.4, last bullet), this is the most likely source of an "input stopped working after navigating away and back" bug post-port.

---

## Summary judgement

- **ROD loses nothing by adopting TCR's render layer**, and fixes at least four live bugs by doing so: `viewport.resize()` with no arguments, the `setTimeout`-based drag/click suppression, `cameraControl.move`'s precedence bug, and the never-cleared scene on a state reset.
- **Two things must be built or agreed before the port can compile and run**: an asset-readiness gate (3.2 / 4.1) and the removal of `createOperations` from inside the renderer (4.2).
- **Strongest backports**, in order: the asset gate (3.2), reconciler iteration for per-frame animation (3.8), an input-intent layer for keyboard and gamepad in `gestures.ts`'s shape (3.4), object pooling (3.1), zoom-aware grid alpha (3.7).
- **pixi-viewport should not come back into TCR.** Nothing ROD uses is missing from TCR's replacement, and two of ROD's bugs are the library's fault.
