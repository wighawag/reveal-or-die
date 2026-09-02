/**
 * Keeping the player's own turn on screen until the board takes it over.
 *
 * A turn is drawn twice, by two different things, and the handover between
 * them used to have a hole in it several seconds wide.
 *
 * BEFORE the round resolves, what the player sees is LOCAL INTENT: the planned
 * dots, the ring on the cell they will leave from, and - for an avatar that is
 * not in the world yet - the entering preview, an entity `mergeWorldView`
 * invents because there is nothing on chain behind it. All of that comes from
 * the round's own actions (`world/planning.ts`).
 *
 * AFTER the round resolves, the same turn is drawn from the BOARD: the avatar
 * stands where the chain says, and `AvatarObject` replays the accepted path.
 *
 * The hole is that the two changed hands at different moments. The round DROPS
 * its actions the instant it reaches `Revealed`, so the local overlay vanished
 * as soon as the reveal transaction landed - while the board's version of the
 * same turn is deliberately held back until the round is over
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
 * `world/controls.ts` keep reading the round, because once a turn is committed
 * there is nothing left to undo and a held display copy must not make the HUD
 * offer it.
 *
 * It REMEMBERS, which is why it lives here and is wired in the context rather
 * than built inside a component: the actions it hands back are ones the round
 * no longer carries, so whatever answers has to have been watching. Same shape
 * and same reason as `world/reveal-outcome.ts`.
 */
import {derived, type Readable} from 'svelte/store';
import type {RoundState} from '$lib/game/core/round';
import type {Action} from './commit-reveal';
import {toPlannedActions, type LocalPlan, type PlannedAction} from './view';

export function holdPlanUntilBoardReleases(params: {
	/** The round, which carries the actions up to `Revealing` and not after. */
	round: Readable<RoundState<Action>>;
	/** The live plan: what is drawn whenever the round still has it. */
	plan: Readable<LocalPlan>;
	/**
	 * Which round the board is holding back, from the board itself.
	 *
	 * `undefined` is the release, and it is the ONE moment both halves of the
	 * handover turn on.
	 */
	holding: Readable<number | undefined>;
}): Readable<LocalPlan> {
	const {round, plan, holding} = params;

	/** The last turn the round carried, and which round it was. */
	let last: {epoch: number; planned: readonly PlannedAction[]} | undefined;

	return derived(
		[round, plan, holding],
		([$round, $plan, $holding]): LocalPlan => {
			// Every step up to and including `Revealing` carries the actions; the
			// `Revealed` that follows does not. THE LAST ONE WINS, empty included: a
			// player who plans a path and then clears it has planned nothing, and a
			// memory that only took non-empty turns would redraw the path they
			// deleted for the whole of the round the empty turn resolves in.
			if ('actions' in $round) {
				last = {epoch: $round.epoch, planned: toPlannedActions($round.actions)};
			}

			// The board is showing everything it has, so there is nothing to bridge:
			// what the round says is what gets drawn, including nothing at all.
			if ($holding === undefined) return $plan;
			// MATCHED BY EPOCH rather than merely taken when present: a turn
			// remembered from an earlier round must not be resurrected over a round
			// in which the player planned nothing at all.
			if (last?.epoch !== $holding) return $plan;
			// THE MEMORY, even while the live plan still has the same actions in it.
			// It is never staler: the plan is derived FROM the round, so a re-derive
			// triggered by the round changing sees the new round beside the previous
			// plan, and taking the plan there would draw one frame of a turn that has
			// already moved on.
			return {...$plan, planned: last.planned};
		},
	);
}
