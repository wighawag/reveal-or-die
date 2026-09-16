import {describe, expect, it, vi, afterEach} from 'vitest';
import {get, writable} from 'svelte/store';
import {canTakeTurnNow, onEachNewRound} from '$lib/context/game';

/**
 * What is left of this file after `refreshDuringReveal` and
 * `settleBoardWhenCycleStarts` went back to being the framework's.
 *
 * Both were COPIED into `context/game.ts` at some point and were being
 * maintained here as well as in `game/core/refresh.ts`, identical in every
 * executable line and differing only in doc comments - the same failure the
 * input recognisers had, undetected because nothing in this tree diffs a
 * descendant against its stem. Their eleven tests are inherited now, at
 * `test/lib/game/core/refresh.test.ts`, and run unchanged.
 *
 * What stays is this game's own. `canTakeTurnNow` is the clearest case of
 * where the seam falls: it is `setup === undefined && phase === 'play'`, and
 * the first half is THIS game's rule about what a player must hold before
 * acting while only the second is the framework's.
 */

/**
 * FRESH STORES PER TEST, and the leak that made it necessary is worth naming:
 * with one set shared across the file, a watcher a test forgot to stop stayed
 * subscribed, and the next test's `phase.set` woke it - scheduling timers the
 * next test then counted as its own. Shared mutable fixtures in a file about
 * timers are a way to debug the fixture instead of the code.
 */
function stores(initial: 'play' | 'wait' = 'play') {
	return {
		phase: writable<{phase: 'play' | 'wait'}>({phase: initial}),
		clock: writable(7),
		board: writable<{step: 'Unloaded'} | {step: 'Loaded'; cycleNumber: number}>(
			{
				step: 'Unloaded',
			},
		),
	};
}

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe('canTakeTurnNow', () => {
	/**
	 * The move gate. Setup alone used to decide it; the play window was added
	 * because everything a plan is built from is stale outside it - during the
	 * reveal the avatar's next position is exactly what is being decided, and
	 * during the catch-up the board has not caught up with the round that just
	 * resolved.
	 */
	const set = {step: 'deposit'} as const;

	it('lets a set-up player move, in the window', () => {
		expect(canTakeTurnNow(undefined, 'play')).toBe(true);
	});

	it('blocks the other three parts of the round, however ready the player is', () => {
		for (const phase of ['commit', 'reveal', 'catching-up'] as const) {
			expect(canTakeTurnNow(undefined, phase)).toBe(false);
		}
	});

	it('still blocks an unready player inside the window', () => {
		expect(canTakeTurnNow(set, 'play')).toBe(false);
	});
});

/**
 * WHAT THE CHAIN DECIDES ON ITS OWN, and how the client hears about it.
 *
 * `_getResolvedAvatar` computes `life` from how far `lastEpoch` has fallen
 * behind the cycle being asked about, so an avatar is killed by the passage of
 * rounds with nobody sending anything. The account read used to be refreshed
 * only when something this client did SUCCEEDED, which is exactly the wrong
 * condition for hearing about a death: a death is what happens when this
 * client stops succeeding, and nothing succeeds afterwards either, because
 * `_makeCommitment` then reverts with `AvatarIsDead`.
 */
describe('onEachNewRound', () => {
	it('runs on the turnover, once per round', () => {
		const cycleInfo = writable({currentCycleNumber: 7});
		const run = vi.fn();
		const stop = onEachNewRound({cycleInfo, run});

		cycleInfo.set({currentCycleNumber: 8});
		expect(run).toHaveBeenCalledTimes(1);
		cycleInfo.set({currentCycleNumber: 9});
		expect(run).toHaveBeenCalledTimes(2);
		stop();
	});

	it('does not run on the first emission, which is not a turnover', () => {
		// `start()` has just done the initial reads; treating "the cycle became
		// known" as a round change would double every one of them on load.
		const cycleInfo = writable({currentCycleNumber: 7});
		const run = vi.fn();
		const stop = onEachNewRound({cycleInfo, run});
		expect(run).not.toHaveBeenCalled();
		stop();
	});

	it('does not run on a re-emission of the same round', () => {
		// The cycle store ticks with the clock: without this it would be a read
		// per second rather than one per round.
		const cycleInfo = writable({currentCycleNumber: 7});
		const run = vi.fn();
		const stop = onEachNewRound({cycleInfo, run});
		cycleInfo.set({currentCycleNumber: 7});
		cycleInfo.set({currentCycleNumber: 7});
		expect(run).not.toHaveBeenCalled();
		stop();
	});

	it('stops when it is unsubscribed', () => {
		const cycleInfo = writable({currentCycleNumber: 7});
		const run = vi.fn();
		onEachNewRound({cycleInfo, run})();
		cycleInfo.set({currentCycleNumber: 8});
		expect(run).not.toHaveBeenCalled();
	});
});
