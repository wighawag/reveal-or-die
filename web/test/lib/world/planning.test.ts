import {describe, expect, it} from 'vitest';
import {get, writable, type Readable} from 'svelte/store';
import {createPlanning} from '$lib/world/planning';
import type {WorldConfig} from '$lib/world/config';
import type {Action} from '$lib/world/commit-reveal';
import type {RoundState, RoundStore} from '$lib/game/core/round';
import {
	ActionType,
	bigIntIDToXY,
	xyToBigIntID,
	type Position,
} from 'reveal-or-die-contracts';

/**
 * The walkable neighbourhood used throughout, taken from the single generated
 * area and pinned against the chain by
 * `contracts/test/js/Game.test.ts > agrees with the contract about what can be
 * stood on`:
 *
 * The neighbourhood, `#` unwalkable, columns x=-2..3:
 *
 *   y=0   .###.#
 *   y=1   .....#
 *   y=2   .#.#.#
 *   y=3   ......
 *   y=4   ######
 *
 * So (0,0) is an obstacle, (0,1) (0,2) (0,3) form a corridor north to south,
 * and it turns east at y=3 because y=4 is solid.
 *
 * The area's ONE exit tile is at (3,5). Its neighbourhood, columns x=2..5:
 *
 *   y=4   x#.#
 *   y=5   x!..
 *   y=6   x#.#
 *
 * so it is walled north and south, boxed to the west, and reached from the
 * east at (4,5). That single approach is what the "walk to it and leave" tests
 * below use.
 */
const START: Position = {x: 0, y: 1};
/** The way out. `_exit` accepts an exit from here and from nowhere else. */
const EXIT: Position = {x: 3, y: 5};
/** The only cell an avatar can step onto the exit from. */
const BESIDE_EXIT: Position = {x: 4, y: 5};

function fakeRound(initial: Action[] = []) {
	const state = writable<RoundState<Action>>({
		step: 'Planning',
		epoch: 1,
		actions: initial,
	} as RoundState<Action>);
	let value: RoundState<Action> = get(state);
	state.subscribe((v) => (value = v));

	const round = {
		subscribe: state.subscribe,
		get value() {
			return value;
		},
		plan(actions: readonly Action[]) {
			state.set({
				step: 'Planning',
				epoch: 1,
				actions: [...actions],
			} as RoundState<Action>);
		},
		commit: async () => {},
		reveal: async () => {},
		dismiss: () => {},
		start: () => () => {},
	} as unknown as RoundStore<bigint, Action>;

	return {round, state};
}

const config = {numMoves: 3} as WorldConfig;

function setup(opts: {at?: Position; actions?: Action[]} = {}) {
	const {round, state} = fakeRound(opts.actions ?? []);
	const currentPosition: Readable<Position | undefined> = writable(
		'at' in opts ? opts.at : START,
	);
	const planning = createPlanning({
		round,
		config,
		currentPosition,
		activeAvatarID: writable(7n),
		player: writable('0x1111111111111111111111111111111111111111'),
	});
	return {planning, round, state};
}

const positionsOf = (actions: readonly Action[]) =>
	actions.map((a) => bigIntIDToXY(a.data));

describe('planning: entering', () => {
	it('plans an entry for an avatar that is not in the world', () => {
		const {planning, round} = setup({at: undefined});
		expect(planning.enterAt({x: 0, y: 1})).toBe(true);
		const actions = (round.value as unknown as {actions: Action[]}).actions;
		expect(actions).toHaveLength(1);
		expect(actions[0].actionType).toEqual(ActionType.Enter);
	});

	it('refuses to spawn inside a wall, which the contract would allow', () => {
		// `_enter` carries a `TODO check valid entry` and does NOT check, so an
		// avatar can be spawned into an obstacle and find every neighbour
		// unwalkable. This is the only place that can prevent it.
		const {planning} = setup({at: undefined});
		expect(planning.enterAt({x: 0, y: 0})).toBe(false);
	});

	it('refuses to enter when the avatar is already in the world', () => {
		const {planning} = setup({at: START});
		expect(planning.enterAt({x: 0, y: 2})).toBe(false);
	});
});

