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
import {test, expect, describe, waitForAppReady} from '../fixtures/test';
import {
	authoriseToPlay,
	boardState,
	skipTutorial,
	stakeAnAvatar,
	waitUntilSetUpToPlay,
} from '../fixtures/board';

/**
 * A TABLE IN REVEAL-OR-DIE, one story per mode (stratagems' plan, step R1b,
 * R1b-17): two seats, ours and another player's (a node account, which takes
 * its seat and enters, then stops revealing and dies two cycles later); the
 * table closes early with one alive, the leftover is released, and the
 * survivor is paid. In AVATAR mode its avatar comes back and it takes the
 * other's stake; in ETH mode it takes twice the stake. The dead take nothing.
 *
 * About four cycles of a table's clock (30 + 10 s, advanced early when both
 * have acted), most of them waiting for the other to die.
 */

const RPC_URL =
	(globalThis as any).process.env.E2E_RPC_URL ||
	`http://127.0.0.1:${(globalThis as any).process.env.E2E_RPC_PORT ?? 8545}`;

const ZERO = '0x0000000000000000000000000000000000000000' as const;
const SECRET = `0x${'7ab1e'.padStart(64, '0')}` as const;

/** Where the two enter: walkable cells beside each other. */
const OURS = {x: 0, y: 1};
const THEIRS = {x: 0, y: 2};

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

async function playingSeat(page: Page): Promise<bigint> {
	const id = (await page.evaluate(`(() => {
		${READ}
		const id = read(globalThis.context.game.activeIdentity);
		return id === undefined ? undefined : id.toString();
	})()`)) as string | undefined;
	if (!id) throw new Error('no seat is playing');
	return BigInt(id);
}

