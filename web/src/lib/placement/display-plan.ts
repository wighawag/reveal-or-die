/**
 * Keeping the player's own turn on screen until the board takes it over.
 *
 * The framework decides WHEN (`game/core/handover.ts`), and it decides it once
 * for both halves of the handover, which is the only way the two can be
 * guaranteed to agree. This is the game's half: what a remembered turn LOOKS
 * like on this board.
 *
 * BEFORE the submission resolves the planned cells are drawn from the
 * submission's own actions. AFTER it resolves they are drawn from the board,
 * which is holding them back until every reveal has landed (`./hold.ts`). The
 * submission drops its actions the moment it reaches `Revealed`, so without
 * this the planned markers vanish while the board still shows the cells
 * unclaimed, and a player who placed on an EMPTY cell watches their placement
 * disappear completely for the rest of the reveal window - the planned marker
 * is the only thing drawing it, and the confirmed one is being withheld on
 * purpose.
 *
 * FOR DISPLAY ONLY. The HUD's planned count, its Clear button and everything
 * else that acts on a turn keep reading the submission, because once a turn is
 * committed there is nothing left to undo.
 */
import {derived, type Readable} from 'svelte/store';
import type {SubmissionState} from '$lib/game/core/submission';
import {heldTurnUntilBoardReleases} from '$lib/game/core/handover';
import type {Placement} from './commit-reveal';
import type {LocalPlan} from './view';

export function holdPlanUntilBoardReleases(params: {
	/**
	 * The submission, which carries the actions up to `Revealing` and not after.
	 */
	submission: Readable<SubmissionState<Placement>>;
	/** The live plan: what is drawn whenever the submission still has it. */
	plan: Readable<LocalPlan>;
	/** Which cycle the board is holding back, from the board itself. */
	holding: Readable<number | undefined>;
}): Readable<LocalPlan> {
	const held = heldTurnUntilBoardReleases({
		submission: params.submission,
		holding: params.holding,
	});

	return derived([params.plan, held], ([$plan, $held]): LocalPlan =>
		$held === undefined ? $plan : {planned: $held.map(({cellID}) => cellID)},
	);
}
