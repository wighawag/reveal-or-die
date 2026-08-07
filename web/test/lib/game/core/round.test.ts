import {describe, expect, it, vi} from 'vitest';
import {get, writable, type Readable} from 'svelte/store';
import {createRound, type RoundStorage} from '$lib/game/core/round';
import {
	calculateEpochInfo,
	type EpochConfig,
	type EpochInfo,
	type EpochInfoStore,
} from '$lib/game/core/epoch';
import type {CommitRevealAdapter} from '$lib/game/core/seams';

const config: EpochConfig = {
	commitPhaseDuration: 40,
	revealPhaseDuration: 4,
	startTime: 0,
	commitTimeAllowance: 4.1,
};

/** An epoch store driven by a clock the test moves by hand. */
function fakeEpochs(initialTime: number) {
	const time = writable(initialTime);
	let $time = initialTime;
	time.subscribe((t) => ($time = t));

	const store: EpochInfoStore = {
		subscribe(run) {
			return time.subscribe((t) => run(calculateEpochInfo(t, config)));
		},
		now: () => calculateEpochInfo($time, config),
		fromTime: (t: number) => calculateEpochInfo(t, config),
	};
	return {epochInfo: store, setTime: (t: number) => time.set(t)};
}

function fakeStorage<TAction>(): RoundStorage<TAction> & {
	readonly current: unknown;
} {
	let stored: ReturnType<RoundStorage<TAction>['load']>;
	return {
		get current() {
			return stored;
		},
		load: () => stored,
		save: (round) => {
			stored = round;
		},
		clear: () => {
			stored = undefined;
		},
	};
}

type Action = {cellID: bigint};

function fakeAdapter(overrides?: {
	commit?: () => Promise<{hash: `0x${string}`}>;
	reveal?: () => Promise<{hash: `0x${string}`}>;
}) {
	const calls = {commit: [] as unknown[], reveal: [] as unknown[]};
	const adapter: CommitRevealAdapter<`0x${string}`, Action> = {
		buildCommitment: ({secret}) => ({
			hash: `0xhash${secret.slice(2, 6)}` as `0x${string}`,
			encoded: '0x' as `0x${string}`,
		}),
		commit: async (params) => {
			calls.commit.push(params);
			return overrides?.commit
				? overrides.commit()
				: {hash: '0xcommit' as `0x${string}`};
		},
		reveal: async (params) => {
			calls.reveal.push(params);
			return overrides?.reveal
				? overrides.reveal()
				: {hash: '0xreveal' as `0x${string}`};
		},
	};
	return {adapter, calls};
}

const player = '0x1111111111111111111111111111111111111111' as const;
const identity: Readable<`0x${string}` | undefined> = writable(player);

