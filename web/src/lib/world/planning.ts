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
	cellTypeAt,
	CellType,
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

/**
 * Actions the reveal stops at, so nothing may be planned after one.
 *
 * `_enter` and `_exit` both set `stopProcessing`, and the loop in
 * `_forEachActions` breaks on it. Anything planned behind either is therefore
 * discarded on chain with no error and no event: the turn simply does less than
 * the player watched themselves plan. Refusing to plan it is the only place
 * that can be prevented.
 */
function endsTheTurn(action: Action): boolean {
	return (
		action.actionType === ActionType.Enter ||
		action.actionType === ActionType.Exit
	);
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
	/**
	 * The same step, named as a direction rather than a destination.
	 *
	 * For input that says WHICH WAY rather than WHERE: a key, a d-pad, a stick.
	 * Resolved against the end of the plan here rather than by the caller,
	 * because where the plan ends is this module's own bookkeeping and a second
	 * copy of it would be a second answer.
	 *
	 * `y` grows DOWNWARDS, as it does on the board and in every position the
	 * contract stores, so north is `{x: 0, y: -1}`.
	 */
	stepBy(delta: Position): boolean;
	/**
	 * Whether leaving is possible right now: the affordance's own answer.
	 *
	 * Exposed rather than left to each caller, because "can this avatar leave"
	 * has to be asked in two places - the button that offers it and the function
	 * that does it - and two copies of a rule is how a button offers something
	 * the action then refuses.
	 */
	canExit: Readable<boolean>;
	/**
	 * Leave the world, from wherever the plan ends up.
	 *
	 * Ends the turn, like an Enter and for the same reason: `_exit` sets
	 * `stopProcessing`, so anything planned after it is silently dropped by the
	 * reveal. Unlike an Enter it may FOLLOW moves, which the contract resolves in
	 * order before it, so walking to the exit and leaving from it is one turn.
	 *
	 * ONLY FROM THE EXIT TILE, which is now the contract's rule as well as this
	 * one: `_exit` reads the cell the avatar is standing on and drops the action
	 * unless it is `CELL_EXIT`. It was neither for a while - the tile was drawn
	 * and leaving worked anywhere - and this mirrors the chain rather than
	 * leading it. `contracts/test/js/Game.test.ts` pins both sides.
	 */
	exitAt(): boolean;
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

	/**
	 * Whether an Exit could be planned right now, and the ONE statement of the
	 * rule: `exitAt` acts on it and `canExit` renders it.
	 *
	 * Every clause mirrors the contract. Nothing may follow an Enter or an Exit
	 * (both set `stopProcessing`); an avatar out of the world has nothing to
	 * leave, and `_exit` refuses that too because setting `left` for one would
	 * make `_removeFromZone` evict another player; and leaving happens on the
	 * EXIT TILE, which `_exit` now reads off the cell the avatar is standing on.
	 */
	function exitAllowed(
		state: RoundState<Action>,
		planned: readonly Action[],
		onchain: Position | undefined,
	): Position | undefined {
		if (!isPlannable(state)) return undefined;
		if (planned.some(endsTheTurn)) return undefined;
		if (onchain === undefined) return undefined;
		// Where the avatar will be STANDING when the exit resolves, which is the
		// end of the plan rather than where it is now: the contract runs the moves
		// ahead of it first and then reads the cell under it.
		const from = planEnd(planned, onchain);
		if (!from) return undefined;
		if (cellTypeAt(from.x, from.y) !== CellType.Exit) return undefined;
		return from;
	}

	const canExit = derived(
		[round, plannedStore, currentPosition],
		([$round, $planned, $onchain]) =>
			exitAllowed($round, $planned, $onchain) !== undefined,
	);

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
			{
				actionType: ActionType.Enter,
				data: xyToBigIntID(position.x, position.y),
			},
		]);
		return true;
	}

	function stepTo(position: Position): boolean {
		if (!isPlannable(round.value)) return false;

		const planned = currentPlan();
		// An Enter or an Exit ends the reveal, so nothing can follow either.
		if (planned.some(endsTheTurn)) return false;

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

	function stepBy(delta: Position): boolean {
		const planned = currentPlan();
		let onchain: Position | undefined;
		currentPosition.subscribe((v) => (onchain = v))();
		const from = planEnd(planned, onchain);
		// Nothing to step FROM: an avatar out of the world has no position for a
		// direction to be relative to. Where it appears is chosen by pointing at a
		// cell, which is `enterAt`.
		if (!from) return false;
		return stepTo({x: from.x + delta.x, y: from.y + delta.y});
	}

	function exitAt(): boolean {
		const planned = currentPlan();
		let onchain: Position | undefined;
		currentPosition.subscribe((v) => (onchain = v))();

		const from = exitAllowed(round.value, planned, onchain);
		if (!from) return false;

		// The position is carried for DISPLAY only: `_exit` ignores its action data
		// entirely and reads the cell under the avatar instead. It is what lets the
		// renderer draw the exit marker on the cell the turn ends at.
		round.plan([
			...planned,
			{actionType: ActionType.Exit, data: xyToBigIntID(from.x, from.y)},
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

	return {
		plan,
		canPlan,
		movesLeft,
		canExit,
		enterAt,
		stepTo,
		stepBy,
		exitAt,
		undo,
		clear,
	};
}
