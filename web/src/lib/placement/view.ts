/**
 * What the renderer draws: the board, plus what the player has planned but not
 * yet committed.
 *
 * The planned layer is the whole reason a view state exists separately from the
 * onchain state. A commit-reveal game has a phase where the player's decisions
 * are real to them and invisible to everyone else, and the client is the only
 * thing that can show them. Planned cells are marked rather than merged into
 * the confirmed numbers, so the player can always tell what is on chain from
 * what is merely intended.
 */
import type {ViewMerge} from '$lib/view';
import type {BoardState, Cell} from './state';
import {positionOf, type Position} from './cells';

export type CellView = Cell & {
	position: Position;
	/** The player has planned a placement here this epoch. */
	planned: boolean;
};

export type BoardView = {
	cells: Map<bigint, CellView>;
};

export type LocalPlan = {
	/** Cells the player has clicked this epoch, in the order they picked them. */
	planned: readonly bigint[];
};

/**
 * Combine confirmed board state with local intent.
 *
 * Cells are copied rather than annotated in place: the onchain store stays the
 * single source of truth, and a re-derive must not leave a `planned` flag
 * behind on it that a later merge would then read as confirmed.
 */
export const mergeBoardView: ViewMerge<BoardState, LocalPlan, BoardView> = ({
	onchain,
	local,
}) => {
	const cells = new Map<bigint, CellView>();

	for (const [id, cell] of onchain.cells) {
		cells.set(id, {...cell, position: positionOf(id), planned: false});
	}

	for (const id of local.planned) {
		const existing = cells.get(id);
		if (existing) {
			cells.set(id, {...existing, planned: true});
			continue;
		}
		// A planned placement on an empty cell has nothing on chain behind it
		// yet, so the entity is invented here with a zero stake. Drawing it is
		// the point: an empty board with no feedback on click feels broken.
		cells.set(id, {
			cellID: id,
			totalStake: 0n,
			numClaimants: 0,
			position: positionOf(id),
			planned: true,
		});
	}

	return {cells};
};
