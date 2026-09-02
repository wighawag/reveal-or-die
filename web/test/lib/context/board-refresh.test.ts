import {describe, expect, it, vi, afterEach} from 'vitest';
import {get, writable} from 'svelte/store';
import {
	refreshDuringReveal,
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

const phase = writable<{phase: 'play' | 'wait'}>({phase: 'play'});
const clock = writable(7);
const board = writable<{step: 'Unloaded'} | {step: 'Loaded'; epoch: number}>({
	step: 'Unloaded',
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	phase.set({phase: 'play'});
	clock.set(7);
	board.set({step: 'Unloaded'});
});

describe('refreshDuringReveal', () => {
	it('refreshes on a short cadence while the reveal window is open', async () => {
		vi.useFakeTimers();
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
		// bill from the RPC.
		vi.useFakeTimers();
		const refresh = vi.fn();
		const stop = refreshDuringReveal({phase, refresh, intervalMs: 1500});

		await vi.advanceTimersByTimeAsync(1500 * 3);
		expect(refresh).not.toHaveBeenCalled();
		stop();
	});

	it('stops refreshing when the window closes, and lets go of everything when torn down', async () => {
		vi.useFakeTimers();
		const refresh = vi.fn();
		const stop = refreshDuringReveal({phase, refresh, intervalMs: 1500});

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
		const refresh = vi.fn();
		const settle = settleBoardWhenRoundStarts({
			phase,
			epoch: clock,
			state: board,
			refresh,
		});

		phase.set({phase: 'wait'});
		await vi.advanceTimersByTimeAsync(1000);
		expect(refresh).not.toHaveBeenCalled();
		expect(get(settle.settling)).toBe(false);
	});

	it('fetches until the board has caught up with the clock, then stops', async () => {
		vi.useFakeTimers();
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
		const seen: boolean[] = [];
		const unsub = settle.settling.subscribe((v) => seen.push(v));

		phase.set({phase: 'wait'});
		phase.set({phase: 'play'});
		expect(get(settle.settling)).toBe(true);

		await vi.advanceTimersByTimeAsync(400);
		await vi.advanceTimersByTimeAsync(400);
		await vi.advanceTimersByTimeAsync(400);
		expect(refresh).toHaveBeenCalledTimes(3);
		expect(get(settle.settling)).toBe(false);
		// Settling was announced for exactly the duration of the catch-up.
		expect(seen).toContain(true);
		expect(seen.at(-1)).toBe(false);
		unsub();
	});

	it('does not restart on every clock tick of the same round', async () => {
		// `twoPhase` re-emits on every tick, so the settle has to trigger on the
		// TRANSITION into the commit phase, not on the phase value.
		vi.useFakeTimers();
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
		expect(get(settle.settling)).toBe(false);
		// It kept trying for the budget and not beyond it.
		expect(refresh).toHaveBeenCalledTimes(3);
	});

	it('stops at once when the board cannot load at all', async () => {
		// The fetch gate is closed, or the read failed: retrying cannot bring the
		// chain closer, and spinning for the whole budget would be noise.
		vi.useFakeTimers();
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
		expect(get(settle.settling)).toBe(false);
	});

	it('lets go of its subscription when torn down', async () => {
		vi.useFakeTimers();
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
