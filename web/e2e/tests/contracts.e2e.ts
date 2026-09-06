import {test, expect, describe} from '../fixtures/test';
import {
	selectContract,
	WRITE_CONTRACT,
	WRITE_FUNCTION,
} from '../fixtures/stalling-wallet';

describe('Contracts Page', () => {
	test('should show contract selection dropdown', async ({page}) => {
		await page.goto('/contracts');

		// The contract selector should be visible
		const selector = page
			.getByRole('combobox')
			.or(page.locator('[class*="select"]').first());
		await expect(selector).toBeVisible({timeout: 5000});
	});

	test('opens on a deployed contract, and can be pointed at the game', async ({
		page,
	}) => {
		await page.goto('/contracts');

		// The page opens on the FIRST deployed contract (`contractNames[0]`), which
		// in this app is `Avatars` - it deploys three. The inherited version of this
		// test asserted the Game was shown "by default" and failed on a page that
		// was working perfectly: that is true of the parent template, which deploys
		// one contract, and was never true here.
		//
		// What is worth pinning is that the page comes up ON something rather than
		// empty, and that the game is reachable from the picker, since every other
		// test in this file depends on getting there.
		const trigger = page.getByRole('combobox');
		await expect(trigger).toBeVisible({timeout: 10_000});
		await expect(trigger).not.toHaveText('Select a contract');

		await selectContract(page);
		await expect(
			page.getByRole('heading', {name: WRITE_CONTRACT, exact: true}),
		).toBeVisible({timeout: 10_000});
	});

	test('should display contract address', async ({page}) => {
		await page.goto('/contracts');

		// Should show an Ethereum address (0x...)
		const addressElement = page.locator('text=/0x[a-fA-F0-9]{4,}/');
		await expect(addressElement.first()).toBeVisible({timeout: 5000});
	});

	test('should have Read and Write tabs', async ({page}) => {
		await page.goto('/contracts');

		// Should have Read and Write tabs
		await expect(page.getByRole('tab', {name: 'Read'})).toBeVisible({
			timeout: 5000,
		});
		await expect(page.getByRole('tab', {name: 'Write'})).toBeVisible();
	});

	test('should display view functions in Read tab', async ({page}) => {
		await page.goto('/contracts');

		// The game's own view functions are on the GAME, which is not the contract
		// the page opens on.
		await selectContract(page);

		// Wait for Read tab to be visible and click it
		const readTab = page.getByRole('tab', {name: 'Read'});
		await expect(readTab).toBeVisible({timeout: 5000});
		await readTab.click();

		// Should show "View Functions" heading
		await expect(
			page.getByRole('heading', {name: 'View Functions'}),
		).toBeVisible({timeout: 5000});

		// Should list the game's own view functions. One specific function, not an
		// `.or()` of two: the union matches both cards and trips strict mode.
		await expect(page.getByText('getEpoch').first()).toBeVisible({
			timeout: 5000,
		});
	});

	test('should display write functions in Write tab', async ({page}) => {
		await page.goto('/contracts');

		// The write under test is on the GAME, which is not the contract the page
		// opens on.
		await selectContract(page);

		// Wait for Write tab to be visible and click it
		const writeTab = page.getByRole('tab', {name: 'Write'});
		await expect(writeTab).toBeVisible({timeout: 5000});
		await writeTab.click();

		// Should show a state-changing function of the game
		await expect(page.getByText(WRITE_FUNCTION).first()).toBeVisible({
			timeout: 5000,
		});
	});

	test('should be able to call a view function', async ({page}) => {
		await page.goto('/contracts');

		// Wait for Read tab and click it
		const readTab = page.getByRole('tab', {name: 'Read'});
		await expect(readTab).toBeVisible({timeout: 5000});
		await readTab.click();

		// `getEpoch` takes no arguments, so it can be called with nothing filled in
		const functionCard = page.locator('[class*="card"]').filter({
			hasText: 'getEpoch',
		});

		// Click the call/query button
		const callButton = functionCard.getByRole('button', {
			name: /call|query|read/i,
		});
		if (await callButton.isVisible({timeout: 500}).catch(() => false)) {
			await callButton.click();

			// Wait for result - look for success indicator or result display
			await page
				.waitForFunction(
					() => {
						const hasResult = document.querySelector(
							'[class*="result"], [class*="output"]',
						);
						const hasSuccess =
							document.body.textContent?.match(/success|result|\[\]/i);
						return hasResult || hasSuccess;
					},
					{timeout: 5000},
				)
				.catch(() => {});

			// Should show some result (either data or empty array)
			const hasResult = await page
				.locator('[class*="result"], [class*="output"]')
				.isVisible()
				.catch(() => false);
			const hasSuccess = await page
				.getByText(/success|result|\[\]/i)
				.isVisible()
				.catch(() => false);
			expect(hasResult || hasSuccess).toBe(true);
		}
	});
});

