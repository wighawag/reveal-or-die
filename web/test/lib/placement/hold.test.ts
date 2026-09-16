import {describe, expect, it} from 'vitest';
import {holdResolvingCycle, type HeldBoardState} from '$lib/placement/hold';

const board = (cells: Record<string, number>): HeldBoardState => ({
	cycleNumber: 4,
	cells: new Map(
		Object.entries(cells).map(([id, stake]) => [
			BigInt(id),
			{cellID: BigInt(id), totalStake: BigInt(stake), numClaimants: 1},
		]),
	),
});

const stakes = (state: HeldBoardState) =>
	Object.fromEntries(
		[...state.cells].map(([id, cell]) => [String(id), Number(cell.totalStake)]),
	);

describe('what this game holds back while a cycle resolves', () => {
	it('draws a changed cell as it was when the cycle began', () => {
		// The stake moved because a reveal landed. Drawing it now would show a
		// simultaneous cycle playing out in the order players paid.
		const held = holdResolvingCycle({
			shown: board({1: 10}),
			latest: board({1: 30}),
			resolvingCycleNumber: 4,
		});
		expect(stakes(held)).toEqual({1: 10});
	});

	it('leaves an unchanged cell exactly as it is', () => {
		const held = holdResolvingCycle({
			shown: board({1: 10}),
			latest: board({1: 10}),
			resolvingCycleNumber: 4,
		});
		expect(stakes(held)).toEqual({1: 10});
	});

	it('withholds a cell that was NOT on screen, because on this board that is the outcome', () => {
		// A cell absent from the shown board is either newly claimed by a reveal
		// that just landed or a region the player panned onto, and nothing here
		// tells the two apart. On an open board the first is the common case, and
		// showing it leaks exactly what committing is paid for to hide. See the
		// argument in the file: a game whose entities PERSIST must choose the
		// other way.
		const held = holdResolvingCycle({
			shown: board({1: 10}),
			latest: board({1: 10, 2: 7}),
			resolvingCycleNumber: 4,
		});
		expect(stakes(held)).toEqual({1: 10});
	});

	it('drops a cell that has left the fetched region', () => {
		// The player panned away. The memory must not resurrect a region that is
		// no longer being read.
		const held = holdResolvingCycle({
			shown: board({1: 10, 2: 4}),
			latest: board({1: 10}),
			resolvingCycleNumber: 4,
		});
		expect(stakes(held)).toEqual({1: 10});
	});

	it('carries the board\u2019s own cycle stamp through, because it is not part of the outcome', () => {
		// It says which cycle the FETCH was for, and everything watching for the
		// board to catch up with the clock reads it. Holding it back would report
		// the board as permanently behind for the length of every reveal window.
		const held = holdResolvingCycle({
			shown: {...board({1: 10}), cycleNumber: 3},
			latest: {...board({1: 30}), cycleNumber: 4},
			resolvingCycleNumber: 4,
		});
		expect(held.cycleNumber).toBe(4);
	});
});
