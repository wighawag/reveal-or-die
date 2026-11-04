import {describe, expect, it} from 'vitest';
import {writable} from 'svelte/store';
import {
	createAttendanceReader,
	createCycleReader,
	createDeadReleaser,
	deadOnBoard,
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

/**
 * THE DEAD, RELEASED. Death is computed when asked and the commit-reveal
 * base's attendance is a tally, so a member that dies goes on being counted
 * until `releaseDeadAvatar` is sent for it (pinned against a real chain in
 * `contracts/test/js/ManualCycle.test.ts`). These pin the client's half: who it
 * names, when it is asked, and that it asks once.
 */
describe('releasing the dead', () => {
	function fakeSigner(params: {
		ready?: boolean;
		refuse?: (avatarID: bigint) => boolean;
	}) {
		const sent: bigint[] = [];
		const executor = {
			status: params.ready === false ? 'not-ready' : 'ready',
			account: '0x2222222222222222222222222222222222222222',
			client: {
				writeContract: async (request: {
					functionName: string;
					args: [bigint];
				}) => {
					expect(request.functionName).toBe('releaseDeadAvatar');
					const [avatarID] = request.args;
					if (params.refuse?.(avatarID)) {
						throw new Error('execution reverted: NotInGame');
					}
					sent.push(avatarID);
					return '0xabc';
				},
			},
		};
		const deps = {
			connection: {ensureConnected: async () => {}},
			signerExecutor: writable(executor),
			signerBalance: writable({step: 'Loaded', value: 1n}),
			publicClient: {
				waitForTransactionReceipt: async () => ({status: 'success'}),
			},
			deployments: {
				get: () => ({contracts: {Game: {address: GAME, abi: []}}}),
			},
		} as never;
		return {sent, deps};
	}

	it('names the avatars the board shows dead IN the world, and no others', () => {
		expect(
			deadOnBoard([
				{avatarID: 1n, inGame: true, life: 0},
				{avatarID: 2n, inGame: true, life: 1},
				// out of the world an avatar cannot die; never released
				{avatarID: 3n, inGame: false, life: 0},
			]),
		).toEqual([1n]);
	});

	it('sends one release per dead avatar, once, and says whether it sent', async () => {
		const {sent, deps} = fakeSigner({refuse: (id) => id === 5n});
		const dead = [4n, 5n];
		const release = createDeadReleaser(deps, {dead: () => dead});
		// 5 is refused (released by somebody else already): no throw, not counted
		expect(await release()).toBe(true);
		expect(sent).toEqual([4n]);
		// asked again with the same board: nothing more is sent
		expect(await release()).toBe(false);
		dead.push(6n);
		expect(await release()).toBe(true);
		expect(sent).toEqual([4n, 6n]);
	});

	it('spends no attempt while there is no key to send it with', async () => {
		const {sent, deps} = fakeSigner({ready: false});
		const release = createDeadReleaser(deps, {dead: () => [7n]});
		expect(await release()).toBe(false);
		expect(sent).toEqual([]);
	});

	it('is asked by the attendance reader only while a member has not committed, and re-reads after', async () => {
		let attendance = {waitedFor: 3n, committed: 2n, revealed: 0n};
		const chain = fakeChain({});
		chain.publicClient = {
			readContract: async () => attendance,
		} as never;
		let asked = 0;
		const read = createAttendanceReader(chain, {
			releaseDead: async () => {
				asked++;
				attendance = {waitedFor: 2n, committed: 2n, revealed: 0n};
				return true;
			},
		});
		expect(await read()).toEqual({waitedFor: 2, committed: 2, revealed: 0});
		expect(asked).toBe(1);
		// everyone has committed: nothing to release for
		await read();
		expect(asked).toBe(1);
	});
});
