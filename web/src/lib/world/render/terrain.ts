/**
 * The ground the avatars stand on: floor, walls, boxes and the way out.
 *
 * THE SECOND LAYER, and it works nothing like the first. Avatars are diffed
 * against view state, because they arrive and leave and move. Terrain does none
 * of that: the map is generated, fixed, and known offline, so what changes is
 * only WHICH PART OF IT IS ON SCREEN. That makes this a function of the camera
 * rather than of the chain, and it is driven from `tick` instead of from a
 * subscription.
 *
 * `game/render/README.md` presents stateful and immediate as a choice; this game
 * needs both at once, which is legal (the stateful renderer hands `tick` the
 * frame and the surface) but was not written down. Worth a paragraph upstream.
 *
 * WHY IT WAS MISSING. The pre-port renderer drew this and the port dropped it,
 * so walls were enforced but invisible: `planning.ts` refuses to step onto an
 * obstacle, and the player bumped into nothing they could see. The map data was
 * never the problem, only the drawing.
 */
import {Container, Sprite, Texture, Assets} from 'pixi.js';
import {visibleCells} from '$lib/game/render/view-transform';
import type {Frame} from '$lib/game/core/seams';
import {CellType, cellTypeAt} from 'reveal-or-die-contracts';

/**
 * How far beyond the screen to draw, in cells.
 *
 * One cell would be enough to cover a partly visible edge tile. Four, because
 * a pan reveals new cells continuously and building them a frame late shows as
 * a flickering border; the cost is a handful of sprites.
 */
const MARGIN = 4;

/** The spritesheet frame for each cell type, or none to draw nothing. */
export const FRAMES: Record<number, string | undefined> = {
	[CellType.Floor]: 'Floor-0.png',
	[CellType.Wall]: 'Wall_2_Single.png',
	[CellType.Box]: 'Box_Single.png',
	[CellType.Exit]: 'exit_001.png',
};

/**
 * Which frame belongs at world `(x, y)`, or none for a cell to leave blank.
 *
 * Exported and pure so the drawing can be checked against the RULES: a test
 * pins that the cells drawn as solid are exactly the cells `isObstacle`
 * refuses. Those two disagreeing is the whole failure this layer exists to
 * end, in its other direction: an invisible wall is bad, and a wall drawn where
 * the player may walk is worse.
 */
export function frameAt(x: number, y: number): string | undefined {
	return FRAMES[cellTypeAt(x, y)];
}

/** The frames that stand for something solid. */
export const SOLID_FRAMES = new Set([
	FRAMES[CellType.Wall],
	FRAMES[CellType.Box],
]);

/**
 * Terrain sits UNDER everything the game puts on the board.
 *
 * The avatar objects set `zIndex = 10 * y` so they sort back-to-front, which in
 * pixi v8 switches the parent to sorted rendering; anything left at 0 would land
 * in the middle of that stack rather than beneath it. A large negative index is
 * simpler than making the terrain participate in the same ordering, because it
 * genuinely is always behind.
 */
const TERRAIN_Z = -1000;

type Tile = {sprite: Sprite; frame: string};

export type TerrainLayer = {
	/** The container to add to the world, once. */
	readonly view: Container;
	/** Redraw for this frame's camera. Cheap when nothing has scrolled. */
	update(frame: Frame): void;
	/**
	 * How many times the visible area has actually been rescanned.
	 *
	 * For tests, following `createStatefulRenderer`'s `lastDiff`, and for the same
	 * reason: the bounds guard's whole effect is work NOT done, and a rescan is
	 * idempotent here (existing tiles are skipped by key), so nothing about the
	 * scene distinguishes a guarded frame from an unguarded one. Without a count,
	 * a test that deleted the guard would still pass.
	 */
	readonly redraws: number;
	destroy(): void;
};

/**
 * A tile layer that follows the camera.
 *
 * Pooling is by FRAME rather than one big free list, because a recycled sprite
 * only saves anything if it can keep its texture: swapping the texture on reuse
 * is most of the cost of making a new one. Panning across a wall therefore
 * reuses wall sprites and leaves the floor pool alone.
 */
