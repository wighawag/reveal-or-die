import {describe, expect, it} from 'vitest';
import {get, writable, type Readable} from 'svelte/store';
import {createPlanning} from '$lib/world/planning';
import type {WorldConfig} from '$lib/world/config';
import type {Action} from '$lib/world/commit-reveal';
import type {RoundState, RoundStore} from '$lib/game/core/round';
import {ActionType, bigIntIDToXY, type Position} from 'reveal-or-die-contracts';

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
 */
const START: Position = {x: 0, y: 1};

function fakeRound(initial: Action[] = []) {
	const state = writable<RoundState<Action>>({
		step: 'Planning',
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
			state.set({step: 'Planning', actions: [...actions]} as RoundState<Action>);
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
		const actions = (round.value as {actions: Action[]}).actions;
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
		expect(positionsOf((round.value as {actions: Action[]}).actions)).toEqual([
			{x: 0, y: 2},
		]);
	});

	it('chains steps from where the PLAN ends, not from where the avatar is', () => {
		const {planning, round} = setup();
		expect(planning.stepTo({x: 0, y: 2})).toBe(true);
		expect(planning.stepTo({x: 0, y: 3})).toBe(true);
		expect(positionsOf((round.value as {actions: Action[]}).actions)).toEqual([
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
		expect((round.value as {actions: Action[]}).actions).toHaveLength(3);
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

describe('planning: undo, clear and reporting', () => {
	it('takes back the last step only', () => {
		const {planning, round} = setup();
		planning.stepTo({x: 0, y: 2});
		planning.stepTo({x: 0, y: 3});
		planning.undo();
		expect(positionsOf((round.value as {actions: Action[]}).actions)).toEqual([
			{x: 0, y: 2},
		]);
	});

	it('clears everything', () => {
		const {planning, round} = setup();
		planning.stepTo({x: 0, y: 2});
		planning.clear();
		expect((round.value as {actions: Action[]}).actions).toHaveLength(0);
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
		state.set({step: 'Committed'} as RoundState<Action>);
		expect(get(planning.canPlan)).toBe(false);
		expect(planning.stepTo({x: 0, y: 2})).toBe(false);
		expect(planning.enterAt({x: 0, y: 2})).toBe(false);
	});
});
