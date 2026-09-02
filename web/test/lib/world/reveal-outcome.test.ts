import {describe, expect, it} from 'vitest';
import {get, writable} from 'svelte/store';
import {createRevealOutcome, outcomeOf} from '$lib/world/reveal-outcome';
import type {Action} from '$lib/world/commit-reveal';
import type {RoundState} from '$lib/game/core/round';
import {ActionType, xyToBigIntID} from 'reveal-or-die-contracts';

const enter: Action = {actionType: ActionType.Enter, data: xyToBigIntID(0, 1)};
const move: Action = {actionType: ActionType.Move, data: xyToBigIntID(0, 2)};
const exit: Action = {actionType: ActionType.Exit, data: xyToBigIntID(3, 5)};

describe('what a revealed turn amounts to', () => {
	it('is what the player did, in one word', () => {
		expect(outcomeOf([enter])).toBe('entered');
		expect(outcomeOf([move])).toBe('moved');
		expect(outcomeOf([move, move])).toBe('moved');
		expect(outcomeOf([exit])).toBe('left');
	});

	it('calls an empty turn what it is', () => {
		// NOT a corner case: `commitWhenIdle` sends an empty turn every epoch for
		// an avatar that is standing still, because the contract kills one that
		// goes quiet. This is the most common reveal there is.
		expect(outcomeOf([])).toBe('stayed');
	});

	it('reads a walk that ends in an exit as leaving', () => {
		// Moves may precede an exit, and the exit is what the turn was FOR: the
		// avatar is off the board afterwards, so reporting "moved" would describe
		// the smaller half of what happened.
		expect(outcomeOf([move, move, exit])).toBe('left');
	});
});

describe('remembering the turn the round forgot', () => {
	/**
	 * `RoundState` carries the actions up to `Revealing` and drops them on
	 * `Revealed`, so anything that wants to say what a reveal DID has to have
	 * been watching. That is the whole reason this store exists rather than a
	 * pure function over the round state.
	 */
	function round(
		initial: RoundState<Action>,
		mine: {
			lastTurn?: {
				epoch: number;
				actions: {
					type: 'move' | 'enter' | 'exit';
					to: {x: number; y: number};
				}[];
			};
		} = {},
	) {
		const state = writable(initial);
		const mineState = writable(mine);
		return {
			state,
			mineState,
			outcome: createRevealOutcome(state, mineState),
		};
	}

	const planning = (actions: Action[]): RoundState<Action> =>
		({step: 'Planning', epoch: 3, actions}) as RoundState<Action>;
	const revealing = (actions: Action[]): RoundState<Action> =>
		({step: 'Revealing', epoch: 3, actions}) as RoundState<Action>;
	const revealed = {step: 'Revealed', epoch: 3} as RoundState<Action>;

	describe('what the chain says it accepted, in the same words', () => {
		it('reads the board\u2019s copy when there is one', () => {
			// `lastTurn` is the accepted prefix out of `CommitmentRevealed`: a step
			// into a wall is absent from it. The round's own memory knows only what
			// was revealed, so this is the input that makes the sentence true.
			const {state, mineState, outcome} = round(revealed);
			const seen: (string | undefined)[] = [];
			const stop = outcome.subscribe((v) => seen.push(v));

			mineState.set({
				lastTurn: {epoch: 3, actions: [{type: 'move', to: {x: 1, y: 0}}]},
			});
			expect(seen.at(-1)).toBe('moved');

			mineState.set({lastTurn: {epoch: 3, actions: []}});
			// SOMETHING was revealed and none of it was accepted. "Stayed" is now
			// the truth about it rather than a restatement of an empty plan.
			expect(seen.at(-1)).toBe('stayed');
			stop();
		});

		it('falls back to what was revealed when the board has no copy', () => {
			// The player's own avatar is not always in the fetched zones: out of the
			// world, or panned away from. The remembered actions still describe their
			// turn, less precisely.
			const {state, outcome} = round(revealing([move]));
			const seen: (string | undefined)[] = [];
			const stop = outcome.subscribe((v) => seen.push(v));
			state.set(revealed);
			expect(seen.at(-1)).toBe('moved');
			stop();
		});
	});

	it('reports the actions that were in the round when it was revealed', () => {
		const {state, outcome} = round(planning([move]));
		// Subscribed throughout, as the HUD is: the value has to be watched for
		// the actions to be seen at all.
		const seen: (string | undefined)[] = [];
		const stop = outcome.subscribe((v) => seen.push(v));

		state.set(revealing([move]));
		state.set(revealed);
		expect(seen.at(-1)).toBe('moved');
		stop();
	});

	it('says nothing at any other step', () => {
		const {state, outcome} = round(planning([move]));
		const seen: (string | undefined)[] = [];
		const stop = outcome.subscribe((v) => seen.push(v));
		expect(seen.at(-1)).toBeUndefined();

		state.set({
			step: 'Committed',
			epoch: 3,
			actions: [move],
		} as RoundState<Action>);
		expect(seen.at(-1)).toBeUndefined();
		stop();
	});

	it('does not carry an old turn into the next one', () => {
		// The round goes back to Idle for the new epoch and then reveals again.
		// A remembered outcome that outlived its round would report the previous
		// turn's story about this one.
		const {state, outcome} = round(planning([move]));
		const seen: (string | undefined)[] = [];
		const stop = outcome.subscribe((v) => seen.push(v));

		state.set(revealing([move]));
		state.set(revealed);
		expect(seen.at(-1)).toBe('moved');

		state.set({step: 'Idle'} as RoundState<Action>);
		expect(seen.at(-1)).toBeUndefined();
		state.set(revealing([exit]));
		state.set(revealed);
		expect(seen.at(-1)).toBe('left');
		stop();
	});

	it('admits it does not know about a reveal it never saw', () => {
		// A page opened after the fact. Better than guessing: guessing is exactly
		// how every reveal came to be reported as movement.
		const {outcome} = round(revealed);
		expect(get(outcome)).toBeUndefined();
	});
});
