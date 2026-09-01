import {describe, expect, it} from 'vitest';
import {createWalk} from '$lib/world/render/walk';

/**
 * The replacement for a tweening library, and the reason it is worth having as
 * its own module: every case that matters here is a timing edge, and a timing
 * edge is miserable to check on screen and one line to check in node.
 */
const walk = (path: {x: number; y: number}[], secondsPerStep = 1) =>
	createWalk({from: {x: 0, y: 0}, path, secondsPerStep});

describe('walking a path', () => {
	it('interpolates between cells rather than jumping', () => {
		const w = walk([{x: 0, y: 1}]);
		expect(w.advance(0.5)).toEqual({x: 0, y: 0.5});
		expect(w.done).toBe(false);
	});

	it('walks each step in turn', () => {
		const w = walk([
			{x: 0, y: 1},
			{x: 1, y: 1},
		]);
		expect(w.advance(1)).toEqual({x: 0, y: 1});
		expect(w.advance(0.5)).toEqual({x: 0.5, y: 1});
		expect(w.advance(0.5)).toEqual({x: 1, y: 1});
		expect(w.done).toBe(true);
	});

	it('lands exactly on the end when a frame overshoots it', () => {
		// What a backgrounded tab hands it on the first frame back: one delta of
		// several seconds. Overshooting would fling the avatar off the board.
		const w = walk([
			{x: 0, y: 1},
			{x: 0, y: 2},
		]);
		expect(w.advance(60)).toEqual({x: 0, y: 2});
		expect(w.done).toBe(true);
	});

	it('is finished before it starts when there is nothing to walk', () => {
		const w = walk([]);
		expect(w.done).toBe(true);
		expect(w.advance(1)).toEqual({x: 0, y: 0});
	});

	it('ignores a step onto the cell it is already standing on', () => {
		// A revealed turn can contain an Enter or an Exit, which name the cell the
		// avatar is already on. Spending a step going nowhere would show as a
		// pause in the middle of a walk.
		const w = createWalk({
			from: {x: 2, y: 2},
			path: [
				{x: 2, y: 2},
				{x: 3, y: 2},
			],
			secondsPerStep: 1,
		});
		expect(w.advance(1)).toEqual({x: 3, y: 2});
		expect(w.done).toBe(true);
	});

	it('does not move on a zero delta, and refuses to go backwards', () => {
		const w = walk([{x: 0, y: 1}]);
		w.advance(0.5);
		expect(w.advance(0)).toEqual({x: 0, y: 0.5});
		// A clock that reports a negative delta (a resync, a mocked timer) must
		// not rewind the animation.
		expect(w.advance(-5)).toEqual({x: 0, y: 0.5});
	});

	it('speeds up rather than dragging when a turn is long', () => {
		// `maxSeconds` is the whole-path bound: the reveal window is short, and an
		// animation still running when the next epoch resolves would draw a board
		// that is one turn behind.
		const w = createWalk({
			from: {x: 0, y: 0},
			path: [
				{x: 1, y: 0},
				{x: 2, y: 0},
				{x: 3, y: 0},
				{x: 4, y: 0},
			],
			secondsPerStep: 1,
			maxSeconds: 2,
		});
		expect(w.advance(2).x).toEqual(4);
		expect(w.done).toBe(true);
	});

	it('reports where it is without being advanced', () => {
		const w = walk([{x: 0, y: 1}]);
		expect(w.position).toEqual({x: 0, y: 0});
		w.advance(0.25);
		expect(w.position).toEqual({x: 0, y: 0.25});
	});
});
