# Rendering

The framework does not care how a game draws itself. It owns the camera, the gestures and the view state; a game owns the pixels. This note says what the seam is, which of the three styles to fill it with, and what you have to write in each case.

The seam is `GameRenderer<TSurface>` in `$lib/game/core/seams`:

```ts
type GameRenderer<TSurface> = {
	onAppStarted(surface: TSurface): void;
	onAppStopped(): void;
	tick(frame: Frame): void;
};
```

`TSurface` is whatever the mounted canvas hands over: a pixi `Container`, a `CanvasRenderingContext2D`, a `WebGL2RenderingContext`, a three.js `Scene`. The framework never inspects it.

## Picking a style

|                                 | you write                   | the framework gives you                                         | good for                                                                                           |
| ------------------------------- | --------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Reactive** (Svelte)           | a component                 | nothing extra: `viewState` is a store                           | HUDs, card games, board games with few entities, anything that is really a UI                      |
| **Immediate** (twgl, canvas 2d) | a `draw` function           | the current view snapshot, per frame, with the camera transform | GPU rendering, thousands of entities, tile maps, anything where you would rather rebuild than diff |
| **Stateful** (pixi, three.js)   | `add` / `update` / `remove` | the diff, epoch changes, teardown                               | sprite scenes, retained scene graphs, anything with per-object animation                           |

If you are unsure, the answer is reactive until it is slow, then immediate. Stateful is the right answer when the library you want is retained-mode, which pixi and three.js are.

Only the last two are `GameRenderer`s, and only they are swapped by editing `$lib/placement/render/index.ts`. Reactive is a different shape: no surface, no frame loop, nothing to hand to `onAppStarted`. It is listed here as a peer because it is a real choice, not because it is the same kind of change.

### Reactive

The view state is a Svelte store, so a component subscribes to it like any other:

```svelte
{#each [...$viewState.cells.values()] as cell (cell.cellID)}
	<Cell {cell} />
{/each}
```

Delete `$lib/placement/render` and drop `gameRenderer` from the context; there is no renderer to point anywhere.

**The camera is not free, and getting this wrong is silent.** The poller is camera-scoped and refuses to fetch while the camera reports no size (`onchain/state.ts`). A component that only subscribes to `viewState` never calls `cameraControl.resize`, so the board stays empty forever with no failed request and no warning: it looks like a game with nothing in it yet. Pick one deliberately:

- **Keep the camera.** Have the component report its own size and drive pan/zoom into `cameraControl`. `connectSurfaceInput` takes any `HTMLElement`, not just a canvas, so this is a few lines.
- **Drop camera scoping.** Give `createPollingOnchainState` a fixed scope instead. Right whenever the world fits on one screen, which is most games that want to render in Svelte in the first place.

The template ships no reactive example. The two canvas paths are the ones with working code and tests behind them.

### Immediate

`createImmediateRenderer` holds the latest view snapshot and hands it to `draw` with the frame. That is the whole of what the framework owes an immediate renderer: a store is a push interface and a frame loop is a pull one, so without it every game writes the same `let latest` and the same subscription, and one of them forgets to unsubscribe.

```ts
createImmediateRenderer<CanvasRenderingContext2D, BoardView>({
	viewState,
	draw({surface, view, frame}) {
		if (view.step === 'Unloaded') return;
		for (const cell of view.cells.values()) {
			// ... draw it, in game units, under frame.transform
		}
	},
});
```

`draw` is called for the `Unloaded` state too, rather than being skipped until the state loads. An immediate renderer normally clears its surface every frame anyway, and skipping the call would leave the last loaded frame burnt into the canvas.

See `$lib/placement/render/board-immediate.ts` for a working one.

### Stateful

`createStatefulRenderer` diffs the view state and calls three handlers about your own entities. It subscribes rather than diffing per frame, because a scene graph only needs touching when the state changes.

```ts
createStatefulRenderer<Container, BoardView, bigint, CellView, CellObject>({
	viewState,
	entities: (view) => view.cells,
	changed: (a, b) => a.totalStake !== b.totalStake || a.planned !== b.planned,
	add: ({entity, surface}) => surface.addChild(new CellObject(entity)),
	update: ({object, entity}) => object.update(entity),
	remove: ({object, surface}) => surface.removeChild(object),
});
```

Four things it does that a hand-written loop usually does not, all of which are pinned by tests in `web/test/lib/game/render`:

