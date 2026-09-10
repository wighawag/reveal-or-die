import {expect, type Page} from '@playwright/test';

/**
 * Reading the game out of the app, for tests that drive it through the UI.
 *
 * Shared by every game suite rather than copied into each: these read state out
 * of the app (`globalThis.context`) instead of off the screen, so an assertion
 * fails on what the game BELIEVES rather than on how it rendered, and the
 * evaluate-boundary details (every bigint has to leave as a string, a store
 * subscription has to be unsubscribed by hand) are subtle enough that a second
 * copy would drift.
 */

/** Subscribe, take the value, unsubscribe. Written for the page context. */
const READ = `
	const read = (store) => {
		let value;
		const stop = store.subscribe((v) => (value = v));
		if (typeof stop === 'function') stop();
		else if (stop && typeof stop.unsubscribe === 'function') stop.unsubscribe();
		return value;
	};
`;

/** Read the round out of the app, rather than inferring it from pixels. */
export async function roundStep(page: Page): Promise<{
	step: string;
	message?: string;
	reserve?: string;
	cellID?: string;
	planned: number;
}> {
	return page.evaluate(`(() => {
		${READ}
		const context = globalThis.context;
		const round = read(context.game.round);
		const view = read(context.viewState);
		const reserve = read(context.game.reserve);

		// The cell this round is about, and what the board says about it. Every
		// bigint leaves as a string: bigint cannot cross the evaluate boundary.
		const cellID =
			'actions' in round && round.actions.length > 0
				? round.actions[0].cellID
				: undefined;

		return {
			step: round.step,
			message: round.message,
			reserve: reserve.step === 'Loaded' ? reserve.amount.toString() : undefined,
			cellID: cellID === undefined ? undefined : cellID.toString(),
			planned:
				view.step === 'Loaded'
					? [...view.cells.values()].filter((c) => c.planned).length
					: -1,
		};
	})()`) as Promise<{
		step: string;
		message?: string;
		reserve?: string;
		cellID?: string;
		planned: number;
	}>;
}

/**
 * Put something at stake, whichever affordance is currently on screen.
 *
 * With an empty reserve the HUD shows the setup gate's own button INSTEAD of
 * the planning controls, and its label carries the price, so it is matched on
 * the stem; once there is a reserve the same action is a secondary "Add stake"
 * button. Both go through the acquisition rail.
 *
 * Driven through the UI rather than through `acquisition.buy()` so that the
 * gate, the payer choice and the consent step are all exercised.
 */
export async function stake(page: Page): Promise<void> {
	// BY TESTID, NOT BY LABEL. Both labels say what THIS game sells, and a game
	// that gates differently rewrites them: matching on the words made this
	// fixture fail on the first branch that sold an avatar instead of a bond,
	// thirty seconds at a time, with a timeout that named a button nobody had
	// removed. The testids are on the two controls in `GameHud.svelte`.
	const deposit = page.locator('[data-testid="acquire-stake"]');
	if (await deposit.isVisible({timeout: 5_000}).catch(() => false)) {
		await deposit.click();
	} else {
		await page.locator('[data-testid="acquire-more-stake"]').click();
	}

	// WHICHEVER PAYER IS OFFERED. With only one method the rail skips the choice
	// entirely, so this acts only if the chooser is actually up.
	const chooser = page.locator('[data-testid="acquire-payment-methods"]');
	if (await chooser.isVisible({timeout: 10_000}).catch(() => false)) {
		await page
			.locator('[data-testid="acquire-pay-with-account"]')
			.or(page.locator('[data-testid="acquire-pay-with-wallet"]'))
			.first()
			.click({timeout: 30_000});
	}

	// The consent step, when this purchase also has something to sign.
	const consent = page.getByRole('button', {name: /^(sign and buy|buy)$/i});
	if (await consent.isVisible({timeout: 10_000}).catch(() => false)) {
		await consent.click({timeout: 30_000});
	}
}

/** Where the round clock currently is. */
export async function currentPhase(
	page: Page,
): Promise<{phase: string; timeLeft: number}> {
	return page.evaluate(`(() => {
		${READ}
		const phase = read(globalThis.context.game.threePhase);
		return {phase: phase.phase, timeLeft: phase.timeLeft};
	})()`) as Promise<{phase: string; timeLeft: number}>;
}

/**
 * What one cell holds, as the board reports it.
 *
 * THE CLAIMANT COUNT HERE, AND THE TOTAL STAKE UPSTREAM, and the reason is the
 * whole difference this branch makes: a placement costs nothing when what is at
 * stake is custody of an avatar, so the stake on a cell never moves and an
 * assertion against it would be trivially true of a board nothing had reached.
 *
 * The claimant count is the right quantity here for a reason that does not hold
 * upstream, so this is a swap rather than a fix. The e2e chain is shared and
 * reused, and upstream the same burner ACCOUNT plays every run: its second
 * placement on a cell adds stake without adding a claimant, which is why that
 * one counts stake. Here every run BUYS AN AVATAR, so the identity is new every
 * time and a claim is always a new claim.
 *
 * Assertions are still made against the CHANGE rather than an absolute, because
 * the cell may already carry claims from an earlier run.
 */
