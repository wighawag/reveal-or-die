import type {Page} from '@playwright/test';
import {
	createPublicClient,
	createWalletClient,
	encodeAbiParameters,
	http,
	parseAbiItem,
	type Abi,
} from 'viem';
import {
	avatarIDFor,
	commitmentHash,
	ActionType,
	salePriceOf,
	xyToBigIntID,
	type Action,
} from 'reveal-or-die-contracts';
import {test, expect, describe} from '../fixtures/test';
import {
	authoriseToPlay,
	boardState,
	clearAnyMissedReveal,
	skipTutorial,
	stakeAnAvatar,
} from '../fixtures/board';

/**
 * A BODY, COLLECTED AND PAID OUT, in a real browser (step R1a of stratagems'
 * plan; reveal-or-die `work`: `stake-in-the-avatar`).
 *
 * Another player's avatar enters the world beside ours and is left to die (a
 * node account plays it, then goes quiet); our avatar walks onto the body and
 * collects it from the HUD, takes its share once the cycle is over, walks to
 * the exit and leaves, and is taken out of the game, which pays what it
 * collected. Its own stake is untouched throughout: the avatar leaves whole.
 *
 * About eight cycles of the local clock (30 + 10 s), most of them waiting for
 * the body to fall more than `numMissesAllowed` cycles behind.
 */

const RPC_URL =
	(globalThis as any).process.env.E2E_RPC_URL ||
	`http://127.0.0.1:${(globalThis as any).process.env.E2E_RPC_PORT ?? 8545}`;

/** A node account outside the e2e wallets' list: the body's owner. */
const BODY_OWNER = '0xdD2FD4581271e230360230F9337D5c0430Bf44C0' as const;
const SECRET = `0x${'b0d1'.padStart(64, '0')}` as const;

/** Where the two avatars meet: walkable cells beside each other. */
const OURS = {x: 0, y: 1};
const BODY = {x: 0, y: 2};
/** From the body's cell to the exit tile at (3,5). */
const TO_THE_EXIT = [
	{x: 0, y: 3},
	{x: 1, y: 3},
	{x: 2, y: 3},
	{x: 3, y: 3},
	{x: 4, y: 3},
	{x: 4, y: 4},
	{x: 4, y: 5},
	{x: 3, y: 5},
];

type Deployment = {address: `0x${string}`; abi: Abi; linkedData?: unknown};

const READ = `
	const read = (store) => {
		let value;
		const stop = store.subscribe((v) => (value = v));
		if (typeof stop === 'function') stop(); else stop.unsubscribe();
		return value;
	};
`;

async function deploymentsOf(page: Page) {
	return (await page.evaluate(`(() => {
		const {contracts} = globalThis.context.deployments.get();
		const pick = (c) => ({address: c.address, abi: c.abi, linkedData: c.linkedData});
		return {Game: pick(contracts.Game), AvatarsSale: pick(contracts.AvatarsSale), Avatars: pick(contracts.Avatars)};
	})()`)) as {Game: Deployment; AvatarsSale: Deployment; Avatars: Deployment};
}

async function playingAvatar(page: Page): Promise<bigint> {
	const id = (await page.evaluate(`(() => {
		${READ}
		const id = read(globalThis.context.game.activeIdentity);
		return id === undefined ? undefined : id.toString();
	})()`)) as string | undefined;
	if (!id) throw new Error('no avatar is playing');
	return BigInt(id);
}

/** Plan with the planning store, as a key or a click would. */
async function plan(page: Page, script: string): Promise<unknown> {
	return page.evaluate(`(() => {
		const planning = globalThis.context.game.planning;
		${script}
	})()`);
}

/** Wait until a turn can be planned, plan it, commit it, and wait for its reveal. */
async function playTurn(page: Page, planIt: () => Promise<unknown>) {
	await expect
		.poll(async () => (await boardState(page)).readyToPlay, {
			message: 'the board should take a turn',
			timeout: 120_000,
		})
		.toBe(true);
	// the welcome overlay arrives once the board can play, over the buttons
	await page
		.getByRole('button', {name: /^skip$/i})
		.waitFor({timeout: 5_000})
		.catch(() => {});
	await skipTutorial(page);
	await expect
		.poll(
			async () => {
				const step = (await boardState(page)).step;
				return step === 'Idle' || step === 'Planning' || step === 'Revealed';
			},
			{message: 'the submission should take a plan', timeout: 120_000},
		)
		.toBe(true);
	await planIt();
	const commit = page.getByRole('button', {name: /commit now/i});
	await expect(commit, 'the turn should be committable').toBeEnabled({
		timeout: 30_000,
	});
	await commit.click();
	await expect
		.poll(async () => (await boardState(page)).step, {
			message: 'the turn should be revealed',
			timeout: 120_000,
		})
		.toBe('Revealed');
}

