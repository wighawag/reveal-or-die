/**
 * What a control MEANS in this game.
 *
 * The other half of `$lib/input`, and the half that stays here. The
 * recognisers there say "a direction was pressed"; this says that a direction
 * is a step from the end of the plan, that the secondary action is leaving the
 * world, and that cancel takes back the last thing planned. Same split as the
 * pointer's: `game/render/gestures.ts` emits a click and `context/game.ts`
 * decides which cell it is.
 *
 * One mapping for every device, deliberately. The keyboard, a gamepad and the
 * on-screen d-pad all arrive here as intents, so there is one place where the
 * game's rules about a press live, and a fourth device costs nothing. The
 * previous build had the keyboard and the gamepad each reaching into the game
 * through their own handlers, which is how they came to disagree.
 *
 * WHAT IT DOES NOT DECIDE. The window in which a press is legal is not
 * re-derived here: `planning` already refuses anything the contract would
 * refuse, and `round.commit()` already refuses a commit outside the phase, with
 * nothing planned, or from a step that cannot commit. Asking those questions
 * again would be a second copy of an answer that exists, and the two copies
 * would eventually differ.
 */
import {get, type Readable} from 'svelte/store';
import type {ControlIntent, Direction} from '$lib/input/intents';
import {attachKeys, type KeyOptions} from '$lib/input/keys';
import {attachGamepad, type GamepadOptions} from '$lib/input/gamepad';
import type {RoundStore} from '$lib/game/core/round';
import type {Position} from 'reveal-or-die-contracts';
import type {Action} from './commit-reveal';
import type {PlanningStore} from './planning';
import {blocksCommitting, type MissedRevealStore} from './missed-reveal';

/**
 * A direction, as a step on this board.
 *
 * `y` GROWS DOWNWARDS, which is how every position the contract stores is laid
 * out and how the renderer draws them. The recogniser deliberately says nothing
 * about this: a hex game or one with the origin at the bottom left maps the
 * same four intents differently, and the whole point of the split is that only
 * this table has to change.
 */
export const STEP: Record<Direction, Position> = {
	up: {x: 0, y: -1},
	down: {x: 0, y: 1},
	left: {x: -1, y: 0},
	right: {x: 1, y: 0},
};

export type Controls = {
	/**
	 * Act on one intent, whatever produced it.
	 *
	 * Public because the on-screen d-pad is a third device and comes in the same
	 * way a key or a button does. A component that reached past this into
	 * `planning` would be a second mapping, and the one thing this file exists to
	 * prevent.
	 */
	handle(intent: ControlIntent): void;
	/**
	 * Start listening to the keyboard and any gamepad. Returns the teardown.
	 *
	 * THE CALLER OWNS THE LIFETIME, and it is a real decision rather than a
	 * detail - see `routes/play/+page.svelte`, which is where it is made and
	 * where the reasoning is written down.
	 */
	listen(options?: {
		/** Where key events are heard. The document, unless a test says otherwise. */
		target?: Parameters<typeof attachKeys>[0];
		keys?: KeyOptions;
		gamepad?: GamepadOptions;
	}): () => void;
};

export function createControls(params: {
	planning: Pick<PlanningStore, 'stepBy' | 'exitAt' | 'undo'>;
	round: Pick<RoundStore<bigint, Action>, 'commit'>;
	missedReveal: Pick<MissedRevealStore, 'value'>;
	/**
	 * Whether the player could actually take a turn.
	 *
	 * The same gate a click passes through in `context/game.ts`, and for the same
	 * reason: letting someone plan a whole turn they cannot commit is worse than
	 * not letting them start, because the failure only arrives when the round is
	 * already closing.
	 */
	readyToPlay: Readable<boolean>;
}): Controls {
	const {planning, round, missedReveal, readyToPlay} = params;

	function handle(intent: ControlIntent) {
		if (!get(readyToPlay)) return;

		switch (intent.type) {
			case 'direction':
				planning.stepBy(STEP[intent.direction]);
				return;
			case 'secondary':
				// LEAVING THE WORLD. The one action with no pointer equivalent: a
				// click names a cell, and "leave" names none. It is undoable until
				// the round commits, which is what makes it safe to put on a key.
				planning.exitAt();
				return;
			case 'cancel':
				planning.undo();
				return;
			case 'confirm':
				// Send the round now rather than waiting for the phase to close.
				// Refused while an unrevealed commitment is in the way, which is the
				// one condition `round.commit()` cannot see for itself: it would send
				// a commitment the contract rejects with
				// `PreviousCommitmentNotRevealed`, spending gas to be told no and
				// leaving the round in an error state the player did not cause.
				if (blocksCommitting(missedReveal.value)) return;
				void round.commit();
				return;
		}
	}

	function listen(options: Parameters<Controls['listen']>[0] = {}) {
		const target =
			options.target ??
			(typeof document === 'undefined' ? undefined : document);
		const detachKeys = target
			? attachKeys(target, handle, options.keys)
			: () => {};
		const detachGamepad = attachGamepad(handle, options.gamepad);
		return () => {
			detachKeys();
			detachGamepad();
		};
	}

	return {handle, listen};
}
