import {beforeEach, describe, expect, it} from 'vitest';
import {
	createAttendanceReader,
	createCycleReader,
	declareWaitedFor,
	forgetWaitedFor,
	waitedForOnChain,
} from '$lib/world/advance';

/**
 * WHO THE CYCLE IS WAITING FOR, assembled from per-avatar reads.
 *
 * The contract's half of this is pinned in `contracts/test/js/ManualCycle.test.ts`
 * against a real chain: that a manual game HAS a commit phase, that one push
 * opens the reveal phase without moving the cycle, and that `lastCycleNumber` is what
 * a reveal writes. What is pinned here is the arithmetic on top of it, because
 * two of the three numbers are read off something other than the obvious field
 * and both would be wrong in a way that still produces a plausible tally.
 */

const GAME = '0x1111111111111111111111111111111111111111' as const;
const CHAIN = 1337;

type Avatar = {inGame: boolean; lastCycleNumber: bigint; life: number};

/**
 * A chain that answers the three calls this file makes, and counts them.
 *
 * The count is asserted rather than incidental: this reader costs one read per
 * member plus a second for each member that has not revealed, on every poll,
 * and that is the thing about it most likely to be made quietly worse.
 */
function fakeChain(
	members: Record<string, {avatar: Avatar; commitment: bigint}>,
) {
	const reads: string[] = [];
	return {
		reads,
		publicClient: {
			readContract: async (request: {
				functionName: string;
				args?: readonly unknown[];
			}) => {
				reads.push(request.functionName);
				if (request.functionName === 'getCycleNumber')
					return [7n, true] as const;
				const id = String(request.args?.[0]);
				const member = members[id];
				if (!member) throw new Error(`no such avatar ${id}`);
				if (request.functionName === 'getAvatar') return member.avatar;
				if (request.functionName === 'getCommitment') {
					return {hash: '0x00', cycleNumber: member.commitment};
				}
				throw new Error(`unexpected read ${request.functionName}`);
			},
		} as never,
		deployments: {
			get: () => ({
				chain: {id: CHAIN},
				contracts: {Game: {address: GAME, abi: []}},
			}),
		} as never,
	};
}

const alive = (lastCycleNumber: bigint, inGame = true): Avatar => ({
	inGame,
	lastCycleNumber,
	life: 1,
});

beforeEach(() => {
	forgetWaitedFor();
});

describe('who a world waits for', () => {
	it('waits for nobody until somebody says otherwise', () => {
		// The framework reads this as `NoOneToWaitFor` and pushes nothing, which
		// is what an ordinary deployment of this game should do: it has no
		// membership set on chain, so there is no honest denominator to invent.
		expect(waitedForOnChain(CHAIN)).toEqual([]);
	});

	it('keeps each world’s table apart, because an app can hold two', () => {
		// The remote chain in the navbar and an in-tab world below it are two
		// contexts at once. A single global would let the embedded world's table
		// answer for the remote one, and under `timed` nothing reads it, so that
		// would have been invisible rather than harmless.
		declareWaitedFor(CHAIN, [1n, 2n]);
		expect(waitedForOnChain(CHAIN)).toEqual([1n, 2n]);
		expect(waitedForOnChain(CHAIN + 1)).toEqual([]);
	});
});

describe('the cycle reader', () => {
	it('reads getCycleNumber, and reports no timings because a manual cycle has none', async () => {
		const chain = fakeChain({});
		const reading = await createCycleReader({
			publicClient: chain.publicClient,
			deployments: chain.deployments,
		})();
		expect(reading).toEqual({
			cycleNumber: 7,
			isCommitPhase: true,
			phaseStart: 0,
			phaseEnd: 0,
		});
	});
});

describe('attendance', () => {
	function readerFor(
		members: Record<string, {avatar: Avatar; commitment: bigint}>,
		ids: bigint[],
	) {
		const chain = fakeChain(members);
		return {
			chain,
			read: createAttendanceReader({
				publicClient: chain.publicClient,
				deployments: chain.deployments,
				cycleNumber: () => 7,
				waitedFor: () => ids,
			}),
		};
	}

	it('asks nothing at all when nobody is waited for', async () => {
		const {chain, read} = readerFor({}, []);
		expect(await read()).toEqual({waitedFor: 0, committed: 0, revealed: 0});
		// An ordinary deployment polls this once a second forever, so the empty
		// case has to cost no RPC at all.
		expect(chain.reads).toEqual([]);
	});

	it('counts a member that has committed but not revealed', async () => {
		const {read} = readerFor(
			{
				'1': {avatar: alive(6n), commitment: 7n},
				'2': {avatar: alive(6n), commitment: 0n},
			},
			[1n, 2n],
		);
		expect(await read()).toEqual({waitedFor: 2, committed: 1, revealed: 0});
	});

	it('still counts a member that has REVEALED as having committed', async () => {
		// THE ONE THAT IS EASY TO GET WRONG. `_reveal` sets `commitment.cycleNumber = 0`
		// when it is done, so a member that has finished looks exactly like one
		// that never committed. Counting only the commitment would make
		// `committed` FALL as the reveal phase progressed, and `advancePermitted`
		// would then refuse to close a cycle everybody had finished - which under
		// the manual policy is a world that never moves again.
		const {read} = readerFor(
			{
				'1': {avatar: alive(7n), commitment: 0n},
				'2': {avatar: alive(7n), commitment: 0n},
			},
			[1n, 2n],
		);
		expect(await read()).toEqual({waitedFor: 2, committed: 2, revealed: 2});
	});

	it('does not count a reveal from an earlier cycle', async () => {
		const {read} = readerFor({'1': {avatar: alive(6n), commitment: 0n}}, [1n]);
		expect(await read()).toEqual({waitedFor: 1, committed: 0, revealed: 0});
	});

	it('stops waiting for a member with no life left', async () => {
		// `_makeCommitment` reverts `AvatarIsDead`, so a dead member the cycle
		// still waited for would block it forever. Death is computed from how far
		// `lastCycleNumber` has fallen behind and is never written down or announced,
		// which is why this is read every time rather than remembered.
		const {read} = readerFor(
			{
				'1': {
					avatar: {inGame: true, lastCycleNumber: 2n, life: 0},
					commitment: 0n,
				},
				'2': {avatar: alive(7n), commitment: 0n},
			},
			[1n, 2n],
		);
		expect(await read()).toEqual({waitedFor: 1, committed: 1, revealed: 1});
	});

	it('waits for a member that has never entered the world', async () => {
		// Its first submission is the Enter. A cycle that did not wait for it
		// would open the reveal phase before it could make one, and in this game
		// missing reveals is how an avatar dies.
		const {read} = readerFor(
			{'1': {avatar: alive(0n, false), commitment: 0n}},
			[1n],
		);
		expect(await read()).toEqual({waitedFor: 1, committed: 0, revealed: 0});
	});

	it('asks for a commitment only when the member has not revealed', async () => {
		const {chain, read} = readerFor(
			{
				'1': {avatar: alive(7n), commitment: 0n},
				'2': {avatar: alive(6n), commitment: 7n},
			},
			[1n, 2n],
		);
		await read();
		expect(chain.reads).toEqual(['getAvatar', 'getAvatar', 'getCommitment']);
	});
});
