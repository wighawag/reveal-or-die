/**
 * Turning clicks into a plan.
 *
 * The plan itself lives in the framework's submission (it is what gets hashed,
 * and it has to survive a reload), so this does not keep a second copy. It only
 * translates "the player clicked cell X" into a new list of placements, and
 * exposes that list in the shape the view merge wants.
 *
 * Deliberately plain TypeScript with Svelte stores at the boundary: components
 * import this rather than doing any of it themselves.
 */
import {derived, type Readable} from 'svelte/store';
import type {SubmissionState, SubmissionStore} from '$lib/game/core/submission';
import type {GameIdentity} from '$lib/game/identity';
import type {Placement} from './commit-reveal';
import type {LocalPlan} from './view';

/** The plan is only changeable while the submission has not been committed. */
export function isPlannable(state: SubmissionState<Placement>): boolean {
	return (
		state.step === 'Idle' ||
		state.step === 'Planning' ||
		state.step === 'Revealed' ||
		state.step === 'Missed' ||
		(state.step === 'Error' && state.during === 'commit')
	);
}

function plannedCellsOf(state: SubmissionState<Placement>): bigint[] {
	if (!('actions' in state)) return [];
	return state.actions.map((placement) => placement.cellID);
}

export type PlanningStore = {
	/** What the player has planned, for the view merge. */
	plan: Readable<LocalPlan>;
	/**
	 * The same, in the shape the contract is committed to.
	 *
	 * Exposed because recovering a lost submission offers the planned turn as a
	 * CANDIDATE for a commitment the chain already holds, and the component that
	 * offers it must not be the thing that converts cell ids into placements.
	 */
	actions: Readable<readonly Placement[]>;
	/** Whether clicks currently change anything. */
	canPlan: Readable<boolean>;
	/** How many placements are planned (what the submission will cost). */
	count: Readable<number>;
	/** Add the cell to the plan, or take it out if it is already there. */
	toggle(cellID: bigint): void;
	clear(): void;
};

export function createPlanning(params: {
	submission: SubmissionStore<GameIdentity, Placement>;
}): PlanningStore {
	const {submission} = params;

	const plannedStore = derived(submission, ($submission) =>
		plannedCellsOf($submission),
	);

	const plan = derived(plannedStore, ($planned): LocalPlan => ({
		planned: $planned,
	}));

	const actions = derived(plannedStore, ($planned): readonly Placement[] =>
		$planned.map((cellID) => ({cellID})),
	);

	const canPlan = derived(submission, ($submission) =>
		isPlannable($submission),
	);

	const count = derived(plannedStore, ($planned) => $planned.length);

	function toggle(cellID: bigint) {
		if (!isPlannable(submission.value)) return;

		const current = plannedCellsOf(submission.value);
		const without = current.filter((id) => id !== cellID);

		if (without.length !== current.length) {
			// Already planned: a second click takes it back off. Toggling matters
			// more here than in a normal UI, because every placement costs stake
			// and a mis-click that could not be undone would cost real tokens.
			submission.plan(without.map((id) => ({cellID: id})));
			return;
		}

		submission.plan([...current, cellID].map((id) => ({cellID: id})));
	}

	function clear() {
		if (!isPlannable(submission.value)) return;
		submission.plan([]);
	}

	return {plan, actions, canPlan, count, toggle, clear};
}
