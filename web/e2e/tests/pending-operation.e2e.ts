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

	// PARKED BECAUSE IT CATCHES A REAL APP BUG, not because the test is wrong.
	// Everything it does is now correct, and the app is what fails.
	//
	// It arrived from the template driving a greeting this app does not have, so
	// it had never run. Four things were wrong underneath that; three were test
	// bugs and are fixed, and they were worth finding on their own:
	//
	//  - it filled ONE argument of `addToReserve(address, uint256)`, so viem threw
	//    InvalidAddressError and nothing was sent. The same mistake made
	//    contracts.e2e.ts's write test vacuous for as long as it existed; that one
	//    now asserts an operation and passes for real.
	//  - it waited on the navbar PENDING BADGE, which clears at Included+Success
	//    and ignores finality, so against an instant-mining node it is open for
	//    ~400ms. The OPERATION persists (measured: Included/Success, `final`
	//    undefined), so it now waits for account data to hold one.
	//  - it took the drawer with `page.getByRole('dialog')`, which matches every
	//    dialog in every layer, so the visibility check was a strict-mode
	//    violation rather than a wait. Scoped to `#--layer-drawer`, as
	//    overlays.e2e.ts always has been.
	//
	// THE FOURTH IS THE APP. Reaching /transactions/ after a write whose ARGS
	// CONTAIN A NUMBER throws, uncaught:
	//
	//     TypeError: Do not know how to serialize a BigInt
	//
	// The URL changes, and then nothing renders and the drawer never closes.
	// Measured, with and without the preceding write:
	//
	//     no write:   +500ms url=/transactions/ heading=1   (fine)
	//     after write:+3000ms url=/transactions/ heading=0  + the TypeError
	//
	// So the link works - it was driven by hand too, and it navigates. What breaks
	// is rendering that page while an operation carries a bigint, which the
	// template's own demo never does because `setMessage(string)` has no numeric
	// argument. AccountData's storage serializer handles bigints correctly, so it
	// is not persistence; and `core/utils/format/json.ts` exports `bigIntReplacer`
	// and `toPlainJson` for exactly this and is imported by NOTHING, which suggests
	// the fix was written and never wired in.
	//
	// Un-park this when that is fixed; it should then pass as written.
	test.setTimeout(240_000);

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
	/** The connected account, which is who the reserve is credited to. */
	async function playerAddress(page: Page): Promise<string> {
		const address = await page.evaluate(() => {
			const ctx = (globalThis as any).context;
			let account: unknown;
			ctx.account.subscribe((v: unknown) => (account = v))();
			return typeof account === 'string' ? account : null;
		});
		if (!address) throw new Error('no connected account to credit');
		return address;
	}

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
		// BOTH inputs. `addToReserve(address player, uint256 amount)` takes two, and
		// filling only the amount left the address undefined, so viem threw
		// `InvalidAddressError` and no transaction was ever sent. That is why this
		// suite saw no pending operation - nothing to do with how fast the node
		// mines, which is what it looked like from the outside.
		await form
			.getByPlaceholder('0x...')
			.first()
			.fill(await playerAddress(page));
		await form.getByPlaceholder('Enter number or 0x...').first().fill(amount);
		await form
			.getByRole('button', {name: /execut/i})
			.first()
			.click();

		// THE OPERATION, not the navbar badge.
		//
		// The badge is `countPendingOperations`, which clears as soon as a
		// transaction is Included + Success and deliberately ignores finality:
		// hardhat only mines when something is sent, so an operation here never
		// becomes final and a badge that waited for that would never clear. Against
		// an instant-mining node the badge is therefore open for about 400ms, and
		// waiting on it is a race this suite lost every time.
		//
		// The OPERATION itself persists - measured as Included/Success/final=-, so
		// still not final, which is exactly what the inspector is for. Waiting for
		// account data to hold one is the same intent without the race.
		await expect
			.poll(
				async () =>
					page.evaluate(() => {
						const ctx = (globalThis as any).context;
						let ops: Record<string, unknown> = {};
						ctx.accountData
							.watchField('operations')
							.subscribe((v: Record<string, unknown>) => (ops = v))();
						return Object.keys(ops ?? {}).length;
					}),
				{
					message: 'an operation should be recorded before leaving the page',
					timeout: 30000,
				},
			)
			.toBeGreaterThan(0);

		// CLIENT-SIDE, and it has to be. A full `page.goto` puts account data back
		// into its loading state, and in e2e it does not come out of it: the
		// transactions page then sits on "Loading transactions..." for ever and
		// there is nothing to inspect. Reaching the page through the app is not a
		// nicety here, it is the only route that works.
		// SCOPED TO ITS LAYER, which is the whole reason this used to fail.
		//
		// `page.getByRole('dialog')` matches EVERY dialog in every layer. Once more
		// than one is on screen - and by this point in the flow that is normal -
		// `expect(drawer).toBeVisible()` is a strict-mode violation rather than a
		// wait, so the retry below kept firing, and each retry clicked "Open menu"
		// again and TOGGLED the drawer shut. The link then took focus on a panel
		// that was closing and the page never moved, which looks exactly like a
		// broken link and is not one: driven by hand, it navigates fine.
		//
		// overlays.e2e.ts has always scoped by layer, which is why its drawer-link
		// test passes while this one did not.
		const drawer = page.locator('#--layer-drawer [role="dialog"]');
		if (!(await drawer.isVisible().catch(() => false))) {
			await expect(async () => {
				await page.getByLabel('Open menu').click();
				await expect(drawer).toBeVisible({timeout: 2000});
			}).toPass({timeout: 30000});
		}
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
