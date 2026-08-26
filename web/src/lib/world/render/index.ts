/**
 * WHICH RENDERER THIS GAME USES. The one file to edit to change it.
 *
 * This game is STATEFUL over pixi: a scene graph diffed against the view state.
 * Swapping to the immediate style (canvas 2d, twgl) means changing the three
 * exports below and nothing else: not the camera, not the gestures, not the
 * click handling, not the page. See `$lib/game/render/README.md`, which
 * explains the three styles and why the reactive one is not swapped here.
 */
import type {Container} from 'pixi.js';
import type {GameRenderer} from '$lib/game/core/seams';
import type {ViewStateStore} from '$lib/view';
import type {WorldView} from '../view';
import {createAvatarRenderer} from './avatar-renderer';

/**
 * What the mounted surface hands the renderer.
 *
 * Named once, here, so no other module has to mention a rendering library by
 * name. Switching to the immediate renderer makes this
 * `CanvasRenderingContext2D`; a three.js game makes it a `Scene`.
 */
export type GameSurface = Container;

/** Loaded dynamically, and only in the browser: see `routes/play/+page.svelte`. */
export const loadCanvasComponent = () =>
	import('$lib/game/render/pixi/PixiCanvas.svelte');

export function createGameRenderer(params: {
	viewState: ViewStateStore<WorldView>;
	cellSize: number;
}): GameRenderer<GameSurface> {
	return createAvatarRenderer(params);
}
