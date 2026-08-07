<!--
	A pixi surface for a `GameRenderer<Container>`.

	The framework ships this the way it ships the polling state store: as ONE
	implementation of a seam, not as the seam itself. Nothing above it imports
	pixi (the camera deliberately does not), so a game that renders with raw
	WebGL supplies its own canvas and the rest of the app does not notice.

	Every comment below marked with a bug is a bug that was found by looking at a
	real browser, not by reading the code. They are kept because each one looks
	correct until it is measured.
-->
<script lang="ts">
	import {Viewport} from 'pixi-viewport';
	import {Application, FederatedPointerEvent, Graphics} from 'pixi.js';
	import {onMount} from 'svelte';
	import type {CameraControl} from '../camera';
	import type {GameRenderer} from '$lib/game/core/seams';
	import type {Container} from 'pixi.js';
	import type {CanvasEventEmitter} from './events';

	interface Props {
		cameraControl: CameraControl;
		renderer: GameRenderer<Container>;
		eventEmitter: CanvasEventEmitter;
		/** Pixels per game unit. */
		cellSize: number;
		showGrid?: boolean;
		backgroundColor?: string;
	}
	let {
		cameraControl,
		renderer,
		eventEmitter,
		cellSize,
		showGrid = true,
		backgroundColor = '#0b1020',
	}: Props = $props();

	function buildGrid(
		graphics: Graphics,
		width: number,
		height: number,
		size: number,
	) {
		const numRows = Math.floor(height / size) + 1;
		const numCols = Math.floor(width / size) + 1;
		for (let i = 0; i < numCols; i++) {
			graphics.moveTo(i * size, 0).lineTo(i * size, height);
		}
		for (let i = 0; i < numRows; i++) {
			graphics.moveTo(0, i * size).lineTo(width, i * size);
		}
		return graphics;
	}

	let canvas: HTMLCanvasElement;
	let viewport: Viewport;

	onMount(() => {
		const minWidth = 10 * cellSize;
		const minHeight = 10 * cellSize;
		const maxWidth = 100 * cellSize;
		const maxHeight = 100 * cellSize;

		let isDragging = false;
		let dragStartPos = {x: 0, y: 0};
		const clickThreshold = 5; // pixels

		function onclick(event: FederatedPointerEvent) {
			if (isDragging) return;

			// BUG (found in a browser): `event.global`, NOT `event.x`/`event.y`.
			// Pixi documents those as aliases for clientX/clientY, which are
			// relative to the browser viewport, while toWorld() expects canvas
			// space. The two only agree while the canvas sits flush at the
			// viewport origin. It does not (the app shell has a navbar, and
			// reserves a scrollbar gutter), so every click landed that far from
			// the cell the player aimed at.
			const pos = viewport.toWorld(event.global);
			eventEmitter.emit('clicked', {
				x: Math.round(pos.x / cellSize),
				y: Math.round(pos.y / cellSize),
			});
		}

		// The drag threshold only ever looks at a DELTA, so reading client
		// coordinates here was never wrong. It uses `global` anyway so the file
		// speaks one coordinate space throughout, and so the pixel threshold
		// stays meaningful if the renderer resolution stops being 1.
		function onPointerDown(event: FederatedPointerEvent) {
			isDragging = false;
			dragStartPos = {x: event.global.x, y: event.global.y};
		}

		function onPointerMove(event: FederatedPointerEvent) {
			const deltaX = Math.abs(event.global.x - dragStartPos.x);
			const deltaY = Math.abs(event.global.y - dragStartPos.y);
			if (deltaX > clickThreshold || deltaY > clickThreshold) {
				isDragging = true;
			}
		}

		function onPointerUp() {
			// Reset after a beat, so the click event that follows still sees the
			// drag state.
			setTimeout(() => {
				isDragging = false;
			}, 10);
		}

		function resizeViewport() {
			// BUG (found in a browser): the arguments are not optional in
			// practice. pixi-viewport's resize() defaults to
			// window.innerWidth/innerHeight, not to the canvas. The canvas is
			// inset by the app shell, so the window size is never its size, and
			// calling resize() bare quietly told the viewport it was bigger than
			// it is - which skews worldScreenWidth/Height, and with them the
			// camera and the set of zones the poller fetches.
			viewport?.resize(canvas.clientWidth, canvas.clientHeight);
		}
		const sizeObserver = new ResizeObserver(resizeViewport);
		sizeObserver.observe(canvas);

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
			resolution: 1,
			antialias: false,
		});

		appInitialising.then(() => {
			if (destroying) return;
			initialised = true;

			viewport = new Viewport({
				// The interaction module, so wheel behaves when the canvas is
				// placed or scaled.
				events: app.renderer.events,
				allowPreserveDragOutside: true,
				// Same reason as resizeViewport(): the constructor also defaults to
				// the window, and clampZoom()/moveCenter() below run before the
				// ResizeObserver first fires.
				screenWidth: canvas.clientWidth,
				screenHeight: canvas.clientHeight,
			});

			// The camera drives the surface through a tiny adapter rather than
			// holding the Viewport itself: the state layer watches the camera, and
			// a camera that imported pixi would put pixi on every game.
			cameraControl.attach({
				moveCenter: (x: number, y: number) =>
					viewport.moveCenter(x * cellSize, y * cellSize),
			});

			app.stage.addChild(viewport);
			viewport.drag().pinch().wheel().clampZoom({
				maxWidth,
				maxHeight,
				minHeight,
				minWidth,
			});
			viewport.fit(true, 24 * cellSize, 24 * cellSize);
			viewport.moveCenter(0, 0);

			let gridPixel: Graphics | undefined;
			if (showGrid) {
				const gridSize = Math.max(maxWidth, maxHeight) + 2 * cellSize;
				gridPixel = buildGrid(
					new Graphics(),
					gridSize,
					gridSize,
					cellSize,
				).stroke({color: 0xffffff, pixelLine: true, width: 1});
				gridPixel.alpha = 0.15;
				viewport.addChild(gridPixel);
			}

			viewport.on('pointerdown', onPointerDown);
			viewport.on('pointermove', onPointerMove);
			viewport.on('pointerup', onPointerUp);
			viewport.on('click', onclick);
			viewport.on('tap', onclick);

			appStarted = true;
			renderer.onAppStarted(viewport);

			app.ticker.add(() => {
				cameraControl.update({
					x: viewport.center.x / cellSize,
					y: viewport.center.y / cellSize,
					width: viewport.worldScreenWidth / cellSize,
					height: viewport.worldScreenHeight / cellSize,
				});

				if (gridPixel) {
					// An infinite grid: one tile of lines, kept under the camera by
					// snapping it to the nearest cell.
					const scale = viewport.scaled;
					const offsetX = viewport.x / scale;
					const offsetY = viewport.y / scale;
					gridPixel.x =
						-offsetX - cellSize - cellSize / 2 + (offsetX % cellSize);
					gridPixel.y =
						-offsetY - cellSize - cellSize / 2 + (offsetY % cellSize);
				}

				renderer.tick();
			});
		});

		return () => {
			sizeObserver.disconnect();
			cameraControl.detach();
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
	}
</style>
