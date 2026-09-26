import {describe, expect, it} from 'vitest';
import {
	createAttendanceReader,
	createCycleReader,
	THIS_CONTRACT_JUDGES_AN_ADVANCE,
} from '$lib/world/advance';

/**
 * This game's half of the cycle moving, from the client's side.
 *
 * WHO THE CYCLE WAITS FOR IS THE CONTRACT'S NOW: `_attendance` counts it and
 * `_moveToNextPhase` refuses on it, pinned against a real chain in
 * `contracts/test/js/ManualCycle.test.ts` (and, with a member killed by a
 * blast, in bomber-world). What is left here is the translation: one read,
 * bigints to numbers, and the claim the framework is told.
 */

const GAME = '0x1111111111111111111111111111111111111111' as const;

function fakeChain(answers: Record<string, unknown>) {
	const reads: string[] = [];
	return {
		reads,
		publicClient: {
			readContract: async (request: {functionName: string}) => {
				reads.push(request.functionName);
				if (!(request.functionName in answers)) {
					throw new Error(`unexpected read ${request.functionName}`);
				}
				return answers[request.functionName];
			},
		} as never,
		deployments: {
			get: () => ({
				chain: {id: 1337},
				contracts: {Game: {address: GAME, abi: []}},
			}),
		} as never,
	};
}

describe('the cycle reader', () => {
	it('reads getCycleNumber, and reports no timings because a manual cycle has none', async () => {
		const chain = fakeChain({getCycleNumber: [7n, true] as const});
		const reading = await createCycleReader(chain)();
		expect(reading).toEqual({
			cycleNumber: 7,
			isCommitPhase: true,
			phaseStart: 0,
			phaseEnd: 0,
		});
	});
});

describe('attendance', () => {
	it('is the contract’s own count, in ONE read', async () => {
		// It used to be one or two reads PER MEMBER, assembled here, because the
		// contract kept no membership. The count the client predicts from must
		// be the count the contract judges by, so it is read, not recomputed.
		const chain = fakeChain({
			getAttendance: {waitedFor: 3n, committed: 2n, revealed: 1n},
		});
		expect(await createAttendanceReader(chain)()).toEqual({
			waitedFor: 3,
			committed: 2,
			revealed: 1,
		});
		expect(chain.reads).toEqual(['getAttendance']);
	});
});

describe('who judges an advance', () => {
	it('is the contract, so a hand press may be sent and the chain answers', () => {
		// `false` would make the framework treat its own mirror as the only
		// guard. It was `false` until the contract gained the unanimity check;
		// see the constant's comment for why it is not a literal.
		expect(THIS_CONTRACT_JUDGES_AN_ADVANCE).toBe(true);
	});
});
