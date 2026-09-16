/**
 * What this game holds back while a cycle resolves.
 *
 * The framework owns the WHEN (`game/core/handover.ts`: hold during the wait,
 * release when the cycle is over, and publish the release so the local overlay
 * can hand over in the same propagation). This is the one thing it cannot own:
 * which parts of THIS game's board the resolving cycle changed.
 *
 * Here the board is cells with an accumulated stake and a claimant count, and
 * during a reveal window the only thing on chain that touches either is a
 * reveal of the cycle being resolved. A commitment places nothing - it is a
 * hash - and the contract refuses a reveal once the epoch has turned over. So
 * "what this cycle changed" is simply "whatever changed", and the rule is that
 * a cell already on screen keeps the value it had when the cycle began.
 *
 * A CELL THAT WAS NOT ON SCREEN IS HIDDEN, which is the opposite of what a
 * game with long-lived entities should do, and the difference is worth stating
 * because it is the same fork in the road either way. A cell can be absent
 * from the shown board for two reasons: it was claimed by a reveal that just
 * landed, or the player panned onto a region that was never fetched. Nothing
 * on this board tells the two apart. Showing it would leak exactly what this
 * exists to hide, because on an open board "a cell became claimed" IS the
 * cycle's outcome and is the common case rather than a rare one. Hiding it
 * costs a player who pans mid-window a few seconds of empty cells in a region
 * they cannot act on anyway, since planning is locked while the cycle
 * resolves.
 *
 * A game whose entities PERSIST should choose the other way and say so: there,
 * hiding an entity that was merely panned onto removes something that has been
 * standing in the world since before the cycle began, which is worse than
 * showing one arrival early.
 *
 * Pure, so the four cases that matter (changed, unchanged, newly claimed,
 * newly visible) are node tests rather than something to squint at during a
 * ten second reveal window.
 */
import type {HoldResolvingCycle} from '$lib/game/core/handover';
import type {BoardState} from './state';

export type HeldBoardState = BoardState & {epoch: number};

export const holdResolvingCycle: HoldResolvingCycle<HeldBoardState> = ({
	shown,
	latest,
}) => {
	const cells: BoardState['cells'] = new Map();

	// Driven by LATEST rather than by what is shown, so a cell the player panned
	// AWAY from stops being drawn: the memory must not resurrect a region that
	// is no longer being fetched.
	for (const id of latest.cells.keys()) {
		const previous = shown.cells.get(id);
		// Held: drawn with the stake it had when the cycle began, and the new
		// total arrives when every reveal has landed. A cell that was never on
		// screen is left out entirely - see the file comment, because on this
		// board that is this cycle's outcome far more often than it is a pan.
		if (previous) cells.set(id, previous);
	}

	// The epoch is the BOARD's own stamp and is not part of the outcome: it says
	// which cycle the fetch was for, and everything that watches for the board
	// catching up reads it.
	return {cells, epoch: latest.epoch};
};
