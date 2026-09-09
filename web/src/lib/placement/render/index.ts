/**
 * WHICH RENDERER THIS GAME USES. The one file to edit to change it.
 *
 * On `main` that is the IMMEDIATE renderer on a canvas-2d surface: the whole
 * picture, redrawn every frame, with no rendering library and nothing to
 * install. `board-immediate.ts`, on `$lib/game/render/immediate`.
 *
 * THE OTHER TWO STYLES.
 *
 * - STATEFUL (pixi, three.js): a scene graph diffed against the view state.
 *   The machinery is here on `main` - `$lib/game/render/stateful` and
 *   `reconcile.ts` import no rendering library and are what any scene-graph
 *   host builds on - but the pixi HOST and this game's pixi board live on the
 *   `with/pixi-js` branch, because `pixi.js` is a 79M install and `main` does
 *   not carry one. See D11 in the plan (`work:work/specs/proposed/
 *   games-on-this-foundation.md`) for why the library earns a branch and the
 *   diffing logic does not.
 * - REACTIVE (Svelte): NOT a swap of this file, and saying it is would be
 *   misleading. There is no surface, no frame loop and nothing to hand to
 *   `onAppStarted`, so a reactive game deletes this file and drops
 *   `gameRenderer` from the context rather than pointing it somewhere else.
 *   What it keeps is the view state, which is already a store.
 *
 * What a reactive game does NOT get for free is the camera, and this is the
 * part that bites. The poller is camera-scoped: `createPollingOnchainState`
 * refuses to fetch while the camera reports no size (`onchain/state.ts`, "the
 * camera has no size until the canvas has laid itself out"). A component that
 * only subscribes to `viewState` never calls `cameraControl.resize`, so the
 * board stays EMPTY FOREVER with no error anywhere: no failed request, no
 * console warning, just an empty board that looks like a game with nothing in
 * it yet.
 *
 * So a reactive game does one of two things, and should decide which on
 * purpose:
 *
 * - keep the camera, and have its component report its own size and drive
 *   pan/zoom into `cameraControl`. `connectSurfaceInput` works on any element,
 *   not just a canvas, so this is a few lines rather than a rewrite.
 * - drop camera scoping, and give `createPollingOnchainState` a fixed scope
 *   instead. Right for a game whose world fits on one screen (a card game, a
 *   small fixed board), which is most games that want to render in Svelte.
 *
 * WHAT SWAPPING COSTS, which is the property this file exists to protect: the
 * two canvas hosts take IDENTICAL props, so `with/pixi-js` changes this file
 * and nothing else - not the camera, not the gestures, not the click handling,
 * and not `routes/play/+page.svelte`, which still passes `cellSize` and
 * `gridCells` that the canvas-2d host documents as unused. That is why they are
 * accepted-and-ignored rather than removed: dropping them here would move the
 * branch's edit into the page, which is a much worse file to be editing on a
 * branch. `test/lib/game/render/host-props.test.ts` pins it.
 */
import type {GameRenderer} from '$lib/game/core/seams';
import type {ViewStateStore} from '$lib/view';
import type {BoardView} from '../view';
import {createImmediateBoardRenderer} from './board-immediate';

/**
 * What the mounted surface hands the renderer.
 *
 * Named once, here, so that no other module has to mention a rendering library
 * by name. On `with/pixi-js` this is pixi's `Container`; a three.js game makes
 * it a `Scene`.
 */
export type GameSurface = CanvasRenderingContext2D;

/** Loaded dynamically, and only in the browser: see `routes/play/+page.svelte`. */
export const loadCanvasComponent = () =>
	import('$lib/game/render/canvas2d/Canvas2DCanvas.svelte');

export function createGameRenderer(params: {
	viewState: ViewStateStore<BoardView>;
	cellSize: number;
}): GameRenderer<GameSurface> {
	return createImmediateBoardRenderer({viewState: params.viewState});
}
