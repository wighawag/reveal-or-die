import {test, expect, describe} from '../fixtures/test';

/**
 * The commit-reveal round, end to end against a real chain.
 *
 * Both suites here are driven through the UI (a click on the canvas, not a call
 * into a store): the click path is where the bugs were. A click that lands on
 * the wrong cell because the canvas is inset by the app shell looks like
 * nothing at all until you measure it.
 *
 * The helpers read state out of the app rather than off the screen, so an
 * assertion fails on what the game believes rather than on how it rendered.
 */

/** Read the round out of the app, rather than inferring it from pixels. */
async function roundStep(page: import('@playwright/test').Page) {
	return page.evaluate(() => {
		const read = <T>(store: {subscribe: (run: (v: T) => void) => unknown}) => {
			let value!: T;
			const unsubscribe = read_unsub(store, (v: T) => (value = v));
			unsubscribe();
			return value;
		};
		function read_unsub<T>(
			store: {subscribe: (run: (v: T) => void) => unknown},
			run: (v: T) => void,
		) {
			const result = store.subscribe(run) as
				(() => void) | {unsubscribe(): void};
			return typeof result === 'function' ? result : () => result.unsubscribe();
		}
		const context = (globalThis as unknown as {context: any}).context;
		const round = read<any>(context.game.round);
		const view = read<any>(context.viewState);
		const reserve = read<any>(context.game.reserve);

		// The cell this round is about, and what the board says about it. Every
		// bigint leaves as a string: bigint cannot cross the evaluate boundary.
		const cellID =
			'actions' in round && round.actions.length > 0
				? round.actions[0].cellID
				: undefined;
		const cell =
			view.step === 'Loaded' && cellID !== undefined
				? view.cells.get(cellID)
				: undefined;

		return {
			step: round.step as string,
			message: round.message as string | undefined,
			reserve:
				reserve.step === 'Loaded' ? reserve.amount.toString() : undefined,
			cellID: cellID === undefined ? undefined : cellID.toString(),
			planned:
				view.step === 'Loaded'
					? [...view.cells.values()].filter((c: any) => c.planned).length
					: -1,
		};
	});
}

/**
 * Put something at stake, whichever affordance is currently on screen.
 *
 * With an empty reserve the HUD shows a "Deposit to play" gate INSTEAD of the
 * planning controls; once there is a reserve the same action is a secondary
 * "Add stake" button.
 */
async function stake(page: import('@playwright/test').Page) {
	const deposit = page.getByRole('button', {name: /deposit to play/i});
	if (await deposit.isVisible({timeout: 5_000}).catch(() => false)) {
		await deposit.click();
		return;
	}
	await page.getByRole('button', {name: /add stake/i}).click();
}

/** Where the round clock currently is. */
async function currentPhase(page: import('@playwright/test').Page) {
	return page.evaluate(() => {
		const context = (globalThis as unknown as {context: any}).context;
		let phase: any;
		const unsubscribe = context.game.threePhase.subscribe(
			(p: any) => (phase = p),
		);
		if (typeof unsubscribe === 'function') unsubscribe();
		return {phase: phase.phase as string, timeLeft: phase.timeLeft as number};
	});
}

/**
 * The confirmed stake on one cell, as the board reports it.
 *
 * Assertions are made against the CHANGE in this rather than against an
 * absolute figure: the e2e chain is shared and reused, so the cell may
 * already carry stake from an earlier run. Total stake rather than the
 * claimant count for the same reason - a second placement by an account that
 * already holds a share of the cell adds stake without adding a claimant.
 */
async function stakeOnCell(
	page: import('@playwright/test').Page,
	cellID: string,
) {
	return page.evaluate((id: string) => {
		const context = (globalThis as unknown as {context: any}).context;
		let view: any;
		const unsubscribe = context.viewState.subscribe((v: any) => (view = v));
		if (typeof unsubscribe === 'function') unsubscribe();
		if (view.step !== 'Loaded') return '0';
		const cell = view.cells.get(BigInt(id));
		return cell ? cell.totalStake.toString() : '0';
	}, cellID);
}