- **`changed` is a typed comparison, not a key string.** Stateful renderers grow a dirty check like `` `${stake}:${claimants}:${planned}` ``. When a field is left out of one, the object simply never updates on screen and nothing fails.
- **An `Unloaded` view empties the scene.** State can go backwards (an account switch, a chain reset), and a loop that returns early on `Unloaded` leaves a board that belongs to nobody on screen forever.
- **Epoch changes are announced**, before that epoch's entities are applied. A commit-reveal game draws local intent that is scoped to exactly one epoch; without a signal, a renderer can only infer the boundary from entities changing, which is the inference that fails when nothing changed.
- **Teardown drops objects without running `remove`.** The surface has already taken them. Use `onStopped` for anything the surface does not own.

## The camera is the framework's, and it is authoritative

`camera.ts` holds the view transform. Gestures are fed into it; the surface reads the transform back and applies it when it draws. It does not delegate to a rendering library, which means it works with no surface mounted (`follow()` on a cold load moves the camera instead of being silently dropped) and there is one place a game can animate, restore or constrain the view from.

Three layers, none of which know about any rendering library:

- `view-transform.ts` is the arithmetic: world/screen conversion, zoom limits, fitting, zoom-about-a-point, culling. Pure functions. (`ViewTransform` and `ScreenSize` themselves are declared in `game/core/seams`, because `Frame` carries them and that keeps the dependency running render → core.)
- `gestures.ts` recognises drag-to-pan, pinch, wheel and tap, and emits INTENTS. The recogniser takes plain numbers so it can be tested in node; `attachGestures` is the thin DOM half.
- `camera.ts` applies intents to the transform and publishes the `Camera` store the state layer reads to decide what to load.
- `grid.ts` is where the grid lines are, in game units, shared by both hosts so they cannot drift apart.
- `frame-loop.ts` is the elapsed/delta bookkeeping and `Frame` assembly, shared for the same reason.

**A click leaves this layer as a world POINT, not a cell.** Snapping is a game rule: rounding to the nearest integer would make every game on the template a square grid with cells centred on integers. The template's game does that rounding in its own click handler in `context/game.ts`; a hex board or a continuous world does something else.

Two units, and confusing them is the only way to be wrong here: **world means GAME units (cells), and `scale` is CSS pixels per game unit.** Device pixel ratio belongs to the surface, which scales its own backing store. `cellSize` is only meaningful to a scene graph authored in pixels, and it appears in exactly one framework file (`pixi/world.ts`).

### Why not pixi-viewport

It did three jobs: recognise gestures, hold the transform, and apply it to a pixi container. Only the third is pixi's, so two thirds of it had to be written again for any non-pixi surface, and every non-pixi game on this template would have started by copying two hundred lines out of another repo. What we used of it is now about the same amount of code in `gestures.ts` plus `view-transform.ts`, shared by every surface and testable without a GPU.

What was dropped, because no game on this template ever called it: deceleration and inertia, bounce, clamping to world bounds (these worlds are infinite), snap, follow-a-target animation, mouse-edge scrolling. What was gained: pointer capture in place of `allowPreserveDragOutside`, one code path for mouse, touch and pen, and click coordinates that are correct wherever the canvas sits on the page (`toWorld(event.global)` was only correct while the canvas was flush against the viewport origin, which it is not).

## Switching renderer

`$lib/placement/render/index.ts` is the only file to edit. It names the surface type, the renderer factory and the canvas component, and the commented block at the bottom is the immediate-mode version of all three.

`PixiCanvas.svelte` and `Canvas2DCanvas.svelte` take **identical props** on purpose, so `routes/play/+page.svelte` does not change when you switch. If you add a prop to one host, add it to the other.

Writing a third host (twgl, three.js) is `Canvas2DCanvas.svelte` with `getContext('2d')` replaced and the surface type changed. Everything else in it is framework wiring: `connectSurfaceInput` for gestures, the resize observer and click-to-cell, and `createFrameLoop` for the elapsed/delta arithmetic. Only the schedule is the host's, because a library with its own ticker (pixi) has to keep it in order to render after the scene is updated.

## What a host owes the framework

1. Report its size in CSS pixels (`connectSurfaceInput` does this with a `ResizeObserver`).
2. Feed gestures to the camera, and clicks to the game (`connectSurfaceInput` again).
3. Call `renderer.tick(frame)` once per frame, building the frame with `createFrameLoop`.
4. Apply the transform when it draws, or leave that to the renderer if the style is immediate.

Only step 4 is renderer-specific.

`frame.devicePixelRatio` is what the host ACTUALLY configured its buffer to, which is not always `window.devicePixelRatio`. The pixi host pins pixi's `resolution` to 1 because the art is pixelated and upscaling it defeats the point, so it reports 1 and a renderer sizing a hairline off it is right to draw one CSS pixel. The canvas-2d host uses the device ratio and reports that. Report what you configured, or renderers that trust the number will draw at the wrong size.
