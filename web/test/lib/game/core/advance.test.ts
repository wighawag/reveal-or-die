import {describe, expect, it} from 'vitest';
import {writable} from 'svelte/store';
import {
	advancePermitted,
	createCycleAdvance,
	type Attendance,
	type AutoAdvance,
} from '$lib/game/core/advance';
import type {
	CycleConfig,
	CycleInfo,
	CycleInfoStore,
	CyclePolicy,
} from '$lib/game/core/cycle';

/**
 * A manual deployment's config: no clock, by construction.
 *
 * Both durations are zero because the CONTRACT refuses a configuration where
 * they disagree with the declared policy, so this is one fact and not three.
 */
function configFor(policy: CyclePolicy): CycleConfig {
	const clocked = policy !== 'manual';
	return {
		commitPhaseDuration: clocked ? 30 : 0,
		revealPhaseDuration: clocked ? 10 : 0,
		startTime: 0,
		commitTimeAllowance: clocked ? 10.1 : 0.1,
		policy,
	};
}

/** A cycle store the test moves by hand, as the chain would. */
function fakeCycles(params: {
	policy: CyclePolicy;
	cycleNumber?: number;
	isCommitPhase?: boolean;
}) {
	const config = configFor(params.policy);
	const state = writable<{cycleNumber: number; isCommitPhase: boolean}>({
		cycleNumber: params.cycleNumber ?? 2,
		isCommitPhase: params.isCommitPhase ?? true,
	});
	let $state = {
		cycleNumber: params.cycleNumber ?? 2,
		isCommitPhase: params.isCommitPhase ?? true,
	};
	state.subscribe((value) => ($state = value));

	const infoOf = (value: typeof $state): CycleInfo =>
		({
			type: params.policy === 'manual' ? 'manual' : params.policy,
			currentCycleNumber: value.cycleNumber,
			isCommitPhase: value.isCommitPhase,
			config,
		}) as CycleInfo;

	const cycleInfo: CycleInfoStore = {
		subscribe(run) {
			return state.subscribe((value) => run(infoOf(value)));
		},
		now: () => infoOf($state),
		fromTime: () => infoOf($state),
	};
	return {
		cycleInfo,
		move: (next: {cycleNumber: number; isCommitPhase: boolean}) =>
			state.set(next),
	};
}

function harness(params: {
	policy: CyclePolicy;
	attendance: Attendance;
	auto?: AutoAdvance;
	isCommitPhase?: boolean;
	fails?: boolean;
	now?: () => number;
}) {
	const cycles = fakeCycles({
		policy: params.policy,
		isCommitPhase: params.isCommitPhase,
	});
	let attendance = params.attendance;
	let fails = params.fails ?? false;
	const sent: number[] = [];
	const refreshed: number[] = [];
	let reads = 0;

	const store = createCycleAdvance({
		cycleInfo: cycles.cycleInfo,
		readAttendance: async () => {
			reads++;
			return attendance;
		},
		advance: async () => {
			sent.push(sent.length);
			if (fails) throw new Error('someone else advanced first');
		},
		refreshCycle: async () => {
			refreshed.push(refreshed.length);
		},
		...(params.auto ? {auto: params.auto} : {}),
		...(params.now ? {now: params.now} : {}),
	});

	return {
		store,
		cycles,
		sent,
		refreshed,
		get reads() {
			return reads;
		},
		setAttendance: (next: Attendance) => (attendance = next),
		succeedFromNowOn: () => (fails = false),
		failFromNowOn: () => (fails = true),
	};
}

const alone: Attendance = {waitedFor: 1, committed: 0, revealed: 0};

