import type {Page} from '@playwright/test';
import {test, expect, describe} from '../fixtures/test';

/**
 * The transaction inspector, driven the way a user reaches it.
 *
 * Its unit tests cover the registry's rules; this covers the wiring those rules
 * sit on: a real operation in account data, a real click, a real URL. The
 * symptom it exists to catch is precise, and would pass every unit test: the
 * URL gains `?operation=<id>` and no dialog appears. That was real, and its
 * cause was that SvelteKit's `pushState` deliberately leaves `page.url` on the
 * route the page is showing, so the app read a URL without the param it had
 * just written and closed the overlay it had just opened.
 */
describe.fixme('Transaction inspector', () => {
	// Sends transactions, so it takes its own burner account: files run in
	// parallel workers and two sending from the same account race for a nonce.
	//
	// Index 3 rather than 2, because `out-of-gas.e2e.ts` needs 2 for a stronger
	// reason: it deliberately fails a commit, and the game keys one open
	// commitment per player per epoch, so it must not share a player with any
	// suite that commits. This one only needs an account nobody else sends from.
	test.use({walletAccountIndex: 3});

	// And serially WITHIN the file, for the same reason: `fullyParallel` applies
	// to tests, not just files, so these three would otherwise race each other
	// from that one account. Same rule, same cause, as the demo suite.
	describe.configure({mode: 'serial'});

	// NOT YET RUNNING HERE, and deliberately left in place rather than deleted.
	//
	// This suite arrived from the template, where it submits a greeting. This app
	// has no greeting, so it never ran: it failed at `getByPlaceholder('Enter your
	// greeting...')`, which is not a finding about anything.
	//
	// It is now pointed at THIS app's `addToReserve` write, which exists and does
	// reach the chain (contracts.e2e.ts drives the same one). What it still lacks
	// is a transaction that stays PENDING long enough to inspect: the local node
	// mines immediately, so the navbar's pending badge - the signal this suite
	// waits on, and the app's own "something is in flight" flag - can appear and
	// clear inside a single poll interval.
	//
	// The honest source of a slow transaction here is the game's own commit, which
	// has real latency, but it is phase-dependent (one open commitment per player
	// per epoch, and it auto-commits as the phase closes), so wiring this to it is
	// a piece of game-specific test design rather than a fix. Left as the next
	// step, with the plumbing already done.

	/**
	 * Leave an operation in account data and land on the transactions page.
	 *
	 * Two things here are deliberate, and both were learned by watching this fail.
	 *
	 * The WAIT: account data records an operation only once the transaction is
	 * broadcast, so leaving straight after the click abandons the send and the
	 * page has nothing to list. The navbar's pending badge is the app's own signal
	 * that an operation now exists.
	 *
	 * The CLIENT-SIDE navigation: `page.goto` is a full load, and account data is
	 * persisted asynchronously, so a reload immediately after the badge appears
	 * can discard an operation that was only ever in memory. Going through the
	 * menu is both what a user does and what keeps the app alive.
	 *
	 * WHAT IS SENT: a contracts-page write, not a game move. The inspector needs
	 * ONE operation in account data and does not care where it came from, and the
	 * game's commit is the wrong instrument for that - it depends on the epoch
	 * phase, keys one open commitment per player, and auto-commits as the phase
	 * closes, so a suite that only wants "a transaction happened" would be racing
	 * the round for no reason. `addToReserve` is a plain account-sent write that
	 * exists on the deployed Game and needs no set-up, which is why
	 * contracts.e2e.ts uses it too.
	 *
	 * It also sends from the ACCOUNT rather than the local signer, so no
	 * authorisation flow stands in front of it. This used to submit the template's
	 * greeting, which this app does not have, and so failed at the first line.
	 */
	async function submitAndOpenTransactions(
		page: Page,
		connectWallet: (page: Page) => Promise<void>,
		amount: string,
	) {
		await page.goto('/contracts');

		// Wait for the connection to finish re-establishing after the navigation,
		// exactly as contracts.e2e.ts does. Interacting before it settles makes the
		// execute click open the connect modal instead of sending, and then nothing
		// is ever recorded - which is precisely the "no pending operation" this
		// suite was failing on.
		await expect(page.locator('[data-testid="wallet-status"]')).toHaveAttribute(
			'data-connected',
			'true',
			{timeout: 30000},
		);

		const writeTab = page.getByRole('tab', {name: 'Write'});
		await expect(writeTab).toBeVisible({timeout: 30000});
		await writeTab.click();

		const writeFunctionText = page.getByText('addToReserve nonpayable');
		await expect(writeFunctionText).toBeVisible({timeout: 30000});
		const form = page
			.locator('[class*="card"], [class*="function"]')
			.filter({has: writeFunctionText})
			.first();
		await form.getByPlaceholder('Enter number or 0x...').first().fill(amount);
		await form
			.getByRole('button', {name: /execut/i})
			.first()
			.click();

		await expect(
			page.locator('[data-testid="pending-operations"]'),
			'an operation should be recorded before leaving the page',
		).toBeVisible({timeout: 30000});

		const drawer = page.getByRole('dialog');
		await expect(async () => {
			await page.getByLabel('Open menu').click();
			await expect(drawer).toBeVisible({timeout: 2000});
		}).toPass({timeout: 30000});
		await drawer.getByRole('link', {name: /your transactions/i}).click();

		await expect(page.getByRole('heading', {name: 'Transactions'})).toBeVisible(
			{timeout: 10000},
		);
	}

	test('opens the inspector and puts the operation in the URL', async ({
		connectedPage,
		connectWallet,
	}) => {
		const page = connectedPage;
		await submitAndOpenTransactions(page, connectWallet, '0');

		const inspect = page.getByRole('button', {name: /inspect/i}).first();
		await expect(inspect).toBeVisible({timeout: 30000});
		await inspect.click();

		// Addressable: the operation id is in the URL, which is what makes the
		// inspector survive a reload and the back gesture close it.
		await expect(page).toHaveURL(/[?&]operation=/, {timeout: 10000});

		// And the modal is on screen. The bug was that this did not follow from
		// the URL having changed.
		await expect(page.getByRole('dialog')).toBeVisible({timeout: 10000});
		await expect(
			page.getByRole('dialog').getByText('Pending Transaction'),
		).toBeVisible();
	});

	test('closes on the back gesture, leaving the transactions page', async ({
		connectedPage,
		connectWallet,
	}) => {
		const page = connectedPage;
		await submitAndOpenTransactions(page, connectWallet, '0');

		await page
			.getByRole('button', {name: /inspect/i})
			.first()
			.click();
		await expect(page.getByRole('dialog')).toBeVisible({timeout: 10000});

		await page.goBack();

		await expect(page.getByRole('dialog')).toHaveCount(0);
		// The param goes with it: the overlay is not open, so it is not addressed.
		await expect(page).not.toHaveURL(/[?&]operation=/);
		await expect(
			page.getByRole('heading', {name: 'Transactions'}),
		).toBeVisible();
	});

	test('survives a reload, because it is in the URL', async ({
		connectedPage,
		connectWallet,
	}) => {
		const page = connectedPage;
		await submitAndOpenTransactions(page, connectWallet, '0');

		await page
			.getByRole('button', {name: /inspect/i})
			.first()
			.click();
		await expect(page.getByRole('dialog')).toBeVisible({timeout: 10000});

		const addressed = page.url();
		const operationId = new URL(addressed).searchParams.get('operation');
		expect(operationId, 'the inspector addresses an operation').toBeTruthy();

		// Account data is persisted asynchronously, so reloading the instant the
		// dialog appears can discard an operation that was still only in memory,
		// and the inspector then correctly reports it as gone. Wait for the write
		// first: this test is about the URL surviving a reload, not about racing
		// storage.
		await expect
			.poll(
				async () =>
					page.evaluate((id) => {
						for (let i = 0; i < localStorage.length; i++) {
							const key = localStorage.key(i);
							if (key && (localStorage.getItem(key) ?? '').includes(id)) {
								return true;
							}
						}
						return false;
					}, operationId as string),
				{timeout: 15000},
			)
			.toBe(true);

		await page.goto(addressed);

		// The OPERATION is back, not merely some dialog: a cleared or unknown
		// operation now renders its own dialog too, so asserting on the dialog
		// alone would pass for the failure this test exists to catch.
		await expect(
			page.getByRole('dialog').getByText('Pending Transaction'),
		).toBeVisible({timeout: 30000});
	});
});
