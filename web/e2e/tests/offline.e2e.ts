import {test, expect, describe} from '../fixtures/test';

/**
 * A WHOLE ROUND AGAINST A CHAIN IN THIS TAB.
 *
 * This is the only test in the tree that exercises the offline world end to
 * end, and it is the only one that can: everything it covers happens in a
 * BROWSER and nowhere else - the chain boots in a worker, `@rocketh/web` runs
 * this game's own deploy scripts against it, a generated wallet is announced
 * over EIP-6963, the app signs in over that wallet to derive the key it plays
 * with, and the cycle is pushed on by a transaction because the deployment
 * declares the MANUAL policy. `check` and `test:unit` prove the text compiles
 * and the units hold; they have never been able to say anything about this.
 *
 * IT CLAIMS NO WALLET ACCOUNT FROM THE SHARED POOL, and that is a fact about
 * this suite rather than an oversight. It sends plenty of transactions - eight
 * per round now that there are three players - and every one of them is on a
 * chain that exists only inside this test's own page, from keys that world
 * holds, on a chain id minted for it. There is no shared nonce to race for,
 * because there is nothing shared.
 *
 * AND IT IS A FAR STRONGER GATE THAN IT WAS, for free, because the world enrols
 * THREE waited-for members and plays two of them. The reveal phase cannot open
 * until every one of them has committed and the next cycle cannot start until
 * every commitment has been opened, so the two assertions at the bottom - a
 * reveal happening at all, and cycle 3 arriving - now say that the other two
 * players ACTED. Before there was anybody else to wait for, they said only
 * that `advanceCycle` was called.
 *
 * `test/e2e-account-claims.test.ts` decides which files need one by SEARCHING
 * THE SOURCE for the fixtures that connect a shared wallet, so a comment naming
 * those fixtures is indistinguishable from using them - this paragraph tripped
 * it and the suite failed for the collision it was explaining it could not
 * have. Describe them, do not spell them.
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT is timing. The measurements are in the
 * plan on the `work` branch; a test that pinned them would fail on a busy
 * machine and say nothing about the game. The timeouts below are unchanged from
 * when one player played alone, which is the honest thing to check after adding
 * two more: a three-player round is a small multiple of a one-player round and
 * not a different order of magnitude, so widening them would have hidden a slow
 * loop rather than accommodated an inherently slower game.
 */
describe('Playing offline', () => {
	test('boots a world in the tab and plays a whole cycle in it', async ({
		page,
	}) => {
		await page.goto('/offline/');

		// The world is up: this strip is rendered by the route only once the
		// chain, the deploy and the connection have all happened.
		await expect(
			page.getByText('Everything below runs against a chain inside this tab'),
		).toBeVisible({timeout: 120_000});

		// The board starts gated on ONE thing, which is the honest split: the
		// world gave the player a chain, contracts, gas and a stake, and only the
		// browser can give the key that plays and the authority to use it.
		await page.getByRole('button', {name: /authorise and carry on/i}).click();
		await page.getByText('Pay from your account').click();
		await page.getByRole('button', {name: /continue/i}).click();

		// The gate is gone once the key is authorised and funded.
		await expect(
			page.getByRole('button', {name: /authorise and carry on/i}),
		).toHaveCount(0, {timeout: 60_000});
		// ...and so is the dialog, which would otherwise swallow the click below.
		await expect(page.locator('[role="dialog"]')).toHaveCount(0, {
			timeout: 30_000,
		});

		// A manual cycle starts at 2 and moves for no reason except a transaction.
		await expect(page.getByText('cycle 2')).toBeVisible({timeout: 30_000});

		// Plan one placement, through the canvas, because the click path is where
		// the bugs are (see game.e2e.ts).
		const canvas = page.locator('canvas');
		await expect(canvas).toBeVisible({timeout: 30_000});
		const box = await canvas.boundingBox();
		if (!box) throw new Error('the canvas has no layout box');
		await page.mouse.click(
			box.x + box.width / 2 + 40,
			box.y + box.height / 2 + 30,
		);

		await page.getByRole('button', {name: /commit now/i}).click();

		// THE WHOLE CLAIM IN TWO ASSERTIONS. The reveal only happens if somebody
		// called `advanceCycle` after the commit - a reveal sent in the commit
		// phase is refused with `InCommitmentPhase` - and cycle 3 only happens if
		// somebody called it again after the reveal. Nothing in `web/src` did
		// either until `game/core/advance.ts`.
		await expect(
			page.getByText('Revealed. Your placements are on the board.'),
		).toBeVisible({timeout: 60_000});
		await expect(page.getByText('cycle 3')).toBeVisible({timeout: 60_000});

		// AND THE OTHER TWO PUT SOMETHING ON THE BOARD, which no count of
		// transactions can tell you. A player that committed and revealed an empty
		// turn would satisfy every assertion above and leave the human looking at a
		// board with one cell on it.
		//
		// The chain is minted for this page, so the board started EMPTY and an
		// absolute count is meaningful here - which it is not in the suites that run
		// against the shared local chain (see the stake fixture on why those assert
		// on a change). The claimant count rather than the stake, because a
		// placement is free on one branch of this template and a stake assertion
		// would be trivially true there.
		//
		// SUMMED OVER THE BOARD RATHER THAN COUNTING CELLS, which is the difference
		// between an assertion and a coin toss: three players placing one cell each
		// is three claimants however many of them chose the same cell, and a played
		// turn is a deterministic function of the cycle, so a collision would be a
		// permanent failure rather than a flake.
		await expect
			.poll(
				() =>
					page.evaluate(`(() => {
					let view;
					const stop = globalThis.context.viewState.subscribe((v) => (view = v));
					if (typeof stop === 'function') stop();
					if (view.step !== 'Loaded') return -1;
					return [...view.cells.values()].reduce((n, c) => n + c.numClaimants, 0);
				})()`),
				{timeout: 30_000},
			)
			.toBeGreaterThanOrEqual(3);
	});
});