describe('advancePermitted', () => {
	it('refuses under the timed policy, whatever the attendance says', () => {
		// The contract reverts with NextPhaseNotAllowed: the cycle simply IS what
		// the clock says, so there is nothing for anyone to push.
		expect(
			advancePermitted({
				policy: 'timed',
				isCommitPhase: true,
				attendance: {waitedFor: 1, committed: 1, revealed: 0},
			}),
		).toEqual({permitted: false, because: 'the-clock-decides'});
	});

	it('refuses when nobody is waited for', () => {
		// C1: no closed set, no denominator. Without it one caller could push an
		// empty game forward as fast as they liked.
		expect(
			advancePermitted({
				policy: 'manual',
				isCommitPhase: true,
				attendance: {waitedFor: 0, committed: 0, revealed: 0},
			}),
		).toEqual({permitted: false, because: 'nobody-is-waited-for'});
	});

	it('needs UNANIMITY to close the commit phase, not a majority', () => {
		// The rule this protects is one level up: if a subset could close a
		// phase, the fast players would time out the slow ones and committing
		// would have bought nothing.
		expect(
			advancePermitted({
				policy: 'manual',
				isCommitPhase: true,
				attendance: {waitedFor: 3, committed: 2, revealed: 0},
			}),
		).toEqual({permitted: false, because: 'still-waiting-to-commit'});
		expect(
			advancePermitted({
				policy: 'manual',
				isCommitPhase: true,
				attendance: {waitedFor: 3, committed: 3, revealed: 0},
			}),
		).toEqual({permitted: true, opens: 'the-reveal-phase'});
	});

	it('will not close a cycle while a commitment is still unopened', () => {
		// The one that would strand a turn: closing here would leave a commitment
		// that can never be revealed, and its bond forfeit.
		expect(
			advancePermitted({
				policy: 'manual',
				isCommitPhase: false,
				attendance: {waitedFor: 2, committed: 2, revealed: 1},
			}),
		).toEqual({permitted: false, because: 'still-waiting-to-reveal'});
		expect(
			advancePermitted({
				policy: 'manual',
				isCommitPhase: false,
				attendance: {waitedFor: 2, committed: 2, revealed: 2},
			}),
		).toEqual({permitted: true, opens: 'the-next-cycle'});
	});

	it('closes a cycle nobody committed in', () => {
		// Zero of zero is unanimity. A cycle where every member sat still still
		// has to be able to end, or a quiet cycle would freeze a manual game.
		expect(
			advancePermitted({
				policy: 'manual',
				isCommitPhase: false,
				attendance: {waitedFor: 2, committed: 0, revealed: 0},
			}),
		).toEqual({permitted: true, opens: 'the-next-cycle'});
	});

	it('permits an early advance under the hybrid policy', () => {
		expect(
			advancePermitted({
				policy: 'hybrid',
				isCommitPhase: true,
				attendance: {waitedFor: 1, committed: 1, revealed: 0},
			}),
		).toEqual({permitted: true, opens: 'the-reveal-phase'});
	});
});

