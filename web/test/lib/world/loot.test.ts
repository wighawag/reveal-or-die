import {describe, expect, it, vi} from 'vitest';
import {get, writable} from 'svelte/store';
import {
	bodiesAt,
	chooseBodies,
	createLoot,
	lootModelOf,
	lootPanelOf,
	shareOf,
	type LootModel,
} from '$lib/world/loot';

/**
 * THE BODIES, the client half (step R1a): which bodies lie where the plan ends,
 * which to name when there is no room for all, what the shares are worth, and
 * the settling of a dead carrier's chain from the bottom up. The rules are the
 * contract's (`contracts/test/js/Loot.test.ts`).
 */

const ALIVE = {inGame: true, life: 1};
const DEAD = {inGame: true, life: 0};

describe('the bodies on a cell', () => {
	it('are the dead avatars in the world on it, not the living, not elsewhere, not oneself', () => {
		const at = {x: 2, y: 3};
		const avatars = [
			{avatarID: 1n, ...DEAD, position: at},
			{avatarID: 2n, ...ALIVE, position: at},
			{avatarID: 3n, ...DEAD, position: {x: 2, y: 4}},
			{avatarID: 4n, inGame: false, life: 0, position: at},
			{avatarID: 5n, ...DEAD, position: at},
		];
		expect(bodiesAt(avatars, at, 5n)).toEqual([1n]);
		expect(bodiesAt(avatars, at)).toEqual([1n, 5n]);
	});

	it('are all named when there is room, and a random few when there is not', () => {
		expect(chooseBodies([1n, 2n], 3)).toEqual([1n, 2n]);
		expect(chooseBodies([1n, 2n], 0)).toEqual([]);
		const picked = chooseBodies([1n, 2n, 3n, 4n, 5n], 3, () => 0);
		expect(picked).toHaveLength(3);
		expect(new Set(picked).size).toBe(3);
		// a different draw names a different set
		expect(chooseBodies([1n, 2n, 3n, 4n, 5n], 3, () => 0.99)).not.toEqual(
			picked,
		);
	});
});

describe('a share', () => {
	it('is the value over the claimants, nothing when nobody claims', () => {
		expect(shareOf({value: 10n, claimants: 3})).toBe(3n);
		expect(shareOf({value: 10n, claimants: 0})).toBe(0n);
	});
});

const IDLE_MODEL: LootModel = lootModelOf({step: 'Unloaded'}, {step: 'Idle'});

describe('the loot panel', () => {
	const format = (v: bigint) => v.toString();

	it('offers to collect the bodies where the plan ends, while there is room', () => {
		const panel = lootPanelOf({
			model: IDLE_MODEL,
			held: [],
			bodiesHere: [1n, 2n, 3n, 4n],
			collectsLeft: 3,
			canPlan: true,
			symbol: 'ETH',
			format,
		});
		expect(panel.bodies).toEqual({
			line: '4 bodies lie here: collect them to share their stakes.',
			canCollect: true,
			collectLabel: 'Collect 3',
		});
	});

	it('says what is carried, what can be settled, and what is not final yet', () => {
		const model = lootModelOf(
			{
				step: 'Loaded',
				avatarID: 7n,
				carried: 5n,
				claims: [
					{body: 1n, cycleNumber: 3, final: true, value: 10n, claimants: 2},
					{body: 2n, cycleNumber: 4, final: false, value: 9n, claimants: 1},
				],
			},
			{step: 'Idle'},
		);
		const panel = lootPanelOf({
			model,
			held: [{avatarID: 9n, stake: 100n}],
			bodiesHere: [],
			collectsLeft: 3,
			canPlan: true,
			outOfTheWorld: 7n,
			symbol: 'ETH',
			format,
		});
		expect(panel.carriedLine).toBe(
			'You carry 5 ETH, paid when you take your avatar out.',
		);
		expect(panel.settle?.line).toBe('1 share to settle, about 5 ETH.');
		expect(panel.pendingLine).toBe(
			'1 body collected this cycle, about 9 ETH: final when the cycle ends.',
		);
		expect(panel.withdraw).toEqual({
			avatarID: 7n,
			label: 'Take your avatar out, with 5 ETH',
			disabled: false,
		});
		expect(panel.held).toEqual([
			{
				avatarID: 9n,
				label: 'Burn an avatar for its stake, 100 ETH',
				disabled: false,
			},
		]);
	});
});

describe('settling', () => {
	/**
	 * Avatar 7 collected body 20, a dead carrier which itself collected body
	 * 30: 20 cannot be released before its claim on 30 is settled, so the
	 * client settles (20, 30) first, then (7, 20).
	 */
	it("settles a dead carrier's own claims first, from the bottom of the chain up", async () => {
		const claims: Record<string, bigint[]> = {
			'7': [20n],
			'20': [30n],
			'30': [],
		};
		const claimedIn: Record<string, bigint> = {'7:20': 5n, '20:30': 4n};
		const bodies: Record<string, {openClaims: bigint; released: boolean}> = {
			'20': {openClaims: 1n, released: false},
			'30': {openClaims: 0n, released: false},
		};
		const readContract = vi.fn(
			async (request: {functionName: string; args: readonly unknown[]}) => {
				const [a, b] = request.args as [bigint, bigint];
				switch (request.functionName) {
					case 'getOpenClaims':
						return [
							claims[a.toString()] ?? [],
							BigInt((claims[a.toString()] ?? []).length),
						];
					case 'getClaim':
						return claimedIn[`${a}:${b}`] ?? 0n;
					case 'getBody':
						return {
							firstClaimCycle: 4n,
							claimants: 1,
							released: bodies[a.toString()]?.released ?? false,
							pot: 0n,
							value: 10n,
							openClaims: bodies[a.toString()]?.openClaims ?? 0n,
						};
					case 'getCarried':
						return 0n;
					default:
						throw new Error(request.functionName);
				}
			},
		);
		const sent: string[] = [];
		const writeContract = vi.fn(async (request: {args: readonly bigint[]}) => {
			sent.push(request.args.join(':'));
			const [collector, body] = request.args;
			claims[collector.toString()] = claims[collector.toString()].filter(
				(b) => b !== body,
			);
			if (bodies[body.toString()]) bodies[body.toString()].released = true;
			if (collector === 20n) bodies['20'].openClaims = 0n;
			return '0xhash' as `0x${string}`;
		});
		const loot = createLoot({
			deps: {
				publicClient: {
					readContract,
					waitForTransactionReceipt: async () => ({status: 'success'}),
				},
				connection: {ensureConnected: async () => {}},
				signerExecutor: writable({
					status: 'ready',
					account: '0xsigner',
					client: {writeContract},
				}),
				accountExecutor: writable({status: 'not-connected'}),
				account: writable(undefined),
				signerBalance: writable({step: 'Idle'}),
				deployments: writable({}),
			} as never,
			game: {address: '0x0000000000000000000000000000000000000001', abi: []},
			avatars: {address: '0x0000000000000000000000000000000000000002', abi: []},
			avatar: writable(7n),
			cycleNumber: writable(6),
		});
		await loot.update();
		const state = get(loot);
		if (state.step !== 'Loaded') throw new Error(state.step);
		expect(state.claims).toEqual([
			{body: 20n, cycleNumber: 5, final: true, value: 10n, claimants: 1},
		]);
		await loot.settleAll();
		expect(get(loot.action)).toEqual({step: 'Idle'});
		expect(sent).toEqual(['20:30', '7:20']);
	});
});
