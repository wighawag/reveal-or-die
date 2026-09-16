/**
 * Keeping the player's own turn on screen until the board takes it over.
 *
 * A turn is drawn twice, by two different things, and the handover between
 * them used to have a hole in it several seconds wide.
 *
 * BEFORE the cycle resolves, what the player sees is LOCAL INTENT: the planned
 * dots, the ring on the cell they will leave from, and - for an avatar that is
 * not in the world yet - the entering preview, an entity `mergeWorldView`
 * invents because there is nothing on chain behind it. All of that comes from
 * the submission's own actions (`world/planning.ts`).
 *
 * AFTER the cycle resolves, the same turn is drawn from the BOARD: the avatar
 * stands where the chain says, and `AvatarObject` replays the accepted path.
 *
 * The hole is that the two changed hands at different moments. The submission DROPS
 * its actions the instant it reaches `Revealed`, so the local overlay vanished
 * as soon as the reveal transaction landed - while the board's version of the
 * same turn is deliberately held back until the cycle is over
 * (`world/hold.ts`, and holding it is the whole reason reveals are not drawn in
 * the order they were paid for). Between those two moments the player was
 * shown neither: the planned path disappeared while their avatar sat at its old
 * cell, and a player who had planned an ENTRY watched their avatar disappear
 * completely for the rest of the reveal window, because the entering preview is
 * the only thing drawing it and the real one is being withheld on purpose.
 *
 * So the display copy of the plan survives until the board RELEASES, and the
 * release is the board's own signal rather than a second guess at when it
 * happens - see `HeldBoard.holding`. Two computations of "roughly now" would
 * disagree by a frame or a poll and reproduce exactly this bug.
 *
 * FOR DISPLAY ONLY. Nothing that CONTROLS a turn reads this: the HUD's planned
 * count, its Undo and Clear buttons, `movesLeft` and every affordance in
 * `world/controls.ts` keep reading the submission, because once a turn is committed
 * there is nothing left to undo and a held display copy must not make the HUD
 * offer it.
 *
 * THE MEMORY IS THE FRAMEWORK'S. The submission dropping its actions at `Revealed`
 * is a fact about the submission, so `game/core/handover.ts` owns remembering the
 * turn and deciding the moment - the same moment the board releases on, which
 * is the whole point. What is left here is this game's half: what a remembered
 * turn LOOKS like on this board.
 */
import {derived, type Readable} from 'svelte/store';
import type {SubmissionState} from '$lib/game/core/submission';
import {heldTurnUntilBoardReleases} from '$lib/game/core/handover';
import type {Action} from './commit-reveal';
import {toPlannedActions, type LocalPlan} from './view';

export function holdPlanUntilBoardReleases(params: {
	/** The submission, which carries the actions up to `Revealing`, not after. */
	submission: Readable<SubmissionState<Action>>;
	/** The live plan: what is drawn whenever the submission still has it. */
	plan: Readable<LocalPlan>;
	/**
	 * Which cycle the board is holding back, from the board itself.
	 *
	 * `undefined` is the release, and it is the ONE moment both halves of the
	 * handover turn on.
	 */
	holding: Readable<number | undefined>;
}): Readable<LocalPlan> {
	const held = heldTurnUntilBoardReleases({
		submission: params.submission,
		holding: params.holding,
	});

	return derived([params.plan, held], ([$plan, $held]): LocalPlan =>
		$held === undefined ? $plan : {...$plan, planned: toPlannedActions($held)},
	);
}
