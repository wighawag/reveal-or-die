import {describe, expect, it, vi} from 'vitest';
import {writable} from 'svelte/store';
import {createControls, STEP} from '$lib/world/controls';
import type {MissedRevealState} from '$lib/world/missed-reveal';
import type {ControlIntent} from '$lib/input/intents';

/**
 * The half of the input layer that knows what game this is.
 *
 * Everything it decides is one line long, which is the point: `planning` and
 * `round` already refuse what cannot be done, so a mapping that started
 * re-deciding those would be a second copy of a rule that exists. What is
 * tested here is the translation itself, and the two things it adds on top.
 */
function setup(
	options: {
		ready?: boolean;
		missedReveal?: MissedRevealState;
	} = {},
) {
	const planning = {
		stepBy: vi.fn(() => true),
		exitAt: vi.fn(() => true),
		undo: vi.fn(),
	};
	const round = {commit: vi.fn(async () => {})};
	const controls = createControls({
		planning,
		round,
		missedReveal: {value: options.missedReveal ?? {step: 'Clear'}},
		readyToPlay: writable(options.ready ?? true),
	});
	return {controls, planning, round};
}

const direction = (d: 'up' | 'down' | 'left' | 'right'): ControlIntent => ({
	type: 'direction',
	direction: d,
});

describe('what a press does to this game', () => {
	it('steps in the direction pressed, with y growing downwards', () => {
		// The one place the board's convention is written down. North is `y - 1`
		// here and in every position the contract stores; the recogniser
		// deliberately says nothing about it.
		const {controls, planning} = setup();
		controls.handle(direction('up'));
		expect(planning.stepBy).toHaveBeenCalledWith({x: 0, y: -1});
		controls.handle(direction('down'));
		expect(planning.stepBy).toHaveBeenCalledWith({x: 0, y: 1});
		controls.handle(direction('left'));
		expect(planning.stepBy).toHaveBeenCalledWith({x: -1, y: 0});
		controls.handle(direction('right'));
		expect(planning.stepBy).toHaveBeenCalledWith({x: 1, y: 0});
	});

	it('agrees with itself about the four steps', () => {
		// Guards the guard above: a table where two directions collide would pass
		// nothing else here.
		const distinct = new Set(Object.values(STEP).map((s) => `${s.x},${s.y}`));
		expect(distinct.size).toBe(4);
	});

	it('leaves the world on the secondary action', () => {
		// The Exit action's only affordance. There is no pointer equivalent: a
		// click names a cell, and leaving names none.
		const {controls, planning} = setup();
		controls.handle({type: 'secondary'});
		expect(planning.exitAt).toHaveBeenCalledTimes(1);
	});

	it('takes back the last step on cancel', () => {
		const {controls, planning} = setup();
		controls.handle({type: 'cancel'});
		expect(planning.undo).toHaveBeenCalledTimes(1);
	});

	it('commits the round on confirm', () => {
		const {controls, round} = setup();
		controls.handle({type: 'confirm'});
		expect(round.commit).toHaveBeenCalledTimes(1);
	});
});

describe('the two things it refuses', () => {
	it('does nothing at all until the player could take a turn', () => {
		// The same gate a click passes in `context/game.ts`. Letting someone plan a
		// whole turn they cannot commit is worse than not letting them start: the
		// moves look accepted, and the failure arrives when the round is closing.
		const {controls, planning, round} = setup({ready: false});
		controls.handle(direction('up'));
		controls.handle({type: 'secondary'});
		controls.handle({type: 'cancel'});
		controls.handle({type: 'confirm'});
		expect(planning.stepBy).not.toHaveBeenCalled();
		expect(planning.exitAt).not.toHaveBeenCalled();
		expect(planning.undo).not.toHaveBeenCalled();
		expect(round.commit).not.toHaveBeenCalled();
	});

	it('will not commit while an unrevealed commitment is in the way', () => {
		// The one condition `round.commit()` cannot see for itself: the contract
		// rejects the new commitment with `PreviousCommitmentNotRevealed`, so this
		// would spend gas to be told no and leave the round showing an error the
		// player did not cause. The HUD disables its own button for the same
		// reason; a key must not be a way round a disabled button.
		const {controls, round, planning} = setup({
			missedReveal: {step: 'Blocked', epoch: 3} as MissedRevealState,
		});
		controls.handle({type: 'confirm'});
		expect(round.commit).not.toHaveBeenCalled();
		// Planning is still allowed: the moves are kept, and acknowledging the old
		// commitment is what unblocks sending them.
		controls.handle(direction('up'));
		expect(planning.stepBy).toHaveBeenCalledTimes(1);
	});
});

describe('listening', () => {
	it('binds and unbinds a keyboard', () => {
		const {controls, planning} = setup();
		const listeners = new Map<string, (event: KeyboardEvent) => void>();
		const target = {
			addEventListener: (type: string, listener: unknown) =>
				listeners.set(type, listener as (event: KeyboardEvent) => void),
			removeEventListener: (type: string) => listeners.delete(type),
		} as unknown as Parameters<typeof controls.listen>[0] extends undefined
			? never
			: Document;

		const stop = controls.listen({target});
		const press = () =>
			listeners.get('keydown')?.({
				key: 'ArrowUp',
				target: null,
				preventDefault: () => {},
			} as unknown as KeyboardEvent);

		press();
		expect(planning.stepBy).toHaveBeenCalledTimes(1);
		stop();
		press();
		expect(planning.stepBy).toHaveBeenCalledTimes(1);
	});
});