export function createTerrainLayer(cellSize: number): TerrainLayer {
	const view = new Container();
	view.zIndex = TERRAIN_Z;
	// The layer is redrawn wholesale on a scroll, so let pixi skip child-order
	// bookkeeping it will never need: within the terrain nothing overlaps.
	view.sortableChildren = false;

	/** Live tiles, by `x,y`. */
	const tiles = new Map<string, Tile>();
	/** Free sprites, by frame name. See the note above about why it is keyed. */
	const pool = new Map<string, Sprite[]>();

	/**
	 * The bounds last drawn, so a frame that has not scrolled does nothing.
	 *
	 * The guard is the whole reason this is affordable. `visibleCells` is
	 * integer-quantised, so a drag produces a new box only when it crosses a cell
	 * boundary: without this, every pointer move rescanned the whole visible area
	 * (about 8100 cells at full zoom-out in the pre-port renderer, which did
	 * exactly that).
	 */
	let drawn:
		{minX: number; maxX: number; minY: number; maxY: number} | undefined;
	/** How many real rescans have happened. See `TerrainLayer.redraws`. */
	let redraws = 0;
	/** Textures are not there on frame one; see the note in `update`. */
	let texturesReady = false;

	function textureFor(frame: string): Texture | undefined {
		const sheet = Assets.get('sprites');
		return sheet?.textures?.[frame];
	}

	function acquire(frame: string): Sprite | undefined {
		const free = pool.get(frame);
		const recycled = free?.pop();
		if (recycled) return recycled;

		const texture = textureFor(frame);
		if (!texture) return undefined;
		const sprite = new Sprite(texture);
		// Cells are centred on their integer coordinate: the cell at 3,4 spans
		// 2.5..3.5, which is what the click handler's `Math.round` assumes and what
		// the grid is drawn with. An anchor of 0.5 is what makes those agree.
		sprite.anchor.set(0.5);
		sprite.width = cellSize;
		sprite.height = cellSize;
		return sprite;
	}

	function release(tile: Tile) {
		tile.sprite.removeFromParent();
		const free = pool.get(tile.frame);
		if (free) free.push(tile.sprite);
		else pool.set(tile.frame, [tile.sprite]);
	}

	function update(frame: Frame) {
		// Nothing to draw with yet. The bundle is started at `onStarted` and not
		// awaited (art is not needed to draw an avatar), so the first frames can
		// arrive before it lands. Returning WITHOUT setting `drawn` is what makes
		// the layer appear by itself once it does.
		if (!texturesReady) {
			if (!textureFor(FRAMES[CellType.Floor] as string)) return;
			texturesReady = true;
		}

		const bounds = visibleCells(frame.transform, frame.screen, MARGIN);
		if (
			drawn &&
			drawn.minX === bounds.minX &&
			drawn.maxX === bounds.maxX &&
			drawn.minY === bounds.minY &&
			drawn.maxY === bounds.maxY
		) {
			return;
		}
		drawn = bounds;
		redraws++;

		// Everything outside the new box goes back to the pool. Walked over the
		// LIVE tiles rather than over the old box, so the work is proportional to
		// what is on screen rather than to how far the camera jumped.
		for (const [key, tile] of tiles) {
			const [x, y] = key.split(',').map(Number);
			if (
				x < bounds.minX ||
				x > bounds.maxX ||
				y < bounds.minY ||
				y > bounds.maxY
			) {
				release(tile);
				tiles.delete(key);
			}
		}

		for (let y = bounds.minY; y <= bounds.maxY; y++) {
			for (let x = bounds.minX; x <= bounds.maxX; x++) {
				const key = `${x},${y}`;
				if (tiles.has(key)) continue;

				const frameName = frameAt(x, y);
				if (!frameName) continue;

				const sprite = acquire(frameName);
				if (!sprite) continue;
				sprite.position.set(x * cellSize, y * cellSize);
				view.addChild(sprite);
				tiles.set(key, {sprite, frame: frameName});
			}
		}
	}

	return {
		view,
		update,
		get redraws() {
			return redraws;
		},
		destroy() {
			view.removeChildren();
			for (const tile of tiles.values()) tile.sprite.destroy();
			for (const free of pool.values()) {
				for (const sprite of free) sprite.destroy();
			}
			tiles.clear();
			pool.clear();
			view.destroy({children: true});
		},
	};
}
