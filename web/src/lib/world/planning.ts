/**
 * Turning clicks into a plan.
 *
 * The plan itself lives in the framework's round (it is what gets hashed, and
 * it has to survive a reload), so this keeps no second copy. It only translates
 * "the player clicked here" into a new list of actions, and exposes that list
 * in the shape the view merge wants.
 *
 * The rules below are the CONTRACT'S rules, mirrored. That is the whole point
 * of doing it here: `_move` refusing a step sets `stopProcessing`, which drops
 * every remaining action in the same reveal, so one bad step planned by mistake
 * silently discards the rest of the turn and tells the player nothing. Refusing
 * to plan it is the only place that can be prevented.
 */
import {derived, type Readable} from 'svelte/store';
import type {RoundState, RoundStore} from '$lib/game/core/round';
import {
	isObstacle,
	isValidMove,
	bigIntIDToXY,
	xyToBigIntID,
	ActionType,
	type Position,
} from 'reveal-or-die-contracts';
import type {Action} from './commit-reveal';
import type {LocalPlan, PlannedAction} from './view';
import type {WorldConfig} from './config';

/** The plan is only changeable while the round has not been committed. */
export function isPlannable(state: RoundState<Action>): boolean {
	return (
		state.step === 'Idle' ||
		state.step === 'Planning' ||
		state.step === 'Revealed' ||
		state.step === 'Missed' ||
		(state.step === 'Error' && state.during === 'commit')
	);
}

function actionsOf(state: RoundState<Action>): Action[] {
	if (!('actions' in state)) return [];
	return [...state.actions];
}

const typeName = (actionType: number): PlannedAction['type'] =>
	actionType === ActionType.Enter
		? 'enter'
		: actionType === ActionType.Exit
			? 'exit'
			: 'move';

/** The contract's actions, in the shape the view and the renderer read. */
export function toPlannedActions(actions: readonly Action[]): PlannedAction[] {
	return actions.map((a) => ({
		type: typeName(a.actionType),
		to: bigIntIDToXY(a.data),
	}));
}

export type PlanningStore = {
	/** What the player has planned, for the view merge. */
	plan: Readable<LocalPlan>;
	/** Whether clicks currently change anything. */
	canPlan: Readable<boolean>;
	/** Moves still available this turn. */
	movesLeft: Readable<number>;
	/**
	 * Choose where to appear. Only meaningful for an avatar that is not in the
	 * world, and it is the WHOLE plan: `_enter` sets `stopProcessing`, so an
	 * Enter ends the reveal and anything planned after it would be discarded.
	 */
	enterAt(position: Position): boolean;
	/** Append one step. Must be adjacent to where the plan currently ends. */
	stepTo(position: Position): boolean;
	/** Take back the last step. */
	undo(): void;
	clear(): void;
};

export function createPlanning(params: {
	round: RoundStore<bigint, Action>;
	config: WorldConfig;
	/** Where the avatar stands on chain; undefined when it is not in the world. */
	currentPosition: Readable<Position | undefined>;
	activeAvatarID: Readable<bigint | undefined>;
	player: Readable<`0x${string}` | undefined>;
}): PlanningStore {
	const {round, config, currentPosition, activeAvatarID, player} = params;

	const plannedStore = derived(round, ($round) => actionsOf($round));

	const plan = derived(
		[plannedStore, activeAvatarID, player],
		([$planned, $avatarID, $player]): LocalPlan => ({
			activeAvatarID: $avatarID,
			player: $player,
			planned: toPlannedActions($planned),
		}),
	);

	const canPlan = derived(round, ($round) => isPlannable($round));

	const movesLeft = derived(plannedStore, ($planned) => {
		const moves = $planned.filter(
			(a) => a.actionType === ActionType.Move,
		).length;
		return Math.max(0, config.numMoves - moves);
	});

	/** Where the plan currently ends: the last planned step, else where it stands. */
	function planEnd(
		planned: readonly Action[],
		onchain: Position | undefined,
	): Position | undefined {
		const last = planned[planned.length - 1];
		if (last) return bigIntIDToXY(last.data);
		return onchain;
	}

	function currentPlan() {
		return actionsOf(round.value);
	}

	function enterAt(position: Position): boolean {
		if (!isPlannable(round.value)) return false;

		let onchain: Position | undefined;
		currentPosition.subscribe((v) => (onchain = v))();
		// Already in the world: entering again is not a move it can make.
		if (onchain !== undefined) return false;

		// The contract does NOT check this (`_enter` carries a `TODO check valid
		// entry`), so an avatar can be spawned inside a wall and then find every
		// neighbour unwalkable. Refused here rather than relied on there.
		if (isObstacle(position.x, position.y)) return false;

		round.plan([
			{actionType: ActionType.Enter, data: xyToBigIntID(position.x, position.y)},
		]);
		return true;
	}

	function stepTo(position: Position): boolean {
		if (!isPlannable(round.value)) return false;

		const planned = currentPlan();
		// An Enter ends the reveal, so nothing can follow it.
		if (planned.some((a) => a.actionType === ActionType.Enter)) return false;

		const moves = planned.filter(
			(a) => a.actionType === ActionType.Move,
		).length;
		if (moves >= config.numMoves) return false;

		let onchain: Position | undefined;
		currentPosition.subscribe((v) => (onchain = v))();
		const from = planEnd(planned, onchain);
		if (!from) return false;

		if (!isValidMove(from, position)) return false;

		round.plan([
			...planned,
			{actionType: ActionType.Move, data: xyToBigIntID(position.x, position.y)},
		]);
		return true;
	}

	function undo() {
		if (!isPlannable(round.value)) return;
		const planned = currentPlan();
		if (planned.length === 0) return;
		round.plan(planned.slice(0, -1));
	}

	function clear() {
		if (!isPlannable(round.value)) return;
		round.plan([]);
	}

	return {plan, canPlan, movesLeft, enterAt, stepTo, undo, clear};
}