describe('planning: stepping', () => {
	it('appends an adjacent, walkable step', () => {
		const {planning, round} = setup();
		expect(planning.stepTo({x: 0, y: 2})).toBe(true);
		expect(
			positionsOf((round.value as unknown as {actions: Action[]}).actions),
		).toEqual([{x: 0, y: 2}]);
	});

	it('chains steps from where the PLAN ends, not from where the avatar is', () => {
		const {planning, round} = setup();
		expect(planning.stepTo({x: 0, y: 2})).toBe(true);
		expect(planning.stepTo({x: 0, y: 3})).toBe(true);
		expect(
			positionsOf((round.value as unknown as {actions: Action[]}).actions),
		).toEqual([
			{x: 0, y: 2},
			{x: 0, y: 3},
		]);
	});

	it('refuses a step that is not orthogonally adjacent', () => {
		const {planning} = setup();
		expect(planning.stepTo({x: 1, y: 2})).toBe(false); // diagonal
		expect(planning.stepTo({x: 0, y: 3})).toBe(false); // two away
	});

	it('refuses a step onto an obstacle', () => {
		// this is the one that matters: the contract would reject it and then DROP
		// every remaining action in the same reveal
		const {planning} = setup();
		expect(planning.stepTo({x: 0, y: 0})).toBe(false);
	});

	it('refuses to step past the move allowance', () => {
		const {planning, round} = setup();
		// down the corridor and then east, because y=4 is solid
		expect(planning.stepTo({x: 0, y: 2})).toBe(true);
		expect(planning.stepTo({x: 0, y: 3})).toBe(true);
		expect(planning.stepTo({x: 1, y: 3})).toBe(true);
		expect(get(planning.movesLeft)).toEqual(0);
		// numMoves is 3, and the contract silently ignores the rest
		expect(planning.stepTo({x: 2, y: 3})).toBe(false);
		expect(
			(round.value as unknown as {actions: Action[]}).actions,
		).toHaveLength(3);
	});

	it('refuses to step after an entry, which ends the reveal', () => {
		// `_enter` sets stopProcessing, so anything planned after it is discarded
		const {planning} = setup({at: undefined});
		expect(planning.enterAt({x: 0, y: 1})).toBe(true);
		expect(planning.stepTo({x: 0, y: 2})).toBe(false);
	});

	it('refuses to step when the avatar is not in the world', () => {
		const {planning} = setup({at: undefined});
		expect(planning.stepTo({x: 0, y: 2})).toBe(false);
	});
});

describe('planning: stepping by direction', () => {
	/**
	 * The same rule as `stepTo`, reached the way a key or a d-pad reaches it.
	 * Worth its own tests only because of the one thing it decides on its own:
	 * WHERE the direction is measured from.
	 */
	it('steps from the end of the plan, not from where the avatar stands', () => {
		const {planning, round} = setup();
		// START is (0,1); south twice down the corridor.
		expect(planning.stepBy({x: 0, y: 1})).toBe(true);
		expect(planning.stepBy({x: 0, y: 1})).toBe(true);
		expect(
			positionsOf((round.value as unknown as {actions: Action[]}).actions),
		).toEqual([
			{x: 0, y: 2},
			{x: 0, y: 3},
		]);
	});

	it('treats a negative y as north, which is how the board is stored', () => {
		// (0,0) is a wall, so north from START is refused rather than planned. That
		// IS the assertion: a direction that flipped the sign would step to (0,2),
		// which is legal, and nothing else here would notice.
		const {planning, round} = setup();
		expect(planning.stepBy({x: 0, y: -1})).toBe(false);
		expect(
			(round.value as unknown as {actions: Action[]}).actions,
		).toHaveLength(0);
	});

	it('refuses a direction when the avatar is not in the world', () => {
		const {planning} = setup({at: undefined});
		expect(planning.stepBy({x: 0, y: 1})).toBe(false);
	});
});

