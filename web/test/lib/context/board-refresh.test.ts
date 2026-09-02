import {describe, expect, it, vi, afterEach} from 'vitest';
import {get, writable} from 'svelte/store';
import {
	canTakeTurnNow,
	refreshDuringReveal,
	roundPhaseOf,
	settleBoardWhenRoundStarts,
} from '$lib/context/game';

/**
 * The two places the board refreshes itself beyond the poller's own interval,
 * and the reasoning each one exists for:
 *
 * - during the reveal window, because another player's move is invisible from
 *   here and a 5s poll turns the one moment the game is about into a wait;
 * - when a round starts, because the client's clock crosses the epoch boundary
 *   AHEAD of the chain, and the poller's own answer to that ("not yet", then
 *   backoff) leaves the new round playing on last epoch's board.
 *
 * Both are wiring that acts unprompted, so both are functions of two stores
 * and a callback, testable with fake timers and no app context.
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
		board: writable<{step: 'Unloaded'} | {step: 'Loaded'; epoch: number}>({
			step: 'Unloaded',
		}),
	};
}

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe('refreshDuringReveal', () => {
	it('refreshes on a short cadence while the reveal window is open', async () => {
		vi.useFakeTimers();
		const {phase} = stores();
		const refresh = vi.fn();
		const stop = refreshDuringReveal({phase, refresh, intervalMs: 1500});

		phase.set({phase: 'wait'});
		await vi.advanceTimersByTimeAsync(1500 * 3);
		expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(3);
		stop();
	});

	it('does nothing during the commit phase, when the board cannot change', async () => {
		// Nothing on the board can change while commitments are open - every
		// action resolves at reveal - so a second cadence here is only a second
		// bill from the RPC. `graceMs: 0` because this test is about the commit
		// phase PROPER: the grace after a wait is its own test below.
		vi.useFakeTimers();
		const {phase} = stores();
		const refresh = vi.fn();
		const stop = refreshDuringReveal({
			phase,
			refresh,
			intervalMs: 1500,
			graceMs: 0,
		});

		await vi.advanceTimersByTimeAsync(1500 * 3);
		expect(refresh).not.toHaveBeenCalled();
		stop();
	});

	it('keeps the fast cadence for a grace period after the window closes', async () => {
		// Late landings cluster at the boundary - a reveal still in flight when
		// the clock crossed, a node whose timestamps trail the wall clock - and
		// without the grace they wait for the poller's full 5s. Observed once as
		// the other player's avatar standing still a few seconds into the play
		// phase.
		vi.useFakeTimers();
		const {phase} = stores();
		const refresh = vi.fn();
		const stop = refreshDuringReveal({
			phase,
			refresh,
			intervalMs: 1500,
			graceMs: 4000,
		});

		phase.set({phase: 'wait'});
		phase.set({phase: 'play'});
		refresh.mockClear();
		await vi.advanceTimersByTimeAsync(1500);
		expect(refresh).toHaveBeenCalled();

		// Beyond the grace, the poller owns it again - and the interval stops
		// ITSELF rather than waiting for the phase store to say so. Two ticks
		// fall inside a 4s grace at a 1.5s cadence; the one at 4.5s is the tick
		// that turns it off.
		await vi.advanceTimersByTimeAsync(1500 * 4);
		expect(refresh).toHaveBeenCalledTimes(2);
		refresh.mockClear();
		await vi.advanceTimersByTimeAsync(1500 * 3);
		expect(refresh).not.toHaveBeenCalled();
		stop();
	});

	it('stops refreshing once the grace is spent, and lets go of everything when torn down', async () => {
		vi.useFakeTimers();
		const {phase} = stores();
		const refresh = vi.fn();
		const stop = refreshDuringReveal({
			phase,
			refresh,
			intervalMs: 1500,
			graceMs: 0,
		});

		phase.set({phase: 'wait'});
		await vi.advanceTimersByTimeAsync(1500);
		expect(refresh).toHaveBeenCalled();

		phase.set({phase: 'play'});
		refresh.mockClear();
		await vi.advanceTimersByTimeAsync(1500 * 2);
		expect(refresh).not.toHaveBeenCalled();

		phase.set({phase: 'wait'});
		stop();
		refresh.mockClear();
		await vi.advanceTimersByTimeAsync(1500 * 2);
		expect(refresh).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('settleBoardWhenRoundStarts', () => {
	it('does nothing until the commit phase begins, and nothing without watch()', async () => {
		// `watch()` is the switch because the subscription opens the chain clock,
		// and construction must not start IO (ADR-0002).
		vi.useFakeTimers();
		const {phase, clock, board} = stores();
		const refresh = vi.fn();
		settleBoardWhenRoundStarts({
			phase,
			epoch: clock,
			state: board,
			refresh,
		});

		phase.set({phase: 'wait'});
		await vi.advanceTimersByTimeAsync(1000);
		expect(refresh).not.toHaveBeenCalled();
	});

	it('fetches until the board has caught up with the clock, then stops', async () => {
		vi.useFakeTimers();
		const {phase, clock, board} = stores();
		let calls = 0;
		const refresh = vi.fn(async () => {
			calls++;
			// The first two attempts find the chain still in the old epoch - the
			// client's clock crossed the boundary ahead of it - and the third
			// lands.
			board.set(
				calls >= 3 ? {step: 'Loaded', epoch: 8} : {step: 'Loaded', epoch: 7},
			);
		});
		const settle = settleBoardWhenRoundStarts({
			phase,
			epoch: clock,
			state: board,
			refresh,
			retryMs: 400,
		});
		settle.watch();
		clock.set(8);

		phase.set({phase: 'wait'});
		phase.set({phase: 'play'});

		await vi.advanceTimersByTimeAsync(400);
		await vi.advanceTimersByTimeAsync(400);
		await vi.advanceTimersByTimeAsync(400);
		expect(refresh).toHaveBeenCalledTimes(3);
		// And it stops once the board has caught up, rather than fetching for
		// the rest of the window: one more tick and nothing happened.
		await vi.advanceTimersByTimeAsync(400 * 2);
		expect(refresh).toHaveBeenCalledTimes(3);
	});

	it('does not restart on every clock tick of the same round', async () => {
		// `twoPhase` re-emits on every tick, so the settle has to trigger on the
		// TRANSITION into the commit phase, not on the phase value.
		vi.useFakeTimers();
		const {phase, clock, board} = stores();
		const refresh = vi.fn(async () => {
			board.set({step: 'Loaded', epoch: get(clock)});
		});
		const settle = settleBoardWhenRoundStarts({
			phase,
			epoch: clock,
			state: board,
			refresh,
		});
		const stop = settle.watch();

		phase.set({phase: 'wait'});
		phase.set({phase: 'play'});
		phase.set({phase: 'play'});
		phase.set({phase: 'play'});
		await vi.advanceTimersByTimeAsync(100);
		expect(refresh).toHaveBeenCalledTimes(1);
		stop();
	});

	it('gives up after the budget rather than promising a catch-up forever', async () => {
		// A chain so far behind that the settle cannot land: the indicator has to
		// go away, and the background poller owns the recovery from there.
		vi.useFakeTimers();
		const {phase, clock, board} = stores();
		const refresh = vi.fn(async () => {
			board.set({step: 'Loaded', epoch: 7});
		});
		const settle = settleBoardWhenRoundStarts({
			phase,
			epoch: clock,
			state: board,
			refresh,
			retryMs: 400,
			budgetMs: 1000,
		});
		clock.set(8);
		settle.watch();
		phase.set({phase: 'wait'});
		phase.set({phase: 'play'});

		await vi.advanceTimersByTimeAsync(2000);
		// It kept trying for the budget and not beyond it.
		expect(refresh).toHaveBeenCalledTimes(3);
	});

	it('stops at once when the board cannot load at all', async () => {
		// The fetch gate is closed, or the read failed: retrying cannot bring the
		// chain closer, and spinning for the whole budget would be noise.
		vi.useFakeTimers();
		const {phase, clock, board} = stores();
		const refresh = vi.fn(async () => {
			board.set({step: 'Unloaded'});
		});
		const settle = settleBoardWhenRoundStarts({
			phase,
			epoch: clock,
			state: board,
			refresh,
			retryMs: 400,
		});
		settle.watch();
		phase.set({phase: 'wait'});
		phase.set({phase: 'play'});
		await vi.advanceTimersByTimeAsync(1000);
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it('lets go of its subscription when torn down', async () => {
		vi.useFakeTimers();
		const {phase, clock, board} = stores();
		const refresh = vi.fn();
		const settle = settleBoardWhenRoundStarts({
			phase,
			epoch: clock,
			state: board,
			refresh,
		});
		const stop = settle.watch();
		stop();
		phase.set({phase: 'wait'});
		phase.set({phase: 'play'});
		await vi.advanceTimersByTimeAsync(1000);
		expect(refresh).not.toHaveBeenCalled();
	});
});

describe('roundPhaseOf', () => {
	/**
	 * The four-part model the clock and the move gate read. The one decision in
	 * it worth pinning is the PRIORITY: the old two-phase model had no word for
	 * the catch-up at all, and the new one puts it above whatever the clock says
	 * the phase is, because a board that is behind is the more actionable truth.
	 */
	const three = (phase: 'play' | 'commit' | 'reveal') => ({phase});

	it('splits the old "wait" into the commit lock and the reveal', () => {
		expect(roundPhaseOf(three('play'), false)).toBe('play');
		expect(roundPhaseOf(three('commit'), false)).toBe('commit');
		expect(roundPhaseOf(three('reveal'), false)).toBe('reveal');
	});

	it('puts the catch-up above whatever the clock says', () => {
		for (const phase of ['play', 'commit', 'reveal'] as const) {
			expect(roundPhaseOf(three(phase), true)).toBe('catching-up');
		}
	});
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
