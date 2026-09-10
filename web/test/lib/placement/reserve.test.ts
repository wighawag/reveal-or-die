import {describe, expect, it} from 'vitest';
import {get, writable} from 'svelte/store';
import {createReserve, type ReserveDeps} from '$lib/placement/reserve';
import type {PlacementConfig} from '$lib/placement/config';

/**
 * WHAT IS AT STAKE, read correctly.
 *
 * This store had no suite at all until the contract stopped keying players by
 * address, and the gap was not visible from the outside: every test in this
 * directory fakes the chain, so an argument that the node would reject is
 * indistinguishable from one it would accept. Two failures live here and both
 * are silent.
 *
 * The identity has to arrive as the thing the contract keys by, which is a
 * `uint256` and not an address (`IGame.sol`, and `onchainIdentity` in
 * `$lib/game/identity`). And an identity of ZERO is a real identity: `0n` is a
 * legitimate token id and it is falsy, so an emptiness test written as
 * `if (!player)` reports "no stake" for one player in every game whose
 * identity is a number, forever, with nothing logged.
 *
 * The second one cannot happen on `main`, where the identity is an address -
 * which is exactly why it is worth pinning HERE rather than in the branch that
 * meets it: the check is in shared code, so it belongs to every game already,
 * and the branch inherits either a correct one or a broken one.
 */

const config = {} as unknown as PlacementConfig;

/** The chain, reduced to the two reads this store makes. */
function fakeDeps(options?: {reserve?: bigint; balance?: bigint}) {
	const reads: {functionName: string; args?: readonly unknown[]}[] = [];
	const deps = {
		connection: {ensureConnected: async () => {}},
		accountExecutor: writable({status: 'ready'}),
		account: writable('0x2222222222222222222222222222222222222222'),
		accountBalance: writable({step: 'Loaded', value: 10n ** 18n}),
		balanceCheck: {ensureCanAfford: async (o: unknown) => o},
		deployments: writable({
			contracts: {
				Game: {address: '0xgame', abi: []},
				GameToken: {address: '0xtoken', abi: []},
			},
		}),
		publicClient: {
			readContract: async ({
				functionName,
				args,
			}: {
				functionName: string;
				args?: readonly unknown[];
			}) => {
				reads.push({functionName, args});
				if (functionName === 'getReserve') return options?.reserve ?? 7n;
				if (functionName === 'balanceOf') return options?.balance ?? 3n;
				throw new Error(`unexpected read ${functionName}`);
			},
		},
	} as unknown as ReserveDeps;
	return {deps, reads};
}

describe('the reserve', () => {
	it('reads it under an identity the contract can key by', async () => {
		const {deps, reads} = fakeDeps();
		const reserve = createReserve({
			deps,
			config,
			identity: writable('0x1111111111111111111111111111111111111111') as never,
		});

		await reserve.update();

		const read = reads.find((r) => r.functionName === 'getReserve');
		// A `typeof` and not a value, so this still says something true in a game
		// whose identity is already a number and needs no widening at all.
		expect(typeof read?.args?.[0]).toBe('bigint');
		// The token balance is the PAYER's, and that one really is an address.
		const balance = reads.find((r) => r.functionName === 'balanceOf');
		expect(typeof balance?.args?.[0]).toBe('string');

		expect(get(reserve)).toEqual({
			step: 'Loaded',
			amount: 7n,
			tokenBalance: 3n,
		});
	});

	it('treats an identity of zero as an identity', async () => {
		// `if (!player)` is a correct emptiness test for an address and wrong for
		// a token id. The player whose id is zero would simply never see their
		// own stake, and every other player would be fine.
		const {deps, reads} = fakeDeps();
		const reserve = createReserve({
			deps,
			config,
			identity: writable(0n) as never,
		});

		await reserve.update();

		expect(reads.some((r) => r.functionName === 'getReserve')).toBe(true);
		expect(get(reserve)).toMatchObject({step: 'Loaded'});
	});

	it('asks nothing at all before there is an identity', async () => {
		// Undefined is a real state rather than a loading artefact: nobody is
		// signed in, or the account holds nothing it can play with. Reading the
		// chain about it would be a read with no subject.
		const {deps, reads} = fakeDeps();
		const reserve = createReserve({
			deps,
			config,
			identity: writable(undefined) as never,
		});

		await reserve.update();

		expect(reads).toEqual([]);
		expect(get(reserve)).toEqual({step: 'Unloaded'});
	});
});