/** Wait until a turn can be planned, plan it, commit it, and wait for its reveal. */
async function playTurn(page: Page, script: string) {
	await expect
		.poll(async () => (await boardState(page)).readyToPlay, {
			message: 'the board should take a turn',
			timeout: 120_000,
		})
		.toBe(true);
	await page
		.getByRole('button', {name: /^skip$/i})
		.waitFor({timeout: 5_000})
		.catch(() => {});
	await skipTutorial(page);
	await page.evaluate(`(() => {
		const planning = globalThis.context.game.planning;
		${script}
	})()`);
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

/** A wallet confirmation, when the app asks for one. */
async function confirmIfAsked(page: Page) {
	const confirm = page.locator('[data-testid="confirmation-confirm"]');
	if (await confirm.isVisible({timeout: 5_000}).catch(() => false)) {
		await confirm.click();
	}
}

async function story(
	page: Page,
	authoriseBrowser: Parameters<typeof authoriseToPlay>[1],
	mode: 'avatar' | 'eth',
	other: `0x${string}`,
) {
	const node = createPublicClient({transport: http(RPC_URL)});
	const wallet = createWalletClient({
		account: other,
		transport: http(RPC_URL),
		chain: null,
	});
	const send = async (request: Record<string, unknown>) => {
		const hash = await wallet.writeContract(request as never);
		const receipt = await node.waitForTransactionReceipt({hash});
		expect(receipt.status).toBe('success');
	};

	// CREATE, from the lobby, in the mode under test.
	await page.goto('/lobby/');
	await waitForAppReady(page);
	await expect(
		page.locator('[data-testid="wallet-status"][data-connected="true"]'),
		'the lobby should have its account back',
	).toHaveCount(1, {timeout: 30_000});
	await page.getByTestId('table-seats-2').click();
	await page
		.getByTestId('table-option-mode')
		.selectOption(mode === 'eth' ? '1' : '0');
	await page.getByTestId('table-create').click();
	await confirmIfAsked(page);
	await page.waitForURL(/[?&]game=0x[0-9a-fA-F]{40}/, {timeout: 90_000});
	await expect(page.getByTestId('table-lobby')).toBeVisible({timeout: 60_000});
	const {Game: Table, AvatarsSale, Avatars} = await deploymentsOf(page);
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
	const tableState = () => read(Table, 'getTable');
	expect(Number((await tableState()).mode)).toBe(mode === 'eth' ? 1 : 0);
	const stake = BigInt((await tableState()).stake);

	// OUR SEAT, from the table's lobby: a purchase into the table, or Join.
	// Either one is the acquisition rail, so it also funds this browser's key,
	// which authorises itself: nothing is left to ask for (step R1b).
	if (mode === 'avatar') {
		await stakeAnAvatar(page);
	} else {
		await page
			.getByRole('button', {name: /^join for/i})
			.first()
			.click({timeout: 60_000});
		const chooser = page.locator('[data-testid="acquire-payment-methods"]');
		if (await chooser.isVisible({timeout: 10_000}).catch(() => false)) {
			await page
				.locator('[data-testid="acquire-pay-with-account"]')
				.or(page.locator('[data-testid="acquire-pay-with-wallet"]'))
				.first()
				.click({timeout: 30_000});
		}
		const consent = page.getByRole('button', {
			name: /^(sign and buy|buy|sign and join|join)$/i,
		});
		if (await consent.isVisible({timeout: 10_000}).catch(() => false)) {
			await consent.click({timeout: 30_000});
		}
		await expect
			.poll(async () => (await boardState(page)).deposited ?? 0, {
				message: 'our seat should be taken',
				timeout: 120_000,
			})
			.toBeGreaterThan(0);
		await waitUntilSetUpToPlay(page);
	}
	await authoriseToPlay(page, authoriseBrowser);
	const ours = await playingSeat(page);

	// THEIR SEAT, by a node account.
	await node.request({
		method: 'hardhat_setBalance' as never,
		params: [other, '0x56BC75E2D63100000'] as never,
	});
	let theirs: bigint;
	if (mode === 'avatar') {
		const subID = BigInt(Date.now());
		theirs = avatarIDFor(other, subID);
		await send({
			...AvatarsSale,
			functionName: 'purchase',
			args: [
				Table.address,
				subID,
				encodeAbiParameters([{type: 'address'}], [other]),
				ZERO,
				0n,
				ZERO,
			],
			value: salePriceOf(AvatarsSale.linkedData),
		});
	} else {
		theirs = BigInt(other);
		await send({
			...Table,
			functionName: 'join',
			args: [ZERO, 0n],
			value: stake,
		});
	}

	// STARTED by its creator, us.
	const start = page.getByTestId('table-start');
	await expect(start).toBeEnabled({timeout: 60_000});
	await start.click();
	await expect
		.poll(async () => (await tableState()).started, {timeout: 60_000})
		.toBe(true);

	// THEY ENTER and go quiet; WE ENTER beside them and play on (an avatar at
	// risk commits empty turns by itself) until they are dead.
	const cycle = async () =>
		(await read(Table, 'getCycle')) as {
			cycleNumber: bigint;
			commiting: boolean;
		};
	await expect
		.poll(async () => (await cycle()).commiting, {timeout: 60_000})
		.toBe(true);
	const first = (await cycle()).cycleNumber;
	const enter: Action[] = [
		{actionType: ActionType.Enter, data: xyToBigIntID(THEIRS.x, THEIRS.y)},
	];
	await send({
		...Table,
		functionName: 'commit',
		args: [theirs, commitmentHash(SECRET, enter), ZERO],
	});
	const revealed = (async () => {
		await expect
			.poll(
				async () => {
					const now = await cycle();
					return now.cycleNumber === first && !now.commiting;
				},
				{timeout: 120_000, intervals: [500]},
			)
			.toBe(true);
		await send({
			...Table,
			functionName: 'reveal',
			args: [theirs, enter, SECRET, ZERO],
		});
	})();
	await playTurn(page, `return planning.enterAt(${JSON.stringify(OURS)});`);
	await revealed;
	await expect
		.poll(async () => Number((await read(Table, 'getAvatar', [theirs])).life), {
			message: 'the other seat should die after two missed cycles',
			timeout: 600_000,
			intervals: [5_000],
		})
		.toBe(0);
	expect(Number((await read(Table, 'getAvatar', [ours])).life)).toBe(1);

	// CLOSED early, from the HUD: one is alive.
	const close = page.getByTestId('table-close');
	await expect
		.poll(
			async () => {
				if ((await tableState()).closed) return true;
				if (await close.isEnabled().catch(() => false)) {
					await close.click().catch(() => {});
				}
				return (await tableState()).closed;
			},
			{message: 'the table should close', timeout: 180_000, intervals: [3_000]},
		)
		.toBe(true);
	expect(Number((await tableState()).survivors)).toBe(1);
	expect(Number((await tableState()).leftovers)).toBe(1);

	// THE LEFTOVER released, then OUR WINNINGS.
	const release = page.getByTestId('table-release');
	await expect(release).toBeEnabled({timeout: 60_000});
	await release.click();
	await expect
		.poll(async () => Number((await tableState()).leftovers), {timeout: 90_000})
		.toBe(0);

	const fromBlock = await node.getBlockNumber();
	const winnings = page.getByTestId('table-winnings');
	await expect(winnings).toBeEnabled({timeout: 60_000});
	const expected = mode === 'eth' ? 2n * stake : stake;
	await expect(winnings).toContainText('Take your winnings');
	await winnings.click();
	await confirmIfAsked(page);
	await expect
		.poll(
			async () =>
				(
					await node.getLogs({
						address: Table.address,
						event: parseAbiItem(
							'event WinningsPaid(uint256 indexed seat, address to, uint256 amount)',
						),
						args: {seat: ours},
						fromBlock,
					})
				).map((log) => log.args.amount),
			{message: 'the survivor should be paid', timeout: 90_000},
		)
		.toEqual([expected]);
	if (mode === 'avatar') {
		// its avatar back, carrying exactly its own stake
		const owner = (await read(Avatars, 'ownerOf', [ours])) as string;
		expect(owner.toLowerCase()).not.toBe(Table.address.toLowerCase());
		expect(await read(Avatars, 'stakeOf', [ours])).toBe(stake);
	}
	expect(BigInt(await node.getBalance({address: Table.address}))).toBe(0n);

	// THE DEAD TAKE NOTHING.
	await expect(
		node.simulateContract({
			...Table,
			account: other,
			functionName: 'withdraw',
			args: [theirs, other],
		} as never),
	).rejects.toThrow(/AvatarIsDead/);
}

describe('A table in avatar mode', () => {
	// an account of its own: every story here sends transactions
	test.use({walletAccountIndex: 5});

	test('closes early when one survives, releases the dead, and gives the survivor its avatar and the dead seat’s stake', async ({
		connectedPage,
		authoriseBrowser,
	}) => {
		test.setTimeout(900_000);
		await story(
			connectedPage,
			authoriseBrowser,
			'avatar',
			'0xbDA5747bFD65F08deb54cb465eB87D40e51B197E',
		);
	});
});

describe('A table in ETH mode', () => {
	test.use({walletAccountIndex: 6});

	test('closes early when one survives, releases the dead, and pays the survivor twice the stake', async ({
		connectedPage,
		authoriseBrowser,
	}) => {
		test.setTimeout(900_000);
		await story(
			connectedPage,
			authoriseBrowser,
			'eth',
			'0x2546BcD3c84621e976D8185a91A922aE77ECEc30',
		);
	});
});