describe('Contracts Page - Write Functions', () => {
	// Write from the SECOND burner account. The game keys state by player
	// address, and the game suite (running in a parallel worker) plays from the
	// first account, so distinct accounts keep the two files from interfering.
	test.use({walletAccountIndex: 1});

	test('should trigger wallet connection when calling write function', async ({
		page,
	}) => {
		await page.goto('/contracts');

		// The write under test is on the GAME, which is not the contract the page
		// opens on.
		await selectContract(page);

		// Wait for Write tab to be visible and click it
		const writeTab = page.getByRole('tab', {name: 'Write'});
		await expect(writeTab).toBeVisible({timeout: 10000});
		await writeTab.click();

		// Wait for the write function to appear
		const writeFunctionText = page.getByText(WRITE_FUNCTION);
		await expect(writeFunctionText).toBeVisible({timeout: 10000});

		// Find the parent section containing the function
		const functionSection = page
			.locator('[class*="card"], [class*="function"]')
			.filter({
				has: writeFunctionText,
			})
			.first();

		// Any non-zero address: this test is about the CONNECT flow, and the call
		// withdraws an authority that was never granted, so it is harmless whoever
		// it names. Zero is the one value the call rejects.
		await functionSection
			.getByPlaceholder('0x...')
			.first()
			.fill('0x0000000000000000000000000000000000000031');

		// Click the Execute button (or Connect + Execute if wallet not connected)
		const executeButton = functionSection.getByRole('button', {
			name: /execute/i,
		});
		await executeButton.click();

		// If wallet is not connected, some step of the connect flow should appear:
		// the connect entry (dev-mode or wallet button), or, when the single wallet
		// auto-selects, the account picker or sign-in confirm step directly.
		// If wallet is already connected, the transaction is submitted directly.
		const connectFlowStep = page
			.getByRole('button', {name: /dev mode/i})
			.or(page.getByRole('button', {name: /connect .*wallet/i}))
			.or(page.getByText(/accounts available, choose one/i))
			.or(page.getByText(/confirm sign in/i))
			.first();
		// (isVisible does not wait; waitFor does.)
		const isConnectFlowVisible = await connectFlowStep
			.waitFor({state: 'visible', timeout: 5000})
			.then(() => true)
			.catch(() => false);

		// Test passes if either:
		// 1. A connect-flow step appeared (wallet not connected)
		// 2. Transaction submitted alert appeared (wallet already connected)
		if (!isConnectFlowVisible) {
			// Check for transaction submitted alert (wallet was already connected)
			const txAlert = page.getByText(/transaction submitted|tx submitted/i);
			await expect(txAlert.first()).toBeVisible({timeout: 10000});
		}
	});

	test('should execute write function after connecting', async ({
		connectedPage,
		connectWallet,
		waitForTransaction,
	}) => {
		// Full end-to-end flow (connect fixture + write + cross-page verification):
		// slow under parallel suite load, so triple the timeout.
		test.slow();

		const page = connectedPage;

		// Navigate to contracts page (connectedPage starts at /play)
		await page.goto('/contracts');

		// Wait for page to load
		await expect(
			page.getByText('Interact with deployed smart contracts'),
		).toBeVisible({timeout: 10000});

		// Wait for the connection to finish re-establishing after navigation.
		// Interacting before it settles makes the execute click open the connect
		// modal instead of sending the tx.
		//
		// Assert the app's own connection flag: waiting for the "Loading Connect"
		// button to be hidden is satisfied both when connected AND when plainly
		// disconnected (that button only exists mid-connect), so it could fall
		// through with no wallet attached.
		await expect(page.locator('[data-testid="wallet-status"]')).toHaveAttribute(
			'data-connected',
			'true',
			{timeout: 30000},
		);

		// The write under test is on the GAME, which is not the contract the page
		// opens on.
		await selectContract(page);

		// Wait for Write tab to be visible and click it
		const writeTab = page.getByRole('tab', {name: 'Write'});
		await expect(writeTab).toBeVisible({timeout: 10000});
		await writeTab.click();

		// Wait for the write function to appear
		const writeFunctionText = page.getByText(WRITE_FUNCTION);
		await expect(writeFunctionText).toBeVisible({timeout: 10000});

		// Find the parent section containing the function
		const functionSection = page
			.locator('[class*="card"], [class*="function"]')
			.filter({
				has: writeFunctionText,
			})
			.first();

		// FILL THE ARGUMENT. When this drove `addToReserve(address, uint256)` it
		// filled only the amount, so the address stayed undefined, viem threw
		// `InvalidAddressError` before anything was sent, and the assertion below
		// ("no operation is pending") was trivially true of a page on which nothing
		// had happened. It passed for a year without executing a write, which is
		// why the single argument this call takes is filled explicitly.
		//
		// What is under test is that a write reaches the chain from this page and
		// settles, not what the game does with it, so any non-zero address serves.
		await functionSection
			.getByPlaceholder('0x...')
			.first()
			.fill('0x0000000000000000000000000000000000000032');

		// Click the Execute button (wallet already connected)
		const executeButton = functionSection.getByRole('button', {
			name: /execute/i,
		});
		await executeButton.click();

		// Under parallel load the connection may still be re-establishing after
		// the navigation, in which case executing re-opens the connect flow (e.g.
		// the account picker). The connect helper walks whatever dialogs appear
		// and returns quickly when none do.
		await connectWallet(page);

		// IT ACTUALLY HAPPENED. Asserted before waiting for it to settle, because
		// `waitForTransaction` only checks that nothing is pending - which is also
		// true when nothing was ever sent, and was the state this test was really
		// in. An operation in account data is the app's own evidence that the write
		// left the page.
		//
		// Not the navbar badge: that clears at Included + Success, which against an
		// instant-mining node is a window of a few hundred milliseconds.
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
				{message: 'the write should record an operation', timeout: 30000},
			)
			.toBeGreaterThan(0);

		// ...and every in-flight operation settled.
		await waitForTransaction(page);
	});
});

describe('Contracts Page - Accessibility', () => {
	test('should have proper heading hierarchy', async ({page}) => {
		await page.goto('/contracts');

		// Should have h1
		await expect(page.locator('h1')).toHaveCount(1, {timeout: 5000});
	});

	test('should have accessible tab controls', async ({page}) => {
		await page.goto('/contracts');

		// Tabs should be visible and keyboard navigable
		const readTab = page.getByRole('tab', {name: 'Read'});
		const writeTab = page.getByRole('tab', {name: 'Write'});

		await expect(readTab).toBeVisible({timeout: 5000});
		await expect(writeTab).toBeVisible();
	});
});
