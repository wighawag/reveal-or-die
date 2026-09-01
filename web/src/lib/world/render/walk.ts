/**
 * Walking a piece along a path, one cell at a time.
 *
 * The whole of the animation, and deliberately about forty lines of it. A
 * tweening library was the obvious answer and is the wrong one here: this
 * animates a handful of avatars along a handful of orthogonal steps, driven by
 * a frame loop the framework already runs, and the cost of a dependency is not
 * the bytes but that it ends up threaded through the objects it animates.
 * `bomber-world` builds a `gsap` timeline inside `AvatarObject.update`, which
 * is a fine choice and one this file exists to avoid needing.
 *
 * REPLACEABLE ON PURPOSE, which is the actual requirement. It knows nothing
 * about pixi, about avatars, or about the chain: positions in, a position out,
 * time advanced by whoever owns the clock. Swapping in gsap, motion, or a
 * spring means writing something with `advance` and `position` and changing
 * the two lines in `AvatarObject` that call them.
 *
 * Pure, so the interesting parts - a path that arrives mid-walk, a frame that
 * skips several steps, a delta of zero - are node tests rather than something
 * to squint at on screen.
 */
import type {Position} from 'reveal-or-die-contracts';

export type Walk = {
	/**
	 * Advance by `dt` SECONDS and return where the piece now is, in cells.
	 *
	 * Fractional: the caller multiplies by its own cell size. A delta larger
	 * than the remaining path lands exactly on the end rather than overshooting,
	 * which is what a backgrounded tab hands it on the first frame back.
	 */
	advance(dt: number): Position;
	/** Where it is now, without moving it. */
	readonly position: Position;
	/** Whether the last cell has been reached. */
	readonly done: boolean;
};

/**
 * A walk from `from` through each cell of `path`, in order.
 *
 * `secondsPerStep` is per CELL rather than for the whole path, because a turn
 * is one to a handful of steps and the eye reads them as steps: a fixed total
 * would make a one-step turn crawl and a four-step turn blur. `maxSeconds`
 * bounds it anyway, for a game that ever allows a long turn.
 */
export function createWalk(params: {
	from: Position;
	path: readonly Position[];
	secondsPerStep: number;
	maxSeconds?: number;
}): Walk {
	// Cells that are not actually a move are dropped, so a path that starts
	// where the piece already stands does not spend a step going nowhere.
	const cells: Position[] = [];
	let previous = params.from;
	for (const cell of params.path) {
		if (cell.x !== previous.x || cell.y !== previous.y) {
			cells.push(cell);
			previous = cell;
		}
	}

	const perStep =
		cells.length === 0
			? 0
			: Math.min(
					params.secondsPerStep,
					(params.maxSeconds ?? Infinity) / cells.length,
				);

	let elapsed = 0;
	let position = params.from;

	function at(time: number): Position {
		if (cells.length === 0 || perStep <= 0) {
			return cells[cells.length - 1] ?? params.from;
		}
		const step = Math.min(Math.floor(time / perStep), cells.length - 1);
		const start = step === 0 ? params.from : cells[step - 1];
		const end = cells[step];
		// The fraction THROUGH the current step, clamped: the last step holds at
		// 1 rather than running past the end of the path.
		const progress = Math.min(1, time / perStep - step);
		return {
			x: start.x + (end.x - start.x) * progress,
			y: start.y + (end.y - start.y) * progress,
		};
	}

	return {
		advance(dt) {
			elapsed += Math.max(0, dt);
			position = at(elapsed);
			return position;
		},
		get position() {
			return position;
		},
		get done() {
			return cells.length === 0 || elapsed >= perStep * cells.length;
		},
	};
}
