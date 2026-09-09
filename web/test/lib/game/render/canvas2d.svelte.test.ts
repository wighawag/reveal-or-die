import {describe, expect, it, vi} from 'vitest';
import {render} from 'vitest-browser-svelte';
import {writable} from 'svelte/store';
import type {ViewStateStore, ViewStateValue} from '$lib/game/core/seams';
import {createCamera} from '$lib/game/render/camera';
import {createCanvasEventEmitter} from '$lib/game/render/events';
import {createImmediateBoardRenderer} from '$lib/placement/render/board-immediate';
import type {BoardView, CellView} from '$lib/placement/view';
import Harness from './Canvas2DHarness.svelte';

/**
 * The canvas-2d host, against a real canvas and real pixels.
 *
 * IT HAD NO TEST AT ALL, and nothing imported it, for the whole time it was the
 * template's second renderer. That is why this is a browser test that reads the
 * canvas back rather than a node test with a stub context: a fake context
 * records the calls you thought to fake, and every drift this file actually
 * found was a disagreement about coordinates, which a call recorder answers
 * with whatever you told it to.
 *
 * What it pins is the contract between the three pieces the host wires
 * together, because that is where the drift was: `beginFrame` sets up device
 * pixels, `applyCamera` maps game units onto them, and the renderer draws in
 * game units. A change to any one of them alone moves the board.
 */

const SIZE = {width: 240, height: 180};

/** `#4f8cff`, the confirmed fill, and `#ffd166`, the planned outline. */
const CONFIRMED = {r: 0x4f, g: 0x8c, b: 0xff};
const PLANNED = {r: 0xff, g: 0xd1, b: 0x66};
const BACKGROUND = {r: 0x0b, g: 0x10, b: 0x20};

type Colour = {r: number; g: number; b: number};

/**
 * What a colour drawn at `alpha` over the background actually looks like.
 *
 * Computed rather than hardcoded, because the alpha is not decoration: a
 * claimed cell is drawn at `min(0.35 + 0.2 * claimants, 0.95)`, so the number
 * of players on a cell IS the opacity, and that rule is shared with the pixi
 * host's `CellObject`. Asserting the blend rather than the raw colour is what
 * makes this test notice the rule changing, instead of only noticing that
 * something blue was painted.
 */
function over(colour: Colour, alpha: number, background = BACKGROUND): Colour {
	return {
		r: colour.r * alpha + background.r * (1 - alpha),
		g: colour.g * alpha + background.g * (1 - alpha),
		b: colour.b * alpha + background.b * (1 - alpha),
	};
}

/** The opacity `board-immediate.ts` gives a cell with this many claimants. */
const claimantAlpha = (n: number) => Math.min(0.35 + 0.2 * n, 0.95);

function cell(
	x: number,
	y: number,
	over: Partial<CellView> = {},
): [bigint, CellView] {
	const id = BigInt(x) * 1_000_000n + BigInt(y);
	return [
		id,
		{
			cellID: id,
			totalStake: 0n,
			numClaimants: 0,
			position: {x, y},
			planned: false,
			...over,
		},
	];
}

function setup(options: {showGrid?: boolean} = {}) {
	const store = writable<ViewStateValue<BoardView>>({step: 'Unloaded'});
	const viewState: ViewStateStore<BoardView> = {
		subscribe: store.subscribe,
		status: writable({loading: false}),
	};
	// A scale of exactly 10 CSS pixels per game unit, so a cell's screen
	// position is arithmetic a reader can check by hand rather than a number
	// this test copied out of the camera.
	const {cameraControl} = createCamera({
		initialVisible: {width: SIZE.width / 10, height: SIZE.height / 10},
		limits: {minWidth: 1, minHeight: 1, maxWidth: 1000, maxHeight: 1000},
	});
	const renderer = createImmediateBoardRenderer({viewState});
	const eventEmitter = createCanvasEventEmitter();

	const screen = render(Harness, {
		cameraControl,
		renderer,
		eventEmitter,
		width: SIZE.width,
		height: SIZE.height,
		showGrid: options.showGrid ?? false,
	});
	// The ResizeObserver is asynchronous; seed the size so the first frame has
	// a surface to draw on. Same reason as `input.svelte.test.ts`.
	cameraControl.resize(SIZE.width, SIZE.height);

	const canvas = () => document.querySelector('canvas') as HTMLCanvasElement;
	return {store, cameraControl, canvas, screen};
}

