import type {Page} from '@playwright/test';
import {test, expect, describe} from '../fixtures/test';
import {boardState, skipTutorial} from '../fixtures/board';

/**
 * A TABLE IN THE OFFLINE WORLD, one story per mode (stratagems' plan, step
 * OT3, OT3-12): the lobby offers a table first, in the mode chosen through the
 * game's own select; the tab creates it from the person's account, takes every
 * seat at it by the mode's rail and starts it, so the page opens on its first
 * cycle with no table lobby in between; the person enters and plays, a reload
 * inside the table restores the same table on the cycle it was in, and after
 * the last cycle the TAB closes it and releases what is left, with nothing
 * pressed. The winnings stay the person's to take: in avatar mode the avatar
 * comes back carrying its stake, in ETH mode the stake is paid back.
 *
 * Under the Manual cycle nobody misses a reveal, so nobody dies here and every
 * seat is repaid (OT3-8). The chain is read through `globalThis.offlineWorld`,
 * the context's records being the table's.
 */

const READ = `
	const world = globalThis.offlineWorld;
	const records = world && world.context.deployments.get();
	const call = (contract, functionName, args = []) =>
		world.context.publicClient.readContract({
			address: contract.address,
			abi: contract.abi,
			functionName,
			args,
		});
	const read = (store) => {
		let value;
		const stop = store.subscribe((v) => (value = v));
		if (typeof stop === 'function') stop(); else stop.unsubscribe();
		return value;
	};
`;

type OnChain = {
	address: string;
	tables: number;
	cycleNumber: number;
	last: number;
	ended: boolean;
	mode: number;
	stake: string;
	seated: number;
	alive: number;
	closed: boolean;
	survivors: number;
	leftovers: number;
	balance: string;
	/** Every seat and its owner, as the table holds them. */
	seats: {seat: string; owner: string}[];
	/** Who the world's own `Game` waits for: nobody, at a table. */
	inTheWorld: number;
};

/** Where the table is, from the chain. */
async function tableOnChain(page: Page): Promise<OnChain | undefined> {
	return page.evaluate(`(async () => {
		${READ}
		if (!world) return undefined;
		const game = records.contracts.Game;
		const [cycle, end, table, seated, tables, balance, inTheWorld] =
			await Promise.all([
				call(game, 'getCycle'),
				call(game, 'getEnd'),
				call(game, 'getTable'),
				call(game, 'getSeated'),
				call(records.contracts.GameTableFactory, 'numGames'),
				world.context.publicClient.getBalance({address: game.address}),
				world.world.deployments.get().contracts.Game
					? world.context.publicClient.readContract({
							address: world.world.deployments.get().contracts.Game.address,
							abi: world.world.deployments.get().contracts.Game.abi,
							functionName: 'getAttendance',
						})
					: undefined,
			]);
		const seats = await Promise.all(
			seated.map(async (seat) => ({
				seat: seat.toString(),
				owner: (await call(game, 'getAvatar', [seat])).owner,
			})),
		);
		return {
			address: game.address,
			tables: Number(tables),
			cycleNumber: Number(cycle.cycleNumber),
			last: Number(end[1]),
			ended: end[2],
			mode: Number(table.mode),
			stake: table.stake.toString(),
			seated: Number(table.seated),
			alive: Number(table.alive),
			closed: table.closed,
			survivors: Number(table.survivors),
			leftovers: Number(table.leftovers),
			balance: balance.toString(),
			seats,
			inTheWorld: inTheWorld ? Number(inTheWorld.waitedFor) : 0,
		};
	})()`) as never;
}

/** The person's account, and what it holds in ETH. */
async function account(
	page: Page,
): Promise<{address: string; balance: string}> {
	return page.evaluate(`(async () => {
		${READ}
		const address = read(world.context.account);
		const balance = await world.context.publicClient.getBalance({address});
		return {address, balance: balance.toString()};
	})()`) as never;
}

/**
 * Plan a turn through the planning store (`enterAt` out of the world, `stepTo`
 * in it), commit it, and wait for its reveal. Under the Manual cycle the
 * person's client commits no empty turn by itself (that is the clocked
 * policies' `commitWhenIdle`), so each cycle they play a move.
 */