describe('planning: leaving the world', () => {
	it('plans an exit from the exit tile the avatar stands on', () => {
		const {planning, round} = setup({at: EXIT});
		expect(planning.exitAt()).toBe(true);
		const actions = (round.value as unknown as {actions: Action[]}).actions;
		expect(actions).toHaveLength(1);
		expect(actions[0].actionType).toEqual(ActionType.Exit);
		expect(bigIntIDToXY(actions[0].data)).toEqual(EXIT);
	});

	it('plans an exit from where the MOVES end, not from where they started', () => {
		// `_exit` resolves after the moves ahead of it and reads the cell UNDER
		// the avatar at that point, so the plan end is what decides both whether
		// the exit is legal and where it happens. Judged from the starting cell,
		// this walk onto the exit would be refused, and the marker would be drawn
		// on the wrong square.
		const {planning, round} = setup({at: BESIDE_EXIT});
		expect(planning.stepTo(EXIT)).toBe(true);
		expect(planning.exitAt()).toBe(true);
		const actions = (round.value as unknown as {actions: Action[]}).actions;
		expect(actions).toHaveLength(2);
		expect(bigIntIDToXY(actions[1].data)).toEqual(EXIT);
	});

	it('refuses an exit from a cell that is not the exit tile', () => {
		// The rule the map has been drawing all along and the contract did not
		// have: `_exit` ignored its action data and set `left` unconditionally, so
		// leaving worked from anywhere and the one goal on the board was
		// decoration. Now `_exit` reads the cell the avatar stands on, and this
		// mirrors it. START is plain floor.
		const {planning} = setup();
		expect(planning.exitAt()).toBe(false);
	});

	it('refuses an exit planned to end beside the way out, rather than on it', () => {
		// The off-by-one that a rule read from the wrong cell would produce: the
		// plan ends NEXT to the exit, which the contract would refuse, dropping
		// the action and leaving the avatar standing there wondering.
		const {planning} = setup({at: EXIT});
		expect(planning.stepTo(BESIDE_EXIT)).toBe(true);
		expect(planning.exitAt()).toBe(false);
	});

	it('refuses to exit when the avatar is not in the world', () => {
		// Not merely pointless: `_exit` used to set `left` for it, and
		// `_resolveActions` then called `_removeFromZone` for an avatar that is not
		// in that zone's list, popping whoever is. Both sides refuse it now.
		const {planning} = setup({at: undefined});
		expect(planning.exitAt()).toBe(false);
	});

	it('refuses to exit while the position is still UNKNOWN, plan or no plan', () => {
		// The case the check above cannot reach on its own, and the one that
		// actually happens: on a reload the round comes back from storage with its
		// moves intact, while `currentPosition` is undefined until the account's
		// avatars have been read. The plan then has an end, so an exit built from
		// the plan alone looks perfectly valid, and would be committed for an
		// avatar nobody has yet confirmed is in the world.
		const {planning} = setup({
			at: undefined,
			actions: [{actionType: ActionType.Move, data: xyToBigIntID(3, 5)}],
		});
		expect(planning.exitAt()).toBe(false);
	});

	it('refuses to exit in the same turn as an entry', () => {
		// Even an entry ONTO the exit tile: `_enter` sets `stopProcessing`, so the
		// exit behind it would be dropped by the reveal without a word.
		const {planning} = setup({at: undefined});
		expect(planning.enterAt(EXIT)).toBe(true);
		expect(planning.exitAt()).toBe(false);
	});

	it('refuses a second exit', () => {
		const {planning, round} = setup({at: EXIT});
		expect(planning.exitAt()).toBe(true);
		expect(planning.exitAt()).toBe(false);
		expect(
			(round.value as unknown as {actions: Action[]}).actions,
		).toHaveLength(1);
	});

	it('refuses to step after an exit, which ends the reveal', () => {
		// The same rule as after an entry, and the one that costs the player most:
		// the steps would be dropped by the reveal without a word, and the avatar
		// would leave from where it was standing rather than from where they walked
		// it to.
		const {planning} = setup({at: EXIT});
		expect(planning.exitAt()).toBe(true);
		expect(planning.stepTo(BESIDE_EXIT)).toBe(false);
		expect(planning.stepBy({x: 1, y: 0})).toBe(false);
	});

	it('reports the exit to the view, so it can be drawn', () => {
		const {planning} = setup({at: BESIDE_EXIT});
		planning.stepTo(EXIT);
		planning.exitAt();
		expect(get(planning.plan).planned).toEqual([
			{type: 'move', to: EXIT},
			{type: 'exit', to: EXIT},
		]);
	});

	it('refuses to exit once the round is no longer plannable', () => {
		const {planning, state} = setup({at: EXIT});
		state.set({step: 'Committed'} as unknown as RoundState<Action>);
		expect(planning.exitAt()).toBe(false);
	});
});

