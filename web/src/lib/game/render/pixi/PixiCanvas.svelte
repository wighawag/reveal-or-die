<!--
	A pixi surface for a `GameRenderer<Container>`.

	The framework ships this the way it ships the polling state store: as ONE
	implementation of a seam, not as the seam itself. Nothing above it imports
	pixi (the camera deliberately does not), so a game that renders with raw
	WebGL supplies its own canvas and the rest of the app does not notice. Its
	props are exactly `Canvas2DCanvas.svelte`'s, so switching between them is one
	import and no other change.

	It no longer uses `pixi-viewport`. Panning, zooming and the transform are the
	framework's own (`gestures.ts`, `camera.ts`, `view-transform.ts`), and what is
	left here is the part that is really pixi's: create an Application, keep a
	world Container in step with the camera, and tick the renderer. That was worth
	doing because the library did three jobs and only one of them was pixi's, so
	two thirds of it had to be written again for any non-pixi surface, and the
	rest of it (inertia, bounce, world clamping, snap, mouse-edge scrolling) was
	never used by any game on this template.
-->
<script lang="ts">
	import {Application, Container, Graphics} from 'pixi.js';
	import {onMount} from 'svelte';
	import type {CameraControl} from '../camera';
	import type {GameRenderer} from '$lib/game/core/seams';
	import type {CanvasEventEmitter} from '../events';
	import {connectSurfaceInput} from '../input';
	import {createFrameLoop} from '../frame-loop';
	import {applyTransform, buildGrid, positionGrid} from './world';

	interface Props {
		cameraControl: CameraControl;
		renderer: GameRenderer<Container>;
		eventEmitter: CanvasEventEmitter;
		/** Pixels per game unit at 1:1. What pixi content is authored in. */
		cellSize: number;
		showGrid?: boolean;
		backgroundColor?: string;
		/**
		 * Grid tile size in cells.
		 *
		 * One tile is built once and slid around, so it has to be at least as wide
		 * as the camera may ever go. Derive it with `gridTileCells(limits)` from
		 * the same camera config the camera is built from, which is what the page
		 * does: a hand-picked default here goes stale the moment someone raises the
		 * zoom-out limit, and the grid then runs out at the screen edge only at
		 * full zoom out, which is exactly where nobody looks.
		 */
		gridCells: number;
	}
	let {
		cameraControl,
		renderer,
		eventEmitter,
		cellSize,
		showGrid = true,
		backgroundColor = '#0b1020',
		gridCells,
	}: Props = $props();

	let canvas: HTMLCanvasElement;

	onMount(() => {
		// Gestures, the resize observer and click-to-cell. None of it is pixi's,
		// and both canvases share it.
		const input = connectSurfaceInput({
			element: canvas,
			cameraControl,
			eventEmitter,
		});

		const app = new Application();
		let initialised = false;
		let appStarted = false;
		let destroying = false;

		const appInitialising = app.init({
			resizeTo: canvas,
			canvas,
			backgroundAlpha: 1,
			backgroundColor,
			roundPixels: true,
			// Pinned at 1 deliberately: the art is pixelated, and rendering it at
			// device resolution would upscale it and defeat that.
			//
			// This is therefore the REAL backing-store ratio for this host, and it
			// is what the frame reports. A renderer sizing a hairline off
			// `frame.devicePixelRatio` gets 1 here and is correct to, because the
			// buffer really is one pixel per CSS pixel. A host that wants device
			// resolution sets this AND reports it; the canvas-2d one does.
			resolution: 1,
			antialias: false,
		});

		appInitialising.then(() => {
			if (destroying) return;
			initialised = true;

			// The world container is what the renderer draws into, and what the
			// camera moves. Renderers only ever used `Container` methods on the old
			// Viewport, so this is a drop-in for them.
			const world = new Container();
			app.stage.addChild(world);

			let gridPixel: Graphics | undefined;
			if (showGrid) {
				gridPixel = buildGrid(gridCells, cellSize);
				gridPixel.alpha = 0.15;
				world.addChild(gridPixel);
			}

			appStarted = true;
			renderer.onAppStarted(world);

			// Pixi's own ticker stays in charge of the schedule, because it has to
			// render after the scene is updated. The frame arithmetic is shared.
			const frames = createFrameLoop({
				cameraControl,
				devicePixelRatio: () => app.renderer.resolution,
			});

			app.ticker.add((ticker) => {
				const frame = frames.advance(ticker.deltaMS);
				const {transform, screen} = frame;

				applyTransform({world, transform, screen, cellSize});
				if (gridPixel) {
					const at = positionGrid({transform, screen, cellSize});
					gridPixel.x = at.x;
					gridPixel.y = at.y;
				}

				renderer.tick(frame);
			});
		});

		return () => {
			input.dispose();
			if (initialised) {
				if (appStarted) renderer.onAppStopped();
				app.destroy();
			} else {
				// Unmounted before init resolved: pixi has no cancel, so wait for it
				// and destroy then, or the WebGL context leaks.
				destroying = true;
				appInitialising.then(() => app.destroy());
			}
		};
	});

	function onCanvasContextMenu(event: Event) {
		event.preventDefault();
	}
</script>

<canvas oncontextmenu={onCanvasContextMenu} bind:this={canvas}></canvas>

<style>
	canvas {
		position: absolute;
		width: 100%;
		height: 100%;
		pointer-events: auto;
		image-rendering: pixelated;
		/*
			Without this a touch drag scrolls the page instead of panning the board,
			and a pinch zooms the whole document. Set here rather than relied on from
			pixi's event system, because the gestures are ours now and the canvas-2d
			host needs the identical rule.
		*/
		touch-action: none;
	}
</style>
