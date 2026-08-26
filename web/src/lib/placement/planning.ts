/**
 * Turning clicks into a plan.
 *
 * The plan itself lives in the framework's round (it is what gets hashed, and
 * it has to survive a reload), so this does not keep a second copy. It only
 * translates "the player clicked cell X" into a new list of placements, and
 * exposes that list in the shape the view merge wants.
 *
 * Deliberately plain TypeScript with Svelte stores at the boundary: components
 * import this rather than doing any of it themselves.
 */
import {derived, type Readable} from 'svelte/store';
import type {RoundState, RoundStore} from '$lib/game/core/round';
import type {Placement} from './commit-reveal';
import type {LocalPlan} from './view';

/** The plan is only changeable while the round has not been committed. */
export function isPlannable(state: RoundState<Placement>): boolean {
	return (
		state.step === 'Idle' ||
		state.step === 'Planning' ||
		state.step === 'Revealed' ||
		state.step === 'Missed' ||
		(state.step === 'Error' && state.during === 'commit')
	);
}

function plannedCellsOf(state: RoundState<Placement>): bigint[] {
	if (!('actions' in state)) return [];
	return state.actions.map((placement) => placement.cellID);
}

export type PlanningStore = {
	/** What the player has planned, for the view merge. */
	plan: Readable<LocalPlan>;
	/** Whether clicks currently change anything. */
	canPlan: Readable<boolean>;
	/** How many placements are planned (what the round will cost). */
	count: Readable<number>;
	/** Add the cell to the plan, or take it out if it is already there. */
	toggle(cellID: bigint): void;
	clear(): void;
};

export function createPlanning(params: {
	round: RoundStore<`0x${string}`, Placement>;
}): PlanningStore {
	const {round} = params;

	const plannedStore = derived(round, ($round) => plannedCellsOf($round));

	const plan = derived(plannedStore, ($planned): LocalPlan => ({
		planned: $planned,
	}));

	const canPlan = derived(round, ($round) => isPlannable($round));

	const count = derived(plannedStore, ($planned) => $planned.length);

	function toggle(cellID: bigint) {
		if (!isPlannable(round.value)) return;

		const current = plannedCellsOf(round.value);
		const without = current.filter((id) => id !== cellID);

		if (without.length !== current.length) {
			// Already planned: a second click takes it back off. Toggling matters
			// more here than in a normal UI, because every placement costs stake
			// and a mis-click that could not be undone would cost real tokens.
			round.plan(without.map((id) => ({cellID: id})));
			return;
		}

		round.plan([...current, cellID].map((id) => ({cellID: id})));
	}

	function clear() {
		if (!isPlannable(round.value)) return;
		round.plan([]);
	}

	return {plan, canPlan, count, toggle, clear};
}