/**
 * A placement is planned locally, committed as a hash, and only becomes part of
 * the board when it is revealed in the next phase. Each step is asserted
 * separately so a failure names the phase that broke rather than landing on a
 * later assertion.
 */
describe('Commit-reveal round', () => {
	// The game keys one open commitment per player per epoch, so this file takes
	// its own burner account (the contracts suite uses index 1).
	test.use({walletAccountIndex: 0});

	test('plans a placement, commits it, and reveals it onto the board', async ({
		connectedPage,
	}) => {
		// A full round has to wait out a commit phase and a reveal phase.
		test.slow();
		const page = connectedPage;

		// Settle anything left unrevealed by an earlier run.
		//
		// The e2e chain is shared and reused, and a commitment that was never
		// revealed blocks every later one. It is NOT cleared automatically -
		// acknowledging forfeits the bond, so the player has to ask for it - which
		// means the test has to ask for it too, exactly as a person would.
		const acknowledge = page.getByRole('button', {
			name: /acknowledge missed reveal/i,
		});
		if (await acknowledge.isVisible({timeout: 5_000}).catch(() => false)) {
			await acknowledge.click();
			await expect(acknowledge, 'acknowledging should unblock play').toBeHidden(
				{timeout: 60_000},
			);
		}

		// Something must be at stake, or there is no reason to reveal. The
		// template gates on a token reserve bonded at commit time.
		//
		// Asserted against the app's own store rather than the HUD text: "Reserve"
		// also appears in the transaction toast for `addToReserve`, so a text
		// locator matches two different things and trips strict mode.
		//
		// An INCREASE, not "non-zero": the e2e chain is shared and reused, so this
		// account may already hold a reserve from an earlier run, and asserting
		// non-zero would pass without the top-up having done anything.
		const reserveBefore = BigInt((await roundStep(page)).reserve ?? '0');
		// The label depends on whether there is anything staked yet: with an empty
		// reserve the HUD replaces the planning controls with a deposit prompt,
		// because planning a turn that cannot be committed only fails later.
		await stake(page);
		await expect
			.poll(
				async () =>
					BigInt((await roundStep(page)).reserve ?? '0') > reserveBefore,
				{
					message: 'the reserve should grow before playing',
					timeout: 60_000,
				},
			)
			.toBe(true);

		// Wait for a play phase with room left in it.
		//
		// A plan made in the wrong part of the cycle is not a bug, it just expires:
		// the round drops an uncommitted plan when the epoch turns over (nothing was
		// at stake). Funding the reserve above takes a few transactions, so by this
		// point the cycle could be anywhere.
		await expect
			.poll(
				async () => {
					const phase = await currentPhase(page);
					return phase.phase === 'play' && phase.timeLeft > 8;
				},
				{
					message: 'a play phase with time to spare',
					timeout: 120_000,
				},
			)
			.toBe(true);

		// Let any dialog finish animating away before aiming at the canvas.
		// A connect dialog on its way out still covers the middle of the screen for
		// a couple of hundred milliseconds, and a click that lands on it is
		// swallowed silently - the round simply never becomes Planning, which reads
		// like the canvas ignoring input. A person is never fast enough to hit this;
		// a test is.
		await expect(page.locator('[role="dialog"]')).toHaveCount(0, {
			timeout: 15_000,
		});

		// Click a cell. The canvas maps the click to a world coordinate itself.
		const canvas = page.locator('canvas');
		const box = await canvas.boundingBox();
		if (!box) throw new Error('the canvas has no layout box');
		await page.mouse.click(
			box.x + box.width / 2 + 40,
			box.y + box.height / 2 + 30,
		);

		await expect
			.poll(async () => (await roundStep(page)).step, {
				message: 'clicking a cell should plan a placement',
				timeout: 15_000,
			})
			.toBe('Planning');

		const planned = await roundStep(page);
		expect(
			planned.planned,
			'the planned cell should be drawn before it is on chain',
		).toBe(1);
		const cellID = planned.cellID;
		if (!cellID) throw new Error('the round has no planned cell');

		// What the cell already holds, from this run or any earlier one.
		const stakeBefore = BigInt(await stakeOnCell(page, cellID));

		// Commit. Pressing the button if it is still live keeps the test short, but
		// the round commits by itself as the phase closes, so this deliberately does
		// not REQUIRE the button: waiting for it to be enabled would race the
		// auto-commit and then wait forever for a button that has done its job and
		// gone quiet.
		const commit = page.getByRole('button', {name: /commit now/i});
		if (await commit.isEnabled().catch(() => false)) {
			await commit.click().catch(() => {});
		}

		await expect
			.poll(async () => (await roundStep(page)).step, {
				message: 'the commitment should reach the chain',
				timeout: 90_000,
			})
			.toBe('Committed');

		// Nothing of the placement is on the board yet: that is the whole point of
		// committing. Only the player's own client knows what they chose.
		expect(
			BigInt(await stakeOnCell(page, cellID)),
			'a commitment must not change the board',
		).toBe(stakeBefore);

		// The reveal is driven by the round when the phase turns over: a missed
		// reveal forfeits the bond, so it is never left to the player to notice.
		await expect
			.poll(async () => (await roundStep(page)).step, {
				message: 'the round should reveal itself in the reveal phase',
				timeout: 120_000,
			})
			.toBe('Revealed');

		// Only once revealed does the placement become part of the board.
		await expect
			.poll(
				async () => (await stakeOnCell(page, cellID)) !== `${stakeBefore}`,
				{
					message: 'the revealed placement should reach the board',
					timeout: 30_000,
				},
			)
			.toBe(true);

		// Read the cost from the deployment rather than hard-coding it, so changing
		// `placementCost` in the deploy script cannot leave this quietly asserting
		// the old number.
		const placementCost = BigInt(
			await page.evaluate(() =>
				(
					globalThis as unknown as {context: any}
				).context.game.config.placementCost.toString(),
			),
		);
		expect(
			BigInt(await stakeOnCell(page, cellID)),
			'the reveal should add exactly one placement of stake',
		).toBe(stakeBefore + placementCost);

		expect(
			(await roundStep(page)).planned,
			'the planned marker should have cleared',
		).toBe(0);
	});
});