describe('planning: whether leaving is offered at all', () => {
	/**
	 * `canExit` and `exitAt` answer the same question, and they have to: the
	 * button that offers leaving reads the first and the press calls the second,
	 * so two rules would mean a button that offers what the action refuses.
	 */
	it('is false on plain floor and true on the exit tile', () => {
		expect(get(setup().planning.canExit)).toBe(false);
		expect(get(setup({at: EXIT}).planning.canExit)).toBe(true);
	});

	it('follows the PLAN onto the exit, and off it again', () => {
		const {planning} = setup({at: BESIDE_EXIT});
		expect(get(planning.canExit)).toBe(false);
		planning.stepTo(EXIT);
		expect(get(planning.canExit)).toBe(true);
		planning.undo();
		expect(get(planning.canExit)).toBe(false);
	});

	it('is false for an avatar that is not in the world', () => {
		expect(get(setup({at: undefined}).planning.canExit)).toBe(false);
	});

	it('is false once an exit is already planned, and while the round is closed', () => {
		const {planning} = setup({at: EXIT});
		planning.exitAt();
		expect(get(planning.canExit)).toBe(false);

		const closed = setup({at: EXIT});
		closed.state.set({step: 'Committed'} as unknown as RoundState<Action>);
		expect(get(closed.planning.canExit)).toBe(false);
	});
});

describe('planning: undo, clear and reporting', () => {
	it('takes back the last step only', () => {
		const {planning, round} = setup();
		planning.stepTo({x: 0, y: 2});
		planning.stepTo({x: 0, y: 3});
		planning.undo();
		expect(
			positionsOf((round.value as unknown as {actions: Action[]}).actions),
		).toEqual([{x: 0, y: 2}]);
	});

	it('clears everything', () => {
		const {planning, round} = setup();
		planning.stepTo({x: 0, y: 2});
		planning.clear();
		expect(
			(round.value as unknown as {actions: Action[]}).actions,
		).toHaveLength(0);
	});

	it('reports the plan in the shape the view merge wants', () => {
		const {planning} = setup();
		planning.stepTo({x: 0, y: 2});
		const plan = get(planning.plan);
		expect(plan.activeAvatarID).toEqual(7n);
		expect(plan.planned).toEqual([{type: 'move', to: {x: 0, y: 2}}]);
	});

	it('refuses everything once the round is no longer plannable', () => {
		const {planning, state} = setup();
		state.set({step: 'Committed'} as unknown as RoundState<Action>);
		expect(get(planning.canPlan)).toBe(false);
		expect(planning.stepTo({x: 0, y: 2})).toBe(false);
		expect(planning.enterAt({x: 0, y: 2})).toBe(false);
	});
});