describe('A body', () => {
	// one open commitment per account per cycle: an account of its own
	test.use({walletAccountIndex: 9});

	test('is collected, shared, and paid out when the avatar is taken out, which keeps its own stake', async ({
		connectedPage,
		authoriseBrowser,
	}) => {
		test.setTimeout(900_000);
		const page = connectedPage;
		await authoriseToPlay(page, authoriseBrowser);
		await clearAnyMissedReveal(page);
		await stakeAnAvatar(page);
		const ours = await playingAvatar(page);
		const {Game, AvatarsSale, Avatars} = await deploymentsOf(page);

		const node = createPublicClient({transport: http(RPC_URL)});
		const owner = createWalletClient({
			account: BODY_OWNER,
			transport: http(RPC_URL),
			chain: null,
		});
		const read = (
			contract: Deployment,
			functionName: string,
			args: unknown[] = [],
		) =>
			node.readContract({
				...contract,
				functionName,
				args,
			} as never) as Promise<any>;
		const stake = BigInt(
			(AvatarsSale.linkedData as {stakeAmount: string}).stakeAmount,
		);
		expect(await read(Avatars, 'stakeOf', [ours])).toBe(stake);

		// THE BODY: bought into the game by a node account, entered beside ours.
		await node.request({
			method: 'hardhat_setBalance' as never,
			params: [BODY_OWNER, '0x56BC75E2D63100000'] as never,
		});
		const subID = BigInt(Date.now());
		const body = avatarIDFor(BODY_OWNER, subID);
		const bought = await owner.writeContract({
			...AvatarsSale,
			functionName: 'purchase',
			args: [
				Game.address,
				subID,
				encodeAbiParameters([{type: 'address'}], [BODY_OWNER]),
				'0x0000000000000000000000000000000000000000',
				0n,
				'0x0000000000000000000000000000000000000000',
			],
			value: salePriceOf(AvatarsSale.linkedData),
		} as never);
		await node.waitForTransactionReceipt({hash: bought});
		const enter: Action[] = [
			{actionType: ActionType.Enter, data: xyToBigIntID(BODY.x, BODY.y)},
		];
		const cycleOf = async () =>
			(await read(Game, 'getCycleNumber')) as [bigint, boolean];
		await expect
			.poll(async () => (await cycleOf())[1], {timeout: 60_000})
			.toBe(true);
		const [cycle] = await cycleOf();
		await node.waitForTransactionReceipt({
			hash: await owner.writeContract({
				...Game,
				functionName: 'commit',
				args: [
					body,
					commitmentHash(SECRET, enter),
					'0x0000000000000000000000000000000000000000',
				],
			} as never),
		});
		await expect
			.poll(async () => (await cycleOf())[1], {timeout: 60_000})
			.toBe(false);
		expect((await cycleOf())[0]).toBe(cycle);
		await node.waitForTransactionReceipt({
			hash: await owner.writeContract({
				...Game,
				functionName: 'reveal',
				args: [
					body,
					enter,
					SECRET,
					'0x0000000000000000000000000000000000000000',
				],
			} as never),
		});

		// OURS enters beside it, and plays on (an idle avatar commits empty turns
		// by itself) while the body falls behind and dies.
		await playTurn(page, () =>
			plan(page, `return planning.enterAt(${JSON.stringify(OURS)});`),
		);
		await expect
			.poll(async () => (await boardState(page)).position, {timeout: 60_000})
			.toEqual(OURS);
		await expect
			.poll(async () => Number((await read(Game, 'getAvatar', [body])).life), {
				message: 'the body should be dead once it has missed enough cycles',
				timeout: 600_000,
				intervals: [5_000],
			})
			.toBe(0);

		// COLLECTED FROM THE HUD: step onto it, and the panel offers it.
		await playTurn(page, async () => {
			await plan(page, `return planning.stepTo(${JSON.stringify(BODY)});`);
			const collect = page.getByTestId('loot-collect');
			await expect(collect, 'the panel should offer the body').toBeEnabled({
				timeout: 30_000,
			});
			await collect.click();
		});
		expect(Number(await read(Game, 'getClaim', [ours, body]))).toBeGreaterThan(
			0,
		);

		// ITS SHARE, once the cycle it was collected in is over: alone, the whole.
		const take = page.getByTestId('loot-settle');
		await expect(take, 'the share should be offered once final').toBeEnabled({
			timeout: 120_000,
		});
		await take.click();
		await expect
			.poll(async () => (await read(Game, 'getCarried', [ours])) as bigint, {
				timeout: 60_000,
			})
			.toBe(stake);
		await expect(page.getByTestId('loot-carried')).toBeVisible();

		// OUT BY THE EXIT, then out of the game, which pays what it carries.
		await playTurn(page, () =>
			plan(
				page,
				`for (const p of ${JSON.stringify(TO_THE_EXIT)}) planning.stepTo(p); return planning.exitAt();`,
			),
		);
		await expect
			.poll(async () => (await boardState(page)).position, {timeout: 60_000})
			.toBeUndefined();
		const fromBlock = await node.getBlockNumber();
		const withdraw = page.getByTestId('loot-withdraw');
		await expect(withdraw).toBeEnabled({timeout: 60_000});
		await withdraw.click();
		const confirm = page.locator('[data-testid="confirmation-confirm"]');
		if (await confirm.isVisible({timeout: 5_000}).catch(() => false)) {
			await confirm.click();
		}
		await expect
			.poll(
				async () =>
					(
						await node.getLogs({
							address: Game.address,
							event: parseAbiItem(
								'event CarriedPaid(uint256 indexed avatarID, address indexed to, uint256 amount)',
							),
							args: {avatarID: ours},
							fromBlock,
						})
					).map((log) => log.args.amount),
				{
					message: 'taking the avatar out should pay what it collected',
					timeout: 90_000,
				},
			)
			.toEqual([stake]);
		expect(await read(Game, 'getCarried', [ours])).toBe(0n);
		// and the avatar left whole: exactly its own stake, back in the account
		expect(await read(Avatars, 'stakeOf', [ours])).toBe(stake);
		await expect(page.getByTestId('loot-burn').first()).toBeVisible({
			timeout: 60_000,
		});
	});
});