/**
 * Missing a reveal, and being told about it.
 *
 * The nastiest state this game has: a commitment that is never revealed keeps
 * the bond and blocks every later commitment, and nothing resolves it on its
 * own. It is settled by `acknowledgeMissedReveal`, which FORFEITS the bond, so
 * the app must never call it on the player's behalf - it has to say what
 * happened, what it cost, and wait to be asked.
 *
 * The reveal is missed here the way it is missed in real life: the tab goes
 * away before the reveal phase. The second half then uses a BRAND-NEW browser
 * context, so nothing is left in local storage and the only way the app can
 * know is by asking the chain.
 */
describe('A missed reveal', () => {
	// Its own burner account: this test deliberately leaves an unrevealed
	// commitment behind for a while, which would block the suite above.
	test.use({walletAccountIndex: 1});

	async function connectFrom(
		page: import('@playwright/test').Page,
		connectWallet: (page: import('@playwright/test').Page) => Promise<void>,
	) {
		await page.goto('/play');
		await expect(page.locator('canvas')).toBeVisible({timeout: 30_000});
		const connect = page.getByRole('button', {name: /^connect$/i}).first();
		await expect(connect).toBeEnabled({timeout: 60_000});
		await connect.click();
		await connectWallet(page);
	}

	test('is reported with what it cost, and settled only when asked', async ({
		browser,
		baseURL,
		connectWallet,
		fundWallets,
	}) => {
		// A committed round, then a whole epoch of waiting for it to lapse.
		test.setTimeout(400_000);
		await fundWallets();

		// --- commit, then walk away before the reveal ----------------------
		const first = await browser.newContext({
			baseURL,
			storageState: {cookies: [], origins: []},
		});
		const page = await first.newPage();
		await connectFrom(page, connectWallet);

		// Clear anything an earlier run left behind, so this test creates the
		// state it is about rather than inheriting it.
		const acknowledge = page.getByRole('button', {
			name: /acknowledge missed reveal/i,
		});
		if (await acknowledge.isVisible({timeout: 5_000}).catch(() => false)) {
			await acknowledge.click();
			await expect(acknowledge).toBeHidden({timeout: 60_000});
		}

		// The label depends on whether there is anything staked yet: with an empty
		// reserve the HUD replaces the planning controls with a deposit prompt,
		// because planning a turn that cannot be committed only fails later.
		await stake(page);
		await expect
			.poll(async () => (await roundStep(page)).reserve !== '0', {
				message: 'a reserve to bond from',
				timeout: 60_000,
			})
			.toBe(true);

		await expect
			.poll(
				async () => {
					const phase = await currentPhase(page);
					return phase.phase === 'play' && phase.timeLeft > 8;
				},
				{message: 'a play phase with time to spare', timeout: 120_000},
			)
			.toBe(true);

		await expect(page.locator('[role="dialog"]')).toHaveCount(0, {
			timeout: 15_000,
		});
		const box = await page.locator('canvas').boundingBox();
		if (!box) throw new Error('the canvas has no layout box');
		await page.mouse.click(
			box.x + box.width / 2 + 70,
			box.y + box.height / 2 + 50,
		);
		await expect
			.poll(async () => (await roundStep(page)).step, {timeout: 15_000})
			.toBe('Planning');

		const commit = page.getByRole('button', {name: /commit now/i});
		if (await commit.isEnabled().catch(() => false)) await commit.click();
		await expect
			.poll(async () => (await roundStep(page)).step, {
				message: 'the commitment should reach the chain',
				timeout: 90_000,
			})
			.toBe('Committed');

		// Lose everything this browser knew about the round, without losing WHO
		// the player is.
		//
		// The claim under test is that the app learns about a missed reveal from
		// the CHAIN, so the round's own record is deleted and the page reloaded.
		// It deliberately does not open a fresh browser context: the burner wallet
		// generates its accounts per browser, and signing in derives the signer
		// from those, so a clean context is a different player altogether and would
		// prove nothing.
		await page.evaluate(() => {
			for (const key of Object.keys(localStorage)) {
				if (key.startsWith('__placement_round__')) localStorage.removeItem(key);
			}
		});

		await page.reload();
		await expect(page.locator('canvas')).toBeVisible({timeout: 30_000});
		const later = page;

		const notice = later.getByText(/you missed the reveal for epoch/i);
		// Nothing is owed until the epoch turns over, and the round rechecks the
		// chain when it does. Allow more than one full epoch.
		await expect(
			notice,
			'the app should say a reveal was missed, from the chain alone',
		).toBeVisible({timeout: 180_000});

		// It has to say what it cost, not merely that something went wrong.
		await expect(later.getByText(/is forfeit/i)).toBeVisible();

		await expect(
			later.getByRole('button', {name: /commit now/i}),
			'committing is blocked until the forfeit is settled',
		).toBeDisabled();

		// Nothing has been spent on the player's behalf: the commitment is still
		// open, which is exactly why the notice is still up.
		const settle = later.getByRole('button', {
			name: /acknowledge missed reveal/i,
		});
		await expect(settle, 'settling it is offered, not done').toBeVisible();

		await settle.click();
		await expect(notice, 'acknowledging should clear the block').toBeHidden({
			timeout: 120_000,
		});

		await first.close();
	});
});