describe('the commit-reveal round', () => {
	it('plans, commits and reveals across the phases of one epoch', async () => {
		const {epochInfo, setTime} = fakeEpochs(0);
		const storage = fakeStorage<Action>();
		const {adapter, calls} = fakeAdapter();
		const round = createRound({epochInfo, adapter, storage, identity});
		const stop = round.start();

		round.plan([{cellID: 42n}]);
		expect(round.value.step).toBe('Planning');

		await round.commit();
		expect(calls.commit).toHaveLength(1);
		expect(round.value.step).toBe('Committed');

		// The actions come along to the commit, not just the hash: a game whose
		// stake is proportional to what was planned (this template bonds the exact
		// placement cost) cannot recover them from the hash.
		expect(calls.commit[0]).toMatchObject({
			identity: player,
			actions: [{cellID: 42n}],
		});

		// Into the reveal phase of the SAME epoch.
		setTime(41);
		await vi.waitFor(() => expect(calls.reveal).toHaveLength(1));
		await vi.waitFor(() => expect(round.value.step).toBe('Revealed'));

		// The reveal carried the actions and the secret that were committed to.
		expect(calls.reveal[0]).toMatchObject({
			identity: player,
			actions: [{cellID: 42n}],
		});
		stop();
	});

	it('persists the secret BEFORE the commitment is sent', async () => {
		const {epochInfo} = fakeEpochs(0);
		const storage = fakeStorage<Action>();
		let storedWhenCommitCalled: unknown;
		const {adapter} = fakeAdapter({
			commit: async () => {
				storedWhenCommitCalled = storage.current;
				return {hash: '0xcommit'};
			},
		});
		const round = createRound({epochInfo, adapter, storage, identity});
		const stop = round.start();

		round.plan([{cellID: 7n}]);
		await round.commit();

		// A reload during the wallet prompt must still be able to reveal, so the
		// secret has to be on disk by the time the call goes out.
		expect(storedWhenCommitCalled).toMatchObject({
			epoch: 2,
			actions: [{cellID: 7n}],
		});
		expect((storedWhenCommitCalled as {secret: string}).secret).toMatch(
			/^0x[0-9a-f]{64}$/,
		);
		stop();
	});

	it('reveals a commitment made before a reload', async () => {
		const storage = fakeStorage<Action>();
		storage.save({
			epoch: 2,
			actions: [{cellID: 9n}],
			secret: `0x${'ab'.repeat(32)}`,
			committed: true,
		});

		// The page loads part-way through the reveal phase: there is no phase
		// TRANSITION to observe, only the standing fact that a reveal is owed.
		const {epochInfo} = fakeEpochs(42);
		const {adapter, calls} = fakeAdapter();
		const round = createRound({epochInfo, adapter, storage, identity});
		const stop = round.start();

		await vi.waitFor(() => expect(calls.reveal).toHaveLength(1));
		expect(calls.reveal[0]).toMatchObject({actions: [{cellID: 9n}]});
		stop();
	});

	it('keeps the secret when a reveal fails, so it can be retried', async () => {
		const storage = fakeStorage<Action>();
		storage.save({
			epoch: 2,
			actions: [{cellID: 9n}],
			secret: `0x${'cd'.repeat(32)}`,
			committed: true,
		});
		const {epochInfo} = fakeEpochs(42);
		let attempts = 0;
		const {adapter} = fakeAdapter({
			reveal: async () => {
				attempts++;
				if (attempts === 1) throw new Error('user rejected');
				return {hash: '0xreveal'};
			},
		});
		const round = createRound({epochInfo, adapter, storage, identity});
		const stop = round.start();

		await vi.waitFor(() => expect(round.value.step).toBe('Error'));
		// Dropping the secret here would forfeit the stake over a mis-click.
		expect(storage.current).toBeDefined();

		await round.reveal();
		expect(round.value.step).toBe('Revealed');
		expect(storage.current).toBeUndefined();
		stop();
	});

	it('reports a commitment the epoch moved past as missed', async () => {
		const {epochInfo, setTime} = fakeEpochs(0);
		const storage = fakeStorage<Action>();
		// A reveal that never lands, so the round stays open into the next epoch.
		const {adapter} = fakeAdapter({
			reveal: () => new Promise(() => {}),
		});
		const round = createRound({epochInfo, adapter, storage, identity});
		const stop = round.start();

		round.plan([{cellID: 1n}]);
		await round.commit();
		expect(round.value.step).toBe('Committed');

		setTime(44); // next epoch's commit phase
		expect(round.value.step).toBe('Missed');
		expect(storage.current).toBeUndefined();
		stop();
	});

	it('drops an uncommitted plan when the epoch turns over', () => {
		const {epochInfo, setTime} = fakeEpochs(0);
		const storage = fakeStorage<Action>();
		const {adapter, calls} = fakeAdapter();
		const round = createRound({
			epochInfo,
			adapter,
			storage,
			identity,
			autoCommit: false,
		});
		const stop = round.start();

		round.plan([{cellID: 1n}]);
		setTime(44);

		// Nothing was at stake, so this is an expiry rather than a loss.
		expect(round.value.step).toBe('Idle');
		expect(calls.commit).toHaveLength(0);
		stop();
	});

	it('commits automatically as the commit phase closes', async () => {
		const {epochInfo, setTime} = fakeEpochs(0);
		const storage = fakeStorage<Action>();
		const {adapter, calls} = fakeAdapter();
		const round = createRound({epochInfo, adapter, storage, identity});
		const stop = round.start();

		round.plan([{cellID: 5n}]);
		setTime(20); // mid commit phase, still playable
		expect(calls.commit).toHaveLength(0);

		// Inside commitTimeAllowance of the phase closing.
		setTime(37);
		await vi.waitFor(() => expect(calls.commit).toHaveLength(1));
		stop();
	});

	it('ignores changes to the plan once the commitment is out', async () => {
		const {epochInfo} = fakeEpochs(0);
		const storage = fakeStorage<Action>();
		const {adapter} = fakeAdapter();
		const round = createRound({epochInfo, adapter, storage, identity});
		const stop = round.start();

		round.plan([{cellID: 1n}]);
		await round.commit();
		round.plan([{cellID: 2n}]);

		// The hash is of the first set; a reveal of anything else cannot open it.
		expect(round.value).toMatchObject({
			step: 'Committed',
			actions: [{cellID: 1n}],
		});
		stop();
	});

	it('lets a game DERIVE the secret instead of randomising it', async () => {
		// reveal-or-die, bomber-world and stratagems all derive the secret from a
		// signature over the epoch, so that it can be recomputed on another device
		// rather than existing only in this browser's storage.
		const {epochInfo} = fakeEpochs(0);
		const storage = fakeStorage<Action>();
		const {adapter, calls} = fakeAdapter();
		const round = createRound({
			epochInfo,
			adapter,
			storage,
			identity,
			makeSecret: async ({epoch}) =>
				`0x${epoch.toString(16).padStart(64, '0')}` as `0x${string}`,
		});
		const stop = round.start();

		round.plan([{cellID: 1n}]);
		await round.commit();

		expect((calls.commit[0] as {secret: string}).secret).toBe(
			`0x${(2).toString(16).padStart(64, '0')}`,
		);
		stop();
	});

	it('hands the secret and the reveal time to commit, for a scheduled reveal', async () => {
		// Stratagems and catacombs do not reveal from the browser: at commit time
		// they hand a timelock-encrypted reveal transaction to a scheduler, so an
		// offline player still reveals. That is only possible if commit sees the
		// secret and knows when the reveal becomes due.
		const {epochInfo} = fakeEpochs(0);
		const storage = fakeStorage<Action>();
		const {adapter, calls} = fakeAdapter();
		const round = createRound({epochInfo, adapter, storage, identity});
		const stop = round.start();

		round.plan([{cellID: 1n}]);
		await round.commit();

		const sent = calls.commit[0] as {
			secret: string;
			epoch: number;
			revealDueAt?: number;
		};
		expect(sent.epoch).toBe(2);
		expect(sent.secret).toMatch(/^0x[0-9a-f]{64}$/);
		// Epoch 2 starts at t=0, so its reveal phase opens once the 40s commit
		// phase is over.
		expect(sent.revealDueAt).toBe(40);
		stop();
	});

	it('leaves the reveal to a scheduler, but the player can still do it', async () => {
		const {epochInfo, setTime} = fakeEpochs(0);
		const storage = fakeStorage<Action>();
		const {adapter, calls} = fakeAdapter();
		const round = createRound({
			epochInfo,
			adapter,
			storage,
			identity,
			autoReveal: 'never',
		});
		const stop = round.start();

		round.plan([{cellID: 1n}]);
		await round.commit();
		setTime(41); // reveal phase

		await new Promise((r) => setTimeout(r, 50));
		expect(calls.reveal).toHaveLength(0);
		expect(round.value.step).toBe('Committed');

		// Revealing is never taken away from the player, whatever else is
		// arranged to do it for them.
		await round.reveal();
		expect(calls.reveal).toHaveLength(1);
		stop();
	});

	it('falls back to revealing itself when the scheduler has not delivered', async () => {
		const {epochInfo, setTime} = fakeEpochs(0);
		const storage = fakeStorage<Action>();
		const {adapter, calls} = fakeAdapter();
		const round = createRound({
			epochInfo,
			adapter,
			storage,
			identity,
			autoReveal: 'fallback',
		});
		const stop = round.start();

		round.plan([{cellID: 1n}]);
		await round.commit();

		// Early in the reveal phase: whatever was supposed to reveal still has
		// time, so stay out of its way.
		setTime(41);
		await new Promise((r) => setTimeout(r, 30));
		expect(calls.reveal).toHaveLength(0);

		// Most of the phase gone and the round is still open: try anyway. A
		// duplicate reveal costs one reverted transaction; a missed one costs the
		// stake.
		setTime(43);
		await vi.waitFor(() => expect(calls.reveal).toHaveLength(1));
		stop();
	});

	it('refreshes the board BEFORE reporting the reveal as done', async () => {
		// The planned placements are drawn from the round and the confirmed ones
		// from the board. Reporting Revealed first would clear the planned overlay
		// while the board was still a fetch behind, and the player would watch
		// their own moves vanish and then reappear.
		const {epochInfo, setTime} = fakeEpochs(0);
		const storage = fakeStorage<Action>();
		const {adapter} = fakeAdapter();
		const order: string[] = [];
		const round = createRound({
			epochInfo,
			adapter,
			storage,
			identity,
			onSettled: async () => {
				order.push(`refresh:${round.value.step}`);
				await new Promise((r) => setTimeout(r, 10));
				order.push('refreshed');
			},
		});
		const stop = round.start();
		const unsubscribe = round.subscribe(($r) => {
			if ($r.step === 'Revealed') order.push('Revealed');
		});

		round.plan([{cellID: 1n}]);
		await round.commit();
		setTime(41);
		await vi.waitFor(() => expect(order).toContain('Revealed'));

		expect(order).toEqual(['refresh:Revealing', 'refreshed', 'Revealed']);
		unsubscribe();
		stop();
	});

	it('keeps a plan made during the reveal phase, for the next round', async () => {
		// Clicking while the round resolves is planning ahead, not a mistake. The
		// plan used to be stamped with the CURRENT epoch and then dropped as stale
		// the instant the epoch turned over, so the moves silently disappeared.
		const {epochInfo, setTime} = fakeEpochs(41); // reveal phase of epoch 2
		const storage = fakeStorage<Action>();
		const {adapter} = fakeAdapter();
		const round = createRound({epochInfo, adapter, storage, identity});
		const stop = round.start();

		round.plan([{cellID: 7n}]);
		expect(round.value).toMatchObject({step: 'Planning', epoch: 3});

		// Into the commit phase of epoch 3: the plan is now current, not stale.
		setTime(44);
		expect(round.value).toMatchObject({
			step: 'Planning',
			epoch: 3,
			actions: [{cellID: 7n}],
		});

		// Still epoch 3 at t=87 (44 + 43), so it is still live.
		setTime(87);
		expect(round.value.step).toBe('Planning');

		// It only expires once its own epoch has gone by: epoch 4 starts at 88.
		setTime(88);
		expect(round.value.step).toBe('Idle');
		stop();
	});

	it('does nothing without a player', async () => {
		const {epochInfo} = fakeEpochs(0);
		const storage = fakeStorage<Action>();
		const {adapter, calls} = fakeAdapter();
		const round = createRound({
			epochInfo,
			adapter,
			storage,
			identity: writable(undefined),
		});
		const stop = round.start();

		round.plan([{cellID: 1n}]);
		await round.commit();
		expect(calls.commit).toHaveLength(0);
		expect(get(round).step).toBe('Planning');
		stop();
	});
});