async function playTurn(
	page: Page,
	how: 'enterAt' | 'stepTo',
	cell: {x: number; y: number},
) {
	await expect
		.poll(async () => (await boardState(page)).readyToPlay, {
			message: 'the board should take a turn',
			timeout: 120_000,
		})
		.toBe(true);
	await skipTutorial(page);
	await expect
		.poll(
			async () => {
				await page.evaluate(
					`globalThis.offlineWorld.context.game.planning.${how}(${JSON.stringify(cell)})`,
				);
				return (await boardState(page)).planned;
			},
			{message: 'a turn should be planned', timeout: 60_000},
		)
		.toBeGreaterThan(0);
	await page
		.getByRole('button', {name: /commit/i})
		.first()
		.click();
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

async function story(page: Page, mode: 'avatar' | 'eth', seats: number) {
	await page.goto('/offline/');
	await expect(page.getByText('How many at the table?')).toBeVisible({
		timeout: 60_000,
	});
	// THE TABLE IS OFFERED FIRST, in either mode, through the game's select
	await expect(page.getByTestId('mode-table')).toBeVisible();
	await page.getByTestId('mode-table').click();
	await page.getByTestId(`seats-${seats}`).click();
	await page.getByTestId('table-cycles').fill('2');
	await page
		.getByTestId('table-option-mode')
		.selectOption(mode === 'eth' ? '1' : '0');
	// RANDOM WORLD SEATS where the game offers levels (bomber-world, by
	// cascade): a random seat walks and never bombs, so nobody dies here
	for (const random of await page
		.locator('[data-testid^="level-"][data-testid$="-random"]')
		.all()) {
		await random.click();
	}
	await page.getByTestId('sit-down').click();

	// STARTED BY THE TAB: the panel, not the table's lobby, on cycle 1 of 2.
	// The panel is the signal the world is up, whatever chrome a game gives
	// its offline world (bomber-world shows no offline-world bar).
	const panel = page.getByTestId('table-panel');
	await expect(panel).toBeVisible({timeout: 180_000});
	await expect(page.getByTestId('table-lobby')).toHaveCount(0);
	await expect(panel.getByTestId('table-progress')).toHaveText('Cycle 1 of 2', {
		timeout: 60_000,
	});
	const names = panel.getByTestId('table-seats');
	await expect(names).toContainText('You');
	await expect(names.getByText('The world', {exact: true})).toHaveCount(
		seats - 1,
	);

	// EVERY SEAT AT THE TABLE, by the mode's rail, and nobody in the world
	const opened = (await tableOnChain(page))!;
	expect(opened).toMatchObject({
		tables: 1,
		ended: false,
		mode: mode === 'eth' ? 1 : 0,
		seated: seats,
		inTheWorld: 0,
	});
	expect(opened.last).toBe(opened.cycleNumber + 1);
	const stake = BigInt(opened.stake);
	expect(stake > 0n).toBe(true);
	const me = await account(page);
	for (const seat of opened.seats) {
		// an ETH seat is its own account; an avatar seat's id begins with it
		if (mode === 'eth') {
			expect(BigInt(seat.seat)).toBe(BigInt(seat.owner));
		} else {
			expect(BigInt(seat.seat) >> 96n).toBe(BigInt(seat.owner));
		}
	}
	expect(
		opened.seats.some(
			(seat) => seat.owner.toLowerCase() === me.address.toLowerCase(),
		),
	).toBe(true);
	// in ETH mode the table holds every seat's stake; in avatar mode the avatars carry it
	expect(BigInt(opened.balance)).toBe(
		mode === 'eth' ? BigInt(seats) * stake : 0n,
	);

	// CYCLE ONE: we enter
	await playTurn(page, 'enterAt', {x: 0, y: 1});
	await expect(panel.getByTestId('table-progress')).toHaveText('Cycle 2 of 2', {
		timeout: 120_000,
	});

	// A RELOAD INSIDE THE TABLE: the same table, on the cycle it was in
	await page.reload();
	await expect(panel.getByTestId('table-progress')).toHaveText('Cycle 2 of 2', {
		timeout: 180_000,
	});
	expect(await tableOnChain(page)).toMatchObject({
		address: opened.address,
		tables: 1,
		cycleNumber: opened.last,
	});

	// THE LAST CYCLE: a step, and then the TAB closes the table, with nothing
	// pressed
	await playTurn(page, 'stepTo', {x: 0, y: 2});
	await expect
		.poll(async () => (await tableOnChain(page))?.closed, {
			message: 'the tab should close the table after its last cycle',
			timeout: 180_000,
		})
		.toBe(true);
	const closed = (await tableOnChain(page))!;
	expect(closed).toMatchObject({
		ended: true,
		survivors: seats,
		leftovers: 0,
		alive: seats,
	});
	await expect(panel.getByTestId('table-progress')).toHaveText(
		'Ended after 2 cycles',
	);

	// THE WINNINGS, the person's own press
	const winnings = page.getByTestId('table-winnings');
	await expect(winnings).toBeEnabled({timeout: 60_000});
	await expect(winnings).toContainText('Take your winnings');
	const before = await tableOnChain(page);
	await winnings.click();
	await confirmIfAsked(page);
	if (mode === 'eth') {
		// the stake back: the table holds one fewer
		await expect
			.poll(async () => BigInt((await tableOnChain(page))!.balance), {
				message: 'the person should be paid the stake',
				timeout: 90_000,
			})
			.toBe(BigInt(before!.balance) - stake);
	} else {
		// the avatar back, out of the table's custody
		await expect
			.poll(
				() =>
					page.evaluate(`(async () => {
						${READ}
						const me = read(world.context.account);
						const seat = (await call(records.contracts.Game, 'getSeated')).find(
							(id) => (id >> 96n) === BigInt(me),
						);
						const owner = await call(records.contracts.Avatars, 'ownerOf', [seat]);
						return owner.toLowerCase() === me.toLowerCase();
					})()`),
				{message: 'the avatar should come back', timeout: 90_000},
			)
			.toBe(true);
	}
}

describe('A table in the offline world', () => {
	test('in avatar mode: one person and a world seat, entered, reloaded, closed by the tab, the avatar back', async ({
		page,
	}) => {
		test.setTimeout(8 * 60_000);
		await story(page, 'avatar', 2);
	});

	test('in ETH mode: one person and two world seats, each at the stake, closed by the tab, the stake back', async ({
		page,
	}) => {
		test.setTimeout(8 * 60_000);
		await story(page, 'eth', 3);
	});
});
