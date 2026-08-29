import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {Assets, Texture} from 'pixi.js';
import {
	FRAMES,
	SOLID_FRAMES,
	createTerrainLayer,
	frameAt,
} from '$lib/world/render/terrain';
import {CellType, ZONE_SIZE, isObstacle} from 'reveal-or-die-contracts';
import type {Frame} from '$lib/game/core/seams';

/**
 * The map the player SEES against the map the contract ENFORCES.
 *
 * This layer exists because the port dropped it: walls were refused by
 * `planning.ts` and drawn by nothing, so the player bumped into cells that
 * looked like open floor. The tests that matter are therefore not about pixi,
 * they are about the two maps agreeing.
 */

describe('what is drawn against what can be walked on', () => {
	it('draws something solid exactly where the contract refuses a move', () => {
		// Across more than one zone in each direction, INCLUDING negative
		// coordinates: `zoneLocalCoord` is where a sign error would hide, and the
		// half of the board least likely to be looked at by hand is the half that
		// breaks.
		let solid = 0;
		let open = 0;
		for (let y = -ZONE_SIZE - 3; y <= ZONE_SIZE + 3; y++) {
			for (let x = -ZONE_SIZE - 3; x <= ZONE_SIZE + 3; x++) {
				const drawnSolid = SOLID_FRAMES.has(frameAt(x, y));
				expect(
					drawnSolid,
					`(${x},${y}) is drawn ${drawnSolid ? 'solid' : 'open'} but ` +
						`isObstacle says ${isObstacle(x, y)}`,
				).toBe(isObstacle(x, y));
				if (drawnSolid) solid++;
				else open++;
			}
		}
		// Guards the guard: a mapping that returned undefined for everything would
		// satisfy the loop above only if the map were entirely open, so assert the
		// sample actually contains both.
		expect(solid).toBeGreaterThan(0);
		expect(open).toBeGreaterThan(0);
	});

	it('draws the exit, and does not treat it as a wall', () => {
		// `!` is the way out. It has to be visible, or the one goal on the board is
		// invisible, and it must not read as solid: the contract lets an avatar
		// stand on it, which is how leaving works at all.
		expect(FRAMES[CellType.Exit]).toBeTruthy();
		expect(SOLID_FRAMES.has(FRAMES[CellType.Exit])).toBe(false);
	});

	it('has a frame for every cell type the map generator emits', () => {
		// A type with no frame is a hole in the floor. Pinned as a set so adding a
		// cell type to the ascii format fails here rather than showing up as a gap
		// somebody notices in a screenshot.
		for (const type of Object.values(CellType)) {
			expect(FRAMES[type], `no frame for cell type ${type}`).toBeTruthy();
		}
	});
});

/** A frame at a given camera centre, with everything else held still. */
function frame(centerX: number, centerY: number): Frame {
	return {
		time: 0,
		delta: 16,
		devicePixelRatio: 1,
		screen: {width: 100, height: 100},
		transform: {centerX, centerY, scale: 10},
	} as unknown as Frame;
}

describe('following the camera', () => {
	beforeEach(() => {
		// Every frame resolves to the same texture: this is about which sprites
		// exist and when, not about what they show.
		vi.spyOn(Assets, 'get').mockReturnValue({
			textures: Object.fromEntries(
				Object.values(FRAMES)
					.filter((f): f is string => !!f)
					.map((f) => [f, Texture.EMPTY]),
			),
		} as never);
	});
	afterEach(() => vi.restoreAllMocks());

	it('draws nothing until the spritesheet has arrived', () => {
		// The bundle is started and deliberately not awaited, so the first frames
		// can land before it. Drawing an empty layer and then never revisiting it
		// is the failure: the map would stay blank for the session.
		vi.spyOn(Assets, 'get').mockReturnValue(undefined as never);
		const layer = createTerrainLayer(10);
		layer.update(frame(0, 0));
		expect(layer.view.children.length).toBe(0);
		layer.destroy();
	});

	it('fills the visible area once it has', () => {
		const layer = createTerrainLayer(10);
		layer.update(frame(0, 0));
		expect(layer.view.children.length).toBeGreaterThan(0);
		layer.destroy();
	});

	it('does no work while a drag stays inside the same cell', () => {
		// THE GUARD, and the reason this is affordable at all. `visibleCells` is
		// integer-quantised, so a drag only produces a new box when it crosses a
		// cell boundary. Without this every pointer move rescanned the whole
		// visible area, which is what the pre-port renderer did.
		//
		// Started at 0.3 rather than 0 ON PURPOSE. At 0 the visible edges land
		// exactly on integers, so `floor` and `ceil` are both on the turn and the
		// tiniest movement legitimately produces a different box. That is correct
		// behaviour and it made the first version of this test fail; the case
		// worth pinning is a move that does NOT cross a boundary.
		const layer = createTerrainLayer(10);
		layer.update(frame(0.3, 0.3));
		const first = layer.view.children.length;
		const sample = layer.view.children[0];

		expect(layer.redraws).toBe(1);

		layer.update(frame(0.31, 0.32));
		layer.update(frame(0.4, 0.35));

		// THE COUNT is the assertion, because a rescan is idempotent: existing
		// tiles are skipped by key, so the scene is identical either way and an
		// unguarded version would pass everything below. The first version of this
		// test did exactly that, and did not fail when the guard was deleted.
		expect(layer.redraws).toBe(1);
		expect(layer.view.children.length).toBe(first);
		expect(layer.view.children[0]).toBe(sample);
		layer.destroy();
	});

	it('does redraw once the camera crosses a cell boundary', () => {
		// The other half of the guard. One that never invalidated would pass the
		// test above and leave the map frozen where the player started.
		const layer = createTerrainLayer(10);
		layer.update(frame(0.3, 0.3));
		const before = layer.view.children.map((c) => c);

		layer.update(frame(3.3, 0.3));

		expect(layer.redraws).toBe(2);
		// Same screenful, different cells: the set of sprites on screen has moved.
		expect(layer.view.children.length).toBe(before.length);
		expect(layer.view.children.map((c) => c.position.x)).not.toEqual(
			before.map((c) => c.position.x),
		);
		layer.destroy();
	});

	it('recycles sprites rather than growing when the camera pans', () => {
		// Panning a long way and coming back must not leak: the pool is what makes
		// a pan cost nothing after the first screenful.
		const layer = createTerrainLayer(10);
		layer.update(frame(0, 0));
		const baseline = layer.view.children.length;

		for (let i = 1; i <= 12; i++) layer.update(frame(i, 0));
		layer.update(frame(0, 0));

		// Back where it started, with the same amount on screen. A layer that
		// leaked would be carrying every cell it had ever visited.
		expect(layer.view.children.length).toBe(baseline);
		layer.destroy();
	});
});