export async function stakeOnCell(page: Page, cellID: string): Promise<string> {
	return page.evaluate(
		`(() => {
			${READ}
			const view = read(globalThis.context.viewState);
			if (view.step !== 'Loaded') return '0';
			const cell = view.cells.get(BigInt('${cellID}'));
			return cell ? String(cell.numClaimants) : '0';
		})()`,
	) as Promise<string>;
}

/**
 * Let this browser play for the account, if the board is asking.
 *
 * A fresh browser's signer is nobody's delegate, so `makeCommitment` would
 * revert with `NotDelegate`. The board asks for this before it will accept a
 * plan, so a test has to answer it exactly as a player does: press the button
 * and complete the flow, which registers the signer and funds its gas in one
 * transaction.
 *
 * Conditional, and now usually a no-op: the setup gate asks for the STAKE
 * first, and acquiring one authorises this browser in the same transaction, so
 * a fresh account never sees this button. It is still reachable for an account
 * that already has a stake and is opening a second browser, which on a shared,
 * reused e2e chain is a real case.
 */
export async function authoriseToPlay(
	page: Page,
	authoriseBrowser: (page: Page, options?: {via?: string}) => Promise<unknown>,
): Promise<void> {
	const button = page.getByRole('button', {name: /authorise and carry on/i});
	if (!(await button.isVisible({timeout: 10_000}).catch(() => false))) return;
	await button.click();
	await authoriseBrowser(page);
	await expect(button, 'authorising should let the board move on').toBeHidden({
		timeout: 60_000,
	});
}

/**
 * Settle anything an earlier run left unrevealed, exactly as a person would.
 *
 * The e2e chain is shared and reused, and an unrevealed commitment blocks every
 * later one. It is NOT cleared automatically - acknowledging FORFEITS the bond,
 * so the player has to ask for it - which means the test has to ask too.
 */
export async function clearAnyMissedReveal(page: Page): Promise<void> {
	const acknowledge = page.getByRole('button', {
		name: /acknowledge missed reveal/i,
	});
	if (await acknowledge.isVisible({timeout: 5_000}).catch(() => false)) {
		await acknowledge.click();
		await expect(acknowledge, 'acknowledging should unblock play').toBeHidden({
			timeout: 60_000,
		});
	}
}

/**
 * Wait for a play phase with room left in it, then click a cell on the canvas.
 *
 * A plan made in the wrong part of the cycle is not a bug, it just expires: the
 * round drops an uncommitted plan when the epoch turns over, since nothing was
 * at stake. `secondsNeeded` is how much of the play phase the caller still has
 * work to do in.
 *
 * The dialog check is not decoration. A connect dialog on its way out still
 * covers the middle of the screen for a couple of hundred milliseconds, and a
 * click that lands on it is swallowed silently - the round simply never becomes
 * Planning, which reads like the canvas ignoring input. A person is never fast
 * enough to hit this; a test is.
 */
export async function planOnCanvas(
	page: Page,
	offset: {x: number; y: number},
	secondsNeeded = 8,
): Promise<void> {
	await expect
		.poll(
			async () => {
				const phase = await currentPhase(page);
				return phase.phase === 'play' && phase.timeLeft > secondsNeeded;
			},
			{
				message: `a play phase with at least ${secondsNeeded}s left`,
				timeout: 120_000,
			},
		)
		.toBe(true);

	await expect(page.locator('[role="dialog"]')).toHaveCount(0, {
		timeout: 15_000,
	});

	await clickCanvas(page, offset);

	await expect
		.poll(async () => (await roundStep(page)).step, {
			message: 'clicking a cell should plan a placement',
			timeout: 15_000,
		})
		.toBe('Planning');
}

/**
 * Click a cell, with no wait for the clock.
 *
 * {@link planOnCanvas} is the one to reach for: waiting for room in the play
 * phase is what keeps a plan from expiring under the test. This is for the
 * case where the clock is already the thing under test and the wait would
 * defeat it - recovering a round has to finish inside the epoch the commitment
 * belongs to, so it cannot afford to wait for the NEXT play phase, which is by
 * definition too late.
 *
 * Clicks are gated on setup rather than on the phase (see the click handler in
 * `context/game.ts`), so this is a real affordance and not a test-only door.
 */
export async function clickCanvas(
	page: Page,
	offset: {x: number; y: number},
): Promise<void> {
	const box = await page.locator('canvas').boundingBox();
	if (!box) throw new Error('the canvas has no layout box');
	await page.mouse.click(
		box.x + box.width / 2 + offset.x,
		box.y + box.height / 2 + offset.y,
	);
}
