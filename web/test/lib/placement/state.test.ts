import {describe, expect, it, vi} from 'vitest';
import {createBoardReader} from '$lib/placement/state';
import type {
	TypedDeployments,
	TypedPublicClient,
} from '$lib/core/connection/types';

/**
 * WHAT THE READER IS ALLOWED TO REFUSE.
 *
 * Returning `undefined` is not a soft "no": the framework reads it as "the
 * node has not caught up", retries for a budget, and then lets the refusal
 * through to the polling store as a FAILED fetch - which starts exponential
 * backoff behind an RPC-health banner. So the difference between refusing and
 * accepting a read is the difference between a board that is a second stale
 * and a board that is blank behind a warning, and the tests below are about
 * which disagreements deserve that.
 */

type Batch = [
	readonly {cellID: bigint; totalStake: bigint; numClaimants: number}[],
	bigint,
];

function reader(batches: (args: {zones: bigint[]; block: bigint}) => Batch) {
	const readContract = vi.fn(
		async (call: {args: [bigint[]]; blockNumber?: bigint}) =>
			batches({
				zones: call.args[0],
				block: call.blockNumber as bigint,
			}),
	);
	const read = createBoardReader({
		publicClient: {readContract} as unknown as TypedPublicClient,
		deployments: {
			contracts: {Game: {address: '0xabc', abi: []}},
		} as unknown as TypedDeployments,
	});
	return {read, readContract};
}

const cell = (id: bigint) => ({
	cellID: id,
	totalStake: 1n,
	numClaimants: 1,
});

describe('createBoardReader', () => {
	it('accepts a read whose chain epoch is behind the one asked for', async () => {
		// THE FIX. The client's clock interpolates from the wall clock between
		// blocks, so it crosses a round boundary before the chain has mined a
		// block past it, and the contract answers from its latest block with the
		// PREVIOUS round. Requiring an exact match turned that two-clock
		// disagreement of seconds into a failed read, and the failed read into
		// backoff behind a health banner over a board that was fine.
		const {read} = reader(() => [[cell(1n)], 7n]);

		const state = await read({
			zones: [0n],
			fromBlock: 0,
			toBlock: 100,
			expectedEpoch: 8,
		});

		expect(state).toBeDefined();
		expect(state!.cells.size).toBe(1);
	});

	it('stamps the read with the epoch it was FOR, not the chain\u2019s', async () => {
		// Everything downstream asks "has the board caught up with the clock?" by
		// comparing this number with the clock's. Stamping the chain's epoch makes
		// the catch-up last until a block past the boundary is mined - on a node
		// that only mines on transactions, that is the next commit, some twenty
		// seconds of waiting for a counter when the data has already arrived.
		const {read} = reader(() => [[cell(1n)], 7n]);

		const state = await read({
			zones: [0n],
			fromBlock: 0,
			toBlock: 100,
			expectedEpoch: 8,
		});

		expect(state!.epoch).toBe(8);
	});

	it('refuses only when two batches of one read disagree with each other', async () => {
		// The reorg case, and the ONLY one left. Every batch reads the same pinned
		// block, so a disagreement means that block was replaced underneath the
		// read; stitching the halves would produce a board that never existed at
		// any moment.
		let call = 0;
		const {read} = reader(() => [[cell(BigInt(++call))], call === 1 ? 7n : 9n]);

		const state = await read({
			// Two batches: ZONES_PER_CALL is 8, so nine zones is two calls.
			zones: Array.from({length: 9}, (_, i) => BigInt(i)),
			fromBlock: 0,
			toBlock: 100,
			expectedEpoch: 8,
		});

		expect(state).toBeUndefined();
	});

	it('pins every batch to the block the framework named', async () => {
		// The batches are separate RPC calls against a moving chain. Unpinned, a
		// reveal landing between two of them stitches half a board from before it
		// to half from after - and the agreement check above becomes meaningless,
		// because unpinned calls disagree for ordinary reasons.
		const blocks: bigint[] = [];
		const {read} = reader(({block}) => {
			blocks.push(block);
			return [[], 8n];
		});

		await read({
			zones: Array.from({length: 9}, (_, i) => BigInt(i)),
			fromBlock: 0,
			toBlock: 100,
			expectedEpoch: 8,
		});

		expect(blocks.length).toBe(2);
		expect(blocks).toEqual([100n, 100n]);
	});

	it('asks the chain nothing when the camera implies no zones', async () => {
		// Pins the BEHAVIOUR, and deliberately not the early return that states
		// it: batching an empty list produces no batches, so deleting that line
		// leaves this passing. Kept because the behaviour is what callers depend
		// on (a camera with no size must not bill the RPC), and worth saying out
		// loud so nobody reads it as cover for the guard itself.
		const {read, readContract} = reader(() => [[], 8n]);

		const state = await read({
			zones: [],
			fromBlock: 0,
			toBlock: 100,
			expectedEpoch: 8,
		});

		expect(readContract).not.toHaveBeenCalled();
		expect(state).toEqual({cells: new Map(), epoch: 8});
	});
});
