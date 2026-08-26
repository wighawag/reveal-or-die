/**
 * Whether the player has been shown round the board yet, and the tour itself.
 *
 * The flag used to be a field on `private/localState.ts`, the pre-port store
 * that also held the pending round, the chosen avatar and the planned actions.
 * All three of those have proper homes now (the framework's round,
 * `../active-avatar`, `../planning`), and this was the only thing left, so it
 * lives here rather than keeping that module alive for one boolean.
 *
 * Per BROWSER, not per account: it records what this person has already read,
 * and signing in as somebody else does not make them read it again.
 */
import {writable, type Readable} from 'svelte/store';
import {driver} from 'driver.js';
import 'driver.js/dist/driver.css';

const KEY = '__world_tutorial_seen';

export type TutorialStore = Readable<{seen: boolean}> & {
	markSeen(): void;
	/** Show it again. Reachable from the console; there is no button for it. */
	reset(): void;
};

function read(): boolean {
	if (typeof localStorage === 'undefined') return false;
	try {
		return localStorage.getItem(KEY) === '1';
	} catch {
		return false;
	}
}

function write(seen: boolean) {
	if (typeof localStorage === 'undefined') return;
	try {
		if (seen) localStorage.setItem(KEY, '1');
		else localStorage.removeItem(KEY);
	} catch {
		// Storage full or disabled. Showing the tour twice is a smaller problem
		// than throwing out of a component's setup.
	}
}

export function createTutorial(): TutorialStore {
	// Constructed off-browser too (ADR-0002), so the initial value must not
	// depend on storage existing. `false` means "not seen", which errs towards
	// showing it - and the component only mounts in the browser anyway, where the
	// refresh below has already run by the time anything can look.
	const store = writable({seen: false}, (set) => {
		set({seen: read()});
	});

	return {
		subscribe: store.subscribe,
		markSeen() {
			write(true);
			store.set({seen: true});
		},
		reset() {
			write(false);
			store.set({seen: false});
		},
	};
}

/**
 * The guided tour.
 *
 * The steps are re-targeted at the HUD this port produced. They used to point
 * at `#navigation` (the on-screen D-pad, which went with the old renderer, see
 * docs/plans/web-port.md) and `#arena` (an id nothing has ever had, so that step
 * silently did nothing). What is left is what exists: the clock, the moves
 * counter and the avatar picker.
 */
export function startTour(onFinished?: () => void) {
	let refresh: ReturnType<typeof setInterval> | undefined;
	const driverObj = driver({
		popoverClass: 'driverjs-theme',
		showProgress: true,
		animate: false,
		allowClose: false,
		steps: [
			{
				element: '#game-clock',
				popover: {
					title: 'Your timer',
					description:
						'reveal-or-die is a simultaneous turn-based game with two phases, commit and reveal. The dial counts down whichever phase you are in. While it is green you can plan; once it turns red your moves are being resolved and the round is no longer yours to change.',
				},
			},
			{
				element: '#stats',
				popover: {
					title: 'Your avatar, and what it has left',
					description:
						'Click a neighbouring cell to step onto it. Each turn allows a fixed number of moves, and the counter is what is left of them.',
				},
			},
			{
				element: '#game-clock',
				popover: {
					title: 'Moves are submitted for you',
					description:
						'You do not have to press anything. When the dial runs out, whatever you have planned is committed, and it is revealed in the next phase. That is also why a plan you abandon still counts.',
				},
			},
		],
		onDestroyed() {
			if (refresh) clearInterval(refresh);
			onFinished?.();
		},
	});
	// The HUD moves as the round changes (a missed-reveal panel appears, the
	// avatar picker grows), and driver.js measures once.
	refresh = setInterval(() => driverObj.refresh(), 200);
	driverObj.drive();
}
