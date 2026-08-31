/**
 * Keyboard to intents.
 *
 * Split the way `$lib/game/render/gestures.ts` is split, for the same reason:
 *
 * - {@link recognizeKey} is a pure function over a plain sample. No DOM types,
 *   so every branch is testable in the node project, including the ones that
 *   are awkward to perform by hand (a held key repeating, a modifier chord).
 * - {@link attachKeys} is the DOM binding, and is deliberately thin.
 *
 * WHAT THE OLD IMPLEMENTATION GOT WRONG, since this replaces it and
 * `docs/audits/03-renderer.md` 3.4 lists the defects by name. The deleted
 * `render/keyboard-controller.ts` bound to `document` unconditionally, with no
 * `preventDefault` and no check for where the keystroke was going, so arrows
 * and space acted on the board while the player was typing in a modal. Both
 * halves of that are fixed below, and the second one is broadened: a keystroke
 * aimed at ANY interactive element belongs to that element, not to the game,
 * because a focused button already answers Space and Enter itself and would
 * otherwise do its own job and the game's at once.
 */
import type {ControlIntent, ControlIntentHandler} from './intents';

/**
 * One keystroke, as much of it as the recogniser needs.
 *
 * `key` is `KeyboardEvent.key`, which is the LAYOUT-DEPENDENT character. That
 * is right for the letter keys (a French keyboard's WASD is not under the same
 * fingers, and a player on one expects their own letters) and irrelevant for
 * the named keys, which are the same everywhere.
 */
export type KeySample = {
	key: string;
	/** The operating system repeating a held key. */
	repeat?: boolean;
	/** Any of ctrl / meta / alt, which make this a browser or OS shortcut. */
	modified?: boolean;
	/**
	 * The keystroke is going somewhere that owns it: a text field, a button, a
	 * link, anything focusable that answers keys itself.
	 */
	intoControl?: boolean;
};

export type KeyOptions = {
	/**
	 * Whether a HELD key repeats the intent. Off by default, and that is a game
	 * decision this defaults to the safe side of: a turn is a handful of moves
	 * long, and auto-repeat at 30 a second spends all of them before a finger
	 * comes off the key.
	 */
	repeats?: boolean;
};

/**
 * The whole mapping, in one table so it can be read at a glance.
 *
 * Arrows and WASD both, because a player with one hand on a mouse uses the
 * arrows and a player using the keyboard alone uses the letters. Space is a
 * second spelling of the secondary action rather than of confirm, which is
 * what the pre-port build did (space was "exit"); Enter confirms.
 */
const KEYS: Record<string, ControlIntent> = {
	ArrowUp: {type: 'direction', direction: 'up'},
	ArrowDown: {type: 'direction', direction: 'down'},
	ArrowLeft: {type: 'direction', direction: 'left'},
	ArrowRight: {type: 'direction', direction: 'right'},
	w: {type: 'direction', direction: 'up'},
	W: {type: 'direction', direction: 'up'},
	s: {type: 'direction', direction: 'down'},
	S: {type: 'direction', direction: 'down'},
	a: {type: 'direction', direction: 'left'},
	A: {type: 'direction', direction: 'left'},
	d: {type: 'direction', direction: 'right'},
	D: {type: 'direction', direction: 'right'},
	Enter: {type: 'confirm'},
	' ': {type: 'secondary'},
	x: {type: 'secondary'},
	X: {type: 'secondary'},
	Backspace: {type: 'cancel'},
};

/**
 * The intent a keystroke carries, or undefined for one that is not ours.
 *
 * Undefined is load-bearing rather than a null object: the DOM half only calls
 * `preventDefault` when something came back, so every key the game does not use
 * keeps doing whatever the browser and the page would have done with it.
 */
export function recognizeKey(
	sample: KeySample,
	options: KeyOptions = {},
): ControlIntent | undefined {
	// A chord is a shortcut somebody else owns. Ctrl+W closes the tab and
	// Alt+Left goes back; answering the bare letter and the chord alike makes
	// the game fight the browser.
	if (sample.modified) return undefined;
	// Whatever has focus answers its own keys. A focused button already acts on
	// Space and Enter, so without this one press does two things.
	if (sample.intoControl) return undefined;
	if (sample.repeat && !options.repeats) return undefined;
	return KEYS[sample.key];
}

/**
 * Elements that answer keystrokes themselves, so the game must not.
 *
 * Broader than "is it a text field", which is where the deleted implementation
 * stopped. `closest` rather than a tag check on the target, because focus can
 * land on something inside a control (a span in a button, a label in a
 * summary).
 */
const CONTROL_SELECTOR =
	'input, textarea, select, button, a[href], summary, [contenteditable=""], [contenteditable="true"], [role="button"], [role="textbox"], [tabindex]:not([tabindex="-1"])';

function intoControl(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) return false;
	return target.closest(CONTROL_SELECTOR) !== null;
}

/**
 * Bind a keyboard to a handler. Returns the teardown.
 *
 * Bound to a TARGET rather than to `document` by default only in the sense that
 * the caller passes one: keyboard events without focus go to the document, and
 * a canvas is not focusable, so the document is the honest default and the
 * guards above are what keep it from stealing keys. The lifetime of the binding
 * is the caller's business, and it is a real decision - see
 * `routes/play/+page.svelte`, which owns it here.
 */
export function attachKeys(
	target: {
		addEventListener: typeof document.addEventListener;
		removeEventListener: typeof document.removeEventListener;
	},
	onIntent: ControlIntentHandler,
	options: KeyOptions = {},
): () => void {
	function onKeyDown(event: KeyboardEvent) {
		const intent = recognizeKey(
			{
				key: event.key,
				repeat: event.repeat,
				modified: event.ctrlKey || event.metaKey || event.altKey,
				intoControl: intoControl(event.target),
			},
			options,
		);
		if (!intent) return;
		// Only for keys the game actually took. Arrows and space scroll the page,
		// and a board that jumps a screen down on every step is unplayable; keys we
		// did not use keep their default behaviour, which is why this is here and
		// not at the top.
		event.preventDefault();
		onIntent(intent);
	}

	target.addEventListener('keydown', onKeyDown as EventListener);
	return () => target.removeEventListener('keydown', onKeyDown as EventListener);
}
