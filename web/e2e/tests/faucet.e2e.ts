import {test, expect} from '../fixtures/test';
import {boardState, waitUntilSetUpToPlay} from '../fixtures/board';

// Its own account, which no other suite funds, so it starts EMPTY: see
// test/e2e-account-claims.test.ts.
test.use({walletAccountIndex: 8});

const FAUCET_URL = (globalThis as any).process.env.E2E_FAUCET_URL as
	string | undefined;

test.describe('A player with no ETH', () => {
	test.skip(!FAUCET_URL, 'no faucet: run through scripts/run-e2e-tests.sh');

	// How a player on a LAN box (or any chain with a faucet) starts: a fresh
	// burner, nothing in it, and "Get ETH" in the insufficient-funds dialog,
	// which claims from the faucet (PUBLIC_FAUCET_API) and carries on. This
	// game's version of the template's suite, which buys a stake: the first
	// thing a player pays for here is an AVATAR, so the purchase is the gate's
	// own button (`stakeAnAvatar` in ../fixtures/board.ts drives the same one),
	// taken in steps because the dialog comes up in the middle of it.
	test('gets ETH from the faucet, and buys an avatar', async ({
		page,
		connectWallet,
	}) => {
		test.setTimeout(5 * 60_000);
		const claims: string[] = [];
		page.on('request', (request) => {
			if (request.url().startsWith(FAUCET_URL!)) claims.push(request.url());
		});

		await page.goto('/play');
		await expect(page.locator('canvas')).toBeVisible({timeout: 30_000});
		const connect = page.getByRole('button', {name: /^connect$/i}).first();
		await expect(connect).toBeEnabled({timeout: 60_000});
		await connect.click();
		await connectWallet(page, {fund: false});

		await page
			.getByRole('button', {name: /buy|get an avatar/i})
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
		const consent = page.getByRole('button', {name: /^(sign and buy|buy)$/i});
		if (await consent.isVisible({timeout: 10_000}).catch(() => false)) {
			await consent.click({timeout: 30_000});
		}
		// Walks whatever comes up, the insufficient-funds dialog included: its
		// "Get ETH" is the faucet.
		await connectWallet(page, {fund: false});

		await expect
			.poll(async () => (await boardState(page)).deposited ?? 0, {
				message: "the avatar should be in the contract's custody",
				timeout: 120_000,
			})
			.toBeGreaterThan(0);
		// AND THE KEY AUTHORISES ITSELF out of the stipend the purchase paid it,
		// with nothing more to press. On a LAN box that needs the chain's gas
		// price declared (`rocketh/config.ts`): without it the stipend came to
		// almost nothing and the gate asked the player to authorise by hand.
		await waitUntilSetUpToPlay(page);

		expect(claims, 'the faucet should have been asked for ETH').not.toEqual([]);
	});
});
