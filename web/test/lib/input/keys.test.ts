import {describe, expect, it} from 'vitest';
import {recognizeKey} from '$lib/input/keys';

/**
 * The pure half. What is worth pinning is not the table (a typo in it is
 * visible) but the four REFUSALS, every one of which is a defect the deleted
 * `render/keyboard-controller.ts` shipped or would have shipped.
 */
describe('the keys a board game uses', () => {
	it('reads the arrows and WASD as the same four directions', () => {
		expect(recognizeKey({key: 'ArrowUp'})).toEqual({
			type: 'direction',
			direction: 'up',
		});
		expect(recognizeKey({key: 'w'})).toEqual(recognizeKey({key: 'ArrowUp'}));
		expect(recognizeKey({key: 'S'})).toEqual(recognizeKey({key: 'ArrowDown'}));
		expect(recognizeKey({key: 'a'})).toEqual(recognizeKey({key: 'ArrowLeft'}));
		expect(recognizeKey({key: 'D'})).toEqual(recognizeKey({key: 'ArrowRight'}));
	});

	it('names the three actions', () => {
		expect(recognizeKey({key: 'Enter'})).toEqual({type: 'confirm'});
		expect(recognizeKey({key: ' '})).toEqual({type: 'secondary'});
		expect(recognizeKey({key: 'Backspace'})).toEqual({type: 'cancel'});
	});

	it('has nothing to say about a key it does not use', () => {
		// Load-bearing: the DOM half only calls `preventDefault` when an intent
		// comes back, so a key that is not ours has to answer undefined rather than
		// some do-nothing intent, or the game silently swallows Tab and F5.
		expect(recognizeKey({key: 'Tab'})).toBeUndefined();
		expect(recognizeKey({key: 'q'})).toBeUndefined();
	});
});

describe('the keystrokes it deliberately does not take', () => {
	it('leaves a chord to whoever owns the shortcut', () => {
		// Ctrl+W closes the tab, Alt+Left goes back, Cmd+A selects everything.
		// Answering the bare letter and the chord alike makes the game fight the
		// browser, and the player loses a turn to a keystroke they aimed elsewhere.
		expect(recognizeKey({key: 'w', modified: true})).toBeUndefined();
		expect(recognizeKey({key: 'ArrowLeft', modified: true})).toBeUndefined();
	});

	it('leaves the keystroke to whatever has focus', () => {
		// The defect the audit names: the old controller bound to `document` with
		// no check at all, so arrows and space acted on the board while the player
		// typed in a modal. Broadened here from "a text field" to "anything that
		// answers keys", because a focused button already acts on Space and Enter.
		expect(recognizeKey({key: 'ArrowUp', intoControl: true})).toBeUndefined();
		expect(recognizeKey({key: ' ', intoControl: true})).toBeUndefined();
	});

	it('does not repeat a held key, unless asked to', () => {
		// A turn is a handful of moves. Auto-repeat at thirty a second spends all
		// of them before a finger comes off the key.
		expect(recognizeKey({key: 'ArrowUp', repeat: true})).toBeUndefined();
		expect(recognizeKey({key: 'ArrowUp', repeat: true}, {repeats: true})).toEqual(
			{type: 'direction', direction: 'up'},
		);
	});

	it('still answers the first press of a key that goes on to repeat', () => {
		expect(recognizeKey({key: 'ArrowUp', repeat: false})).toEqual({
			type: 'direction',
			direction: 'up',
		});
	});
});