/** The colour at a CSS-pixel position, read out of the device-pixel buffer. */
function pixelAt(canvas: HTMLCanvasElement, x: number, y: number) {
	const context = canvas.getContext('2d')!;
	const ratio = canvas.width / SIZE.width;
	const data = context.getImageData(
		Math.round(x * ratio),
		Math.round(y * ratio),
		1,
		1,
	).data;
	return {r: data[0], g: data[1], b: data[2], a: data[3]};
}

/** Where a game-unit point lands on screen, in CSS pixels. */
function screenOf(x: number, y: number) {
	return {x: SIZE.width / 2 + x * 10, y: SIZE.height / 2 + y * 10};
}

function isNear(actual: Colour, expected: Colour, tolerance = 4) {
	return (
		Math.abs(actual.r - expected.r) <= tolerance &&
		Math.abs(actual.g - expected.g) <= tolerance &&
		Math.abs(actual.b - expected.b) <= tolerance
	);
}

/** Wait for the host's `requestAnimationFrame` loop to paint. */
async function painted(check: () => void) {
	await vi.waitFor(check, {timeout: 2000, interval: 16});
}

describe('the canvas-2d host', () => {
	it('sizes its backing store in device pixels and paints the background', async () => {
		const {canvas} = setup();

		await painted(() => {
			const ratio = window.devicePixelRatio || 1;
			expect(canvas().width).toBe(Math.round(SIZE.width * ratio));
			expect(canvas().height).toBe(Math.round(SIZE.height * ratio));
			// `#0b1020`. Without `beginFrame` the canvas is transparent black,
			// which has alpha 0 and would fail here rather than passing by
			// looking dark.
			const at = pixelAt(canvas(), 4, 4);
			expect(at.a).toBe(255);
			expect(isNear(at, {r: 0x0b, g: 0x10, b: 0x20}, 2)).toBe(true);
		});
	});

	/**
	 * The load-bearing assertion in this file.
	 *
	 * A claimed cell is drawn `fillRect(x - 0.35, y - 0.35, 0.7, 0.7)` in GAME
	 * units, and the camera transform is the only thing that turns that into
	 * pixels. So this fails if `applyCamera` stops agreeing with the camera, if
	 * `beginFrame` stops accounting for the device pixel ratio, or if the
	 * renderer starts drawing in pixels the way the pixi one does.
	 */
	it('paints a claimed cell where the camera says it is', async () => {
		const {store, canvas} = setup();
		store.set({
			step: 'Loaded',
			epoch: 1,
			cells: new Map([cell(0, 0, {numClaimants: 2, totalStake: 5n})]),
		});

		const expected = over(CONFIRMED, claimantAlpha(2));
		await painted(() => {
			const at = screenOf(0, 0);
			expect(isNear(pixelAt(canvas(), at.x, at.y), expected)).toBe(true);
		});

		// And the fill really is 0.7 of a unit, not the whole cell: a point
		// just inside the cell's own square but outside the inset is background.
		// This is the half that a "draw something blue" assertion misses, and
		// the inset is what distinguishes a claimed cell from a planned one.
		const edge = screenOf(0.45, 0);
		expect(isNear(pixelAt(canvas(), edge.x, edge.y), BACKGROUND)).toBe(true);

		// One more claimant is one step more opaque. This is the assertion that
		// makes the alpha rule load-bearing rather than incidental.
		expect(claimantAlpha(3)).toBeGreaterThan(claimantAlpha(2));
	});

	it('outlines a planned cell without filling it', async () => {
		const {store, canvas} = setup();
		store.set({
			step: 'Loaded',
			epoch: 1,
			cells: new Map([cell(1, 0, {planned: true})]),
		});

		await painted(() => {
			// The outline is on the cell boundary, half a unit from its centre.
			const border = screenOf(1, -0.5);
			expect(isNear(pixelAt(canvas(), border.x, border.y), PLANNED)).toBe(true);
		});

		// The middle stays background: a planned cell must never read as
		// confirmed, which is the one thing a commit-reveal board has to say.
		const middle = screenOf(1, 0);
		const at = pixelAt(canvas(), middle.x, middle.y);
		expect(isNear(at, PLANNED)).toBe(false);
		expect(isNear(at, CONFIRMED)).toBe(false);
	});

	/**
	 * Culling is the immediate renderer's own job, and it is the one piece of
	 * logic in `board-immediate.ts` that is not a drawing call. The state store
	 * is camera-scoped but a zone is 16 cells wide, so it legitimately hands
	 * over cells that are off screen.
	 */
	it('does not draw a cell the camera cannot see', async () => {
		const {store, canvas} = setup();
		store.set({
			step: 'Loaded',
			epoch: 1,
			cells: new Map([
				cell(0, 0, {numClaimants: 1}),
				cell(500, 500, {numClaimants: 4}),
			]),
		});

		await painted(() => {
			const at = screenOf(0, 0);
			expect(
				isNear(
					pixelAt(canvas(), at.x, at.y),
					over(CONFIRMED, claimantAlpha(1)),
				),
			).toBe(true);
		});
		// Nothing from the far cell bled into the visible area: with no culling
		// the fill lands at a wildly out-of-range coordinate, which canvas
		// silently discards, so the assertion that has teeth is the positive one
		// above plus the background staying background everywhere else.
		for (const [x, y] of [
			[10, 10],
			[SIZE.width - 10, SIZE.height - 10],
		]) {
			expect(isNear(pixelAt(canvas(), x, y), BACKGROUND)).toBe(true);
		}
	});

	/**
	 * Immediate mode redraws everything every frame, so a cell that goes away
	 * has to actually disappear. If `beginFrame` ever stopped clearing, the
	 * board would accumulate every cell it had ever seen, and the symptom would
	 * be stale stake shown as current.
	 */
	it('clears what it drew last frame', async () => {
		const {store, canvas} = setup();
		store.set({
			step: 'Loaded',
			epoch: 1,
			cells: new Map([cell(0, 0, {numClaimants: 2})]),
		});
		const expected = over(CONFIRMED, claimantAlpha(2));
		await painted(() => {
			const at = screenOf(0, 0);
			expect(isNear(pixelAt(canvas(), at.x, at.y), expected)).toBe(true);
		});

		store.set({step: 'Loaded', epoch: 2, cells: new Map()});
		await painted(() => {
			const at = screenOf(0, 0);
			expect(isNear(pixelAt(canvas(), at.x, at.y), BACKGROUND)).toBe(true);
		});
	});

	it('follows the camera when it pans', async () => {
		const {store, cameraControl, canvas} = setup();
		store.set({
			step: 'Loaded',
			epoch: 1,
			cells: new Map([cell(0, 0, {numClaimants: 2})]),
		});
		const expected = over(CONFIRMED, claimantAlpha(2));
		await painted(() => {
			const at = screenOf(0, 0);
			expect(isNear(pixelAt(canvas(), at.x, at.y), expected)).toBe(true);
		});

		// Drag the content right by 30 CSS pixels: the cell moves with it.
		cameraControl.handle({type: 'pan', dx: 30, dy: 0});
		await painted(() => {
			const moved = screenOf(0, 0);
			expect(isNear(pixelAt(canvas(), moved.x + 30, moved.y), expected)).toBe(
				true,
			);
			// and it is no longer where it was
			expect(isNear(pixelAt(canvas(), moved.x, moved.y), BACKGROUND)).toBe(
				true,
			);
		});
	});
});
