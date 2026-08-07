import {describe, expect, it, vi} from 'vitest';
import {get, writable} from 'svelte/store';
import {
	blocksCommitting,
	createMissedReveal,
	type MissedRevealState,
} from '$lib/placement/missed-reveal';
import {describeMissedReveal} from '$lib/placement/ui/hud';

const PLAYER = '0x1111111111111111111111111111111111111111' as const;

/**
 * The chain, reduced to the two reads this store makes.
 *
 * `writes` records every transaction, which is the point of most of these
 * tests: acknowledging forfeits the player's bond, so the interesting assertion
 * is usually that NOTHING was sent.
 */
function fakeDeps(options: {
	commitment: {epoch: bigint; bond: bigint};
	currentEpoch: bigint;
	account?: `0x${string}` | undefined;
	writeFails?: boolean;
	readFails?: boolean;
}) {
	const writes: string[] = [];
	// The address the game PLAYS as: the local signer, not the wallet. See
	// `context/core.ts`.
	const deps = {
		gameIdentity: writable(
			'account' in options ? options.account : PLAYER,
		) as unknown as never,
		connection: {ensureConnected: async () => {}} as never,
		gameExecutor: writable({
			status: 'ready',
			address: PLAYER,
			account: PLAYER,
			client: {
				writeContract: async () => {
					if (options.writeFails) throw new Error('user rejected');
					return '0xtx' as `0x${string}`;
				},
			},
		}) as unknown as never,
		deployments: {
			get: () => ({
				contracts: {Game: {address: '0xgame', abi: []}},
			}),
		} as never,
		balanceCheck: {
			ensureCanAfford: async (o: {contract: {functionName: string}}) => {
				return o.contract;
			},
		} as never,
		publicClient: {
			readContract: async ({functionName}: {functionName: string}) => {
				if (options.readFails) throw new Error('rpc down');
				if (functionName === 'getCommitment') return options.commitment;
				if (functionName === 'getEpoch') return [options.currentEpoch, true];
				throw new Error(`unexpected read ${functionName}`);
			},
			waitForTransactionReceipt: async () => {
				writes.push('sent');
				return {status: options.writeFails ? 'reverted' : 'success'};
			},
		} as never,
	};
	return {deps, writes};
}

const config = {placementCost: 10n ** 18n} as never;

describe('a commitment that was never revealed', () => {
	it('is reported, with what it cost, when it is from a past epoch', async () => {
		const {deps} = fakeDeps({
			commitment: {epoch: 10n, bond: 5n * 10n ** 18n},
			currentEpoch: 12n,
		});
		const store = createMissedReveal({deps, config});
		await store.check();

		expect(store.value).toEqual({
			step: 'Blocked',
			epoch: 10,
			bond: 5n * 10n ** 18n,
		});
		expect(blocksCommitting(store.value)).toBe(true);
	});

	it('is NOT settled without the player asking', async () => {
		const {deps, writes} = fakeDeps({
			commitment: {epoch: 10n, bond: 5n * 10n ** 18n},
			currentEpoch: 12n,
		});
		const store = createMissedReveal({deps, config});
		await store.check();

		// Acknowledging forfeits the bond. Merely noticing must never spend it:
		// this was briefly done automatically before a commit, which took the
		// player's money inside an action they thought was about something else.
		expect(writes).toEqual([]);
	});

	it('forfeits the bond only when acknowledged, and then unblocks play', async () => {
		const {deps, writes} = fakeDeps({
			commitment: {epoch: 10n, bond: 5n * 10n ** 18n},
			currentEpoch: 12n,
		});
		const onSettled = vi.fn();
		const store = createMissedReveal({deps, config, onSettled});
		await store.check();

		await store.acknowledge();

		expect(writes).toEqual(['sent']);
		expect(store.value.step).toBe('Clear');
		expect(blocksCommitting(store.value)).toBe(false);
		// The forfeit comes out of the reserve, so the caller re-reads it.
		expect(onSettled).toHaveBeenCalledOnce();
	});

	it('leaves a commitment for the CURRENT epoch alone', async () => {
		const {deps, writes} = fakeDeps({
			commitment: {epoch: 12n, bond: 5n * 10n ** 18n},
			currentEpoch: 12n,
		});
		const store = createMissedReveal({deps, config});
		await store.check();

		// It can still be revealed. Acknowledging it would revert with
		// `CanStillReveal`, and would be destroying a stake that is not yet lost.
		expect(store.value.step).toBe('Clear');
		await store.acknowledge();
		expect(writes).toEqual([]);
	});

	it('reports nothing when there is no commitment at all', async () => {
		const {deps} = fakeDeps({
			commitment: {epoch: 0n, bond: 0n},
			currentEpoch: 12n,
		});
		const store = createMissedReveal({deps, config});
		await store.check();
		expect(store.value.step).toBe('Clear');
	});

	it('does not claim a stake was lost because a read failed', async () => {
		const {deps} = fakeDeps({
			commitment: {epoch: 0n, bond: 0n},
			currentEpoch: 12n,
			readFails: true,
		});
		const store = createMissedReveal({deps, config});
		await store.check();

		// Telling someone they have forfeited a stake is not something to do on
		// the strength of one RPC call that did not come back.
		expect(store.value.step).toBe('Unknown');
	});

	it('keeps the notice up when acknowledging fails, so it can be retried', async () => {
		const {deps} = fakeDeps({
			commitment: {epoch: 10n, bond: 5n * 10n ** 18n},
			currentEpoch: 12n,
			writeFails: true,
		});
		const store = createMissedReveal({deps, config});
		await store.check();
		await store.acknowledge();

		expect(store.value.step).toBe('Failed');
		expect(blocksCommitting(store.value)).toBe(true);
		expect(get(store)).toBe(store.value);
	});
});

describe('what the player is told', () => {
	it('says what was lost and what to do about it', () => {
		const described = describeMissedReveal({
			step: 'Blocked',
			epoch: 10,
			bond: 5n * 10n ** 18n,
		});
		expect(described?.headline).toContain('epoch 10');
		expect(described?.detail).toContain('5 TOK');
		expect(described?.canAcknowledge).toBe(true);
	});

	it('says nothing at all when there is nothing to settle', () => {
		for (const state of [
			{step: 'Clear'},
			{step: 'Unknown'},
		] satisfies MissedRevealState[]) {
			expect(describeMissedReveal(state)).toBeUndefined();
		}
	});
});
