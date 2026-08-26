/**
 * WHICH RENDERER THIS GAME USES. The one file to edit to change it.
 *
 * TWO of the three rendering styles are swapped here, by editing this file and
 * nothing else:
 *
 * - STATEFUL (pixi, three.js): a scene graph diffed against the view state.
 *   `board-renderer.ts`, on `$lib/game/render/stateful`.
 * - IMMEDIATE (twgl, canvas 2d): the whole picture redrawn each frame.
 *   `board-immediate.ts`, on `$lib/game/render/immediate`.
 *
 * Both are canvas hosts implementing `GameRenderer`, and the two components
 * take identical props, so switching is the block below and nothing else: not
 * the camera, not the gestures, not the click handling, not the page. See
 * `$lib/game/render/README.md`.
 *
 * The THIRD style, REACTIVE (Svelte), is NOT swapped here, and saying it is
 * would be misleading. It is not a `GameRenderer` at all: there is no surface,
 * no frame loop and nothing to hand to `onAppStarted`, so a reactive game
 * deletes this file and drops `gameRenderer` from the context rather than
 * pointing it somewhere else. What it keeps is the view state, which is already
 * a store and needs no adapter.
 *
 * What it does NOT get for free is the camera, and this is the part that bites.
 * The poller is camera-scoped: `createPollingOnchainState` refuses to fetch
 * while the camera reports no size (`onchain/state.ts`, "the camera has no size
 * until the canvas has laid itself out"). A component that only subscribes to
 * `viewState` never calls `cameraControl.resize`, so the board stays EMPTY
 * FOREVER with no error anywhere: no failed request, no console warning, just
 * an empty board that looks like a game with nothing in it yet.
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
 * Nothing in the template demonstrates either yet; the two canvas paths are the
 * ones with working examples and tests.
 *
 * The pixi build is the template's default because it is what most of the games
 * downstream use. The canvas-2d one is not a toy: it is what proves the seam is
 * real, and `web/test/lib/game/render` tests both.
 */
import type {Container} from 'pixi.js';
import type {GameRenderer} from '$lib/game/core/seams';
import type {ViewStateStore} from '$lib/view';
import type {BoardView} from '../view';
import {createBoardRenderer} from './board-renderer';

/**
 * What the mounted surface hands the renderer.
 *
 * Named once, here, so that no other module has to mention a rendering library
 * by name. Switching to the immediate renderer makes this
 * `CanvasRenderingContext2D`; a three.js game makes it a `Scene`.
 */
export type GameSurface = Container;

/** Loaded dynamically, and only in the browser: see `routes/play/+page.svelte`. */
export const loadCanvasComponent = () =>
	import('$lib/game/render/pixi/PixiCanvas.svelte');

export function createGameRenderer(params: {
	viewState: ViewStateStore<BoardView>;
	cellSize: number;
}): GameRenderer<GameSurface> {
	return createBoardRenderer(params);
}

/*
 * The immediate-mode alternative. Replace EVERYTHING ABOVE (imports included,
 * or `Container` and `createBoardRenderer` are left imported and unused) with:
 */

// import type {GameRenderer} from '$lib/game/core/seams';
// import type {ViewStateStore} from '$lib/view';
// import type {BoardView} from '../view';
// import {createImmediateBoardRenderer} from './board-immediate';

// export type GameSurface = CanvasRenderingContext2D;

// export const loadCanvasComponent = () =>
// 	import('$lib/game/render/canvas2d/Canvas2DCanvas.svelte');

// export function createGameRenderer(params: {
// 	viewState: ViewStateStore<BoardView>;
// 	cellSize: number;
// }): GameRenderer<GameSurface> {
// 	return createImmediateBoardRenderer({viewState: params.viewState});
// }
