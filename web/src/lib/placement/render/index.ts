/**
 * WHICH RENDERER THIS GAME USES. The one file to edit to change it.
 *
 * A game on this template picks one of three styles, and the choice is meant to
 * be reversible rather than structural:
 *
 * - STATEFUL (pixi, three.js): a scene graph diffed against the view state.
 *   `board-renderer.ts`, on `$lib/game/render/stateful`.
 * - IMMEDIATE (twgl, canvas 2d): the whole picture redrawn each frame.
 *   `board-immediate.ts`, on `$lib/game/render/immediate`.
 * - REACTIVE (Svelte): no renderer at all. Delete `render` from the context and
 *   have a component subscribe to `viewState` like any other store.
 *
 * The two canvas hosts take identical props, so switching is the three lines
 * below and nothing else: not the camera, not the gestures, not the click
 * handling, not the page. See `$lib/game/render/README.md`.
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