describe('createCycleAdvance', () => {
	it('pushes the reveal phase open once everyone has committed', async () => {
		const h = harness({
			policy: 'manual',
			attendance: {waitedFor: 1, committed: 1, revealed: 0},
		});

		await h.store.check();

		expect(h.sent).toHaveLength(1);
		expect(h.store.value).toEqual({step: 'Idle'});
		// The local picture of the phase is now behind the chain by exactly one
		// transaction, which is the moment it is worth re-reading.
		expect(h.refreshed).toHaveLength(1);
	});

	it('sends nothing while the cycle is still waiting', async () => {
		const h = harness({policy: 'manual', attendance: alone});
		await h.store.check();
		expect(h.sent).toHaveLength(0);
		expect(h.store.value).toEqual({step: 'Idle'});
	});

	it('READS NOTHING AT ALL under the timed policy', async () => {
		// The branch that keeps an ordinary deployment's RPC traffic exactly what
		// it was: the contract would refuse, so polling for the chance would be
		// one call per second in exchange for nothing.
		const h = harness({
			policy: 'timed',
			attendance: {waitedFor: 1, committed: 1, revealed: 0},
		});
		await h.store.check();
		expect(h.reads).toBe(0);
		expect(h.sent).toHaveLength(0);
	});

	it('leaves a hybrid cycle to its clock unless asked to be eager', async () => {
		// Spending the player's gas to buy a few seconds is a decision, so it is
		// opt-in. The clock gets there on its own.
		const lazy = harness({
			policy: 'hybrid',
			attendance: {waitedFor: 1, committed: 1, revealed: 0},
		});
		await lazy.store.check();
		expect(lazy.sent).toHaveLength(0);

		const eager = harness({
			policy: 'hybrid',
			attendance: {waitedFor: 1, committed: 1, revealed: 0},
			auto: 'eagerly',
		});
		await eager.store.check();
		expect(eager.sent).toHaveLength(1);
	});

	it('never pushes when told never, even under manual', async () => {
		const h = harness({
			policy: 'manual',
			attendance: {waitedFor: 1, committed: 1, revealed: 0},
			auto: 'never',
		});
		await h.store.check();
		expect(h.sent).toHaveLength(0);

		// ...but a hand press still goes out. `never` is about what this browser
		// does by itself, not about what it is allowed to do.
		await h.store.advance();
		expect(h.sent).toHaveLength(1);
	});

	it('lets the CONTRACT judge a hand press, not the local reading', async () => {
		// The mirrored guard exists to save a doomed broadcast, not to overrule
		// the chain: a player pressing the button gets the contract's answer.
		const h = harness({policy: 'manual', attendance: alone});
		await h.store.advance();
		expect(h.sent).toHaveLength(1);
	});

	it('reports a failed advance without giving up on the cycle', async () => {
		let clock = 0;
		const h = harness({
			policy: 'manual',
			attendance: {waitedFor: 1, committed: 1, revealed: 0},
			fails: true,
			now: () => clock,
		});

		await h.store.check();
		expect(h.sent).toHaveLength(1);
		expect(h.store.value.step).toBe('Failed');

		// Nothing has changed, so an immediate retry would only spend gas to be
		// told the same thing.
		await h.store.check();
		expect(h.sent).toHaveLength(1);

		// The chain says something new - a reveal landed, a member joined - and
		// the backoff resets on the new information rather than on a timer.
		h.setAttendance({waitedFor: 2, committed: 2, revealed: 0});
		h.succeedFromNowOn();
		await h.store.check();
		expect(h.sent).toHaveLength(2);
		expect(h.store.value).toEqual({step: 'Idle'});
	});

	it('backs off exponentially while the situation is unchanged', async () => {
		// The failure that is NOT benign - a signer with nothing in it, a node
		// refusing the send - must not be retried every second forever, because
		// each attempt spends gas from the key that plays.
		let clock = 0;
		const h = harness({
			policy: 'manual',
			attendance: {waitedFor: 1, committed: 1, revealed: 0},
			fails: true,
			now: () => clock,
		});

		await h.store.check();
		expect(h.sent).toHaveLength(1);

		clock = 1999;
		await h.store.check();
		expect(h.sent).toHaveLength(1);

		clock = 2000;
		await h.store.check();
		expect(h.sent).toHaveLength(2);

		// Doubling: the second failure buys four seconds, not two.
		clock = 5999;
		await h.store.check();
		expect(h.sent).toHaveLength(2);
		clock = 6000;
		await h.store.check();
		expect(h.sent).toHaveLength(3);
	});

	it('does not send a second advance while one is in flight', async () => {
		let release: (() => void) | undefined;
		const cycles = fakeCycles({policy: 'manual'});
		const sent: number[] = [];
		const store = createCycleAdvance({
			cycleInfo: cycles.cycleInfo,
			readAttendance: async () => ({
				waitedFor: 1,
				committed: 1,
				revealed: 0,
			}),
			advance: () => {
				sent.push(sent.length);
				return new Promise<void>((resolve) => (release = resolve));
			},
		});

		const first = store.check();
		// Long enough for the read to resolve and the send to have started.
		await Promise.resolve();
		await Promise.resolve();
		await store.check();
		expect(sent).toHaveLength(1);
		expect(store.value.step).toBe('Advancing');

		release?.();
		await first;
		expect(store.value).toEqual({step: 'Idle'});
	});

	it('treats a failed attendance read as no information at all', async () => {
		const cycles = fakeCycles({policy: 'manual'});
		const sent: number[] = [];
		const store = createCycleAdvance({
			cycleInfo: cycles.cycleInfo,
			readAttendance: async () => {
				throw new Error('the node did not answer');
			},
			advance: async () => {
				sent.push(sent.length);
			},
		});

		await store.check();
		expect(sent).toHaveLength(0);
		// NOT an error state: nothing failed that the player has anything at
		// stake in, and the poller will ask again.
		expect(store.value).toEqual({step: 'Idle'});
	});

	it('starts no timer at all when this deployment needs no pushing', () => {
		const h = harness({
			policy: 'timed',
			attendance: {waitedFor: 1, committed: 1, revealed: 0},
		});
		const stop = h.store.start();
		stop();
		expect(h.reads).toBe(0);
	});
});
