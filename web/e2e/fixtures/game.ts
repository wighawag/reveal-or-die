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
	/** How many avatars the contract holds for this account: what is at stake. */
	deposited?: number;
	cellID?: string;
	planned: number;
}> {
	return page.evaluate(`(() => {
		${READ}
		const context = globalThis.context;
		const round = read(context.game.round);
		const view = read(context.viewState);
		// WHAT IS AT STAKE HERE IS AN AVATAR, not a token reserve. The template
		// bonds a balance per round and reports an amount; this game puts an NFT in
		// the contract's custody, so the question is HOW MANY are deposited rather
		// than how much. context.game.reserve does not exist here, and reading it
		// threw before any assertion ran.
		//
		// NO BACKTICKS IN HERE: this whole body is a template literal, so a
		// backtick in a comment ends the string and breaks the file.
		const deposited = read(context.game.deposited);
		const plan = read(context.game.planning.plan);

		// The cell this round is about, and what the board says about it. Every
		// bigint leaves as a string: bigint cannot cross the evaluate boundary.
		//
		// DEFENSIVE, because this shape is the TEMPLATE's. See stakeOnCell below:
		// that game plays cells, this one plays avatars at positions, so a round
		// here carries no cellID and this is undefined rather than throwing.
		const cellID =
			round && 'actions' in round && round.actions && round.actions.length > 0
				? round.actions[0].cellID
				: undefined;

		return {
			step: round.step,
			message: round.message,
			deposited:
				deposited.step === 'Loaded' ? deposited.avatars.length : undefined,
			cellID: cellID === undefined ? undefined : cellID.toString(),
			// WHAT THE PLAYER HAS PLANNED THIS EPOCH, read from the plan rather than
			// counted off the board. The template counts cells flagged as planned;
			// this game plans a sequence of avatar actions (enter / move / exit), so
			// the count lives on the plan itself and view.cells does not exist.
			planned: plan && plan.planned ? plan.planned.length : -1,
		};
	})()`) as Promise<{
		step: string;
		message?: string;
		deposited?: number;
		cellID?: string;
		planned: number;
	}>;
}

/**
 * Put an avatar at stake, which is what this game bonds.
 *
 * THE BOND IS THE AVATAR. The template stakes a token reserve and tops it up
 * with a "Deposit to play" / "Add stake" button; this game has neither string
 * anywhere in `src`, because an avatar in the contract's custody IS the stake.
 * Inheriting that helper meant clicking for a button that was never going to
 * exist, which is why the game suites failed before reaching anything they are
 * about.
 *
 * So the equivalent is the SETUP GATE's buy step: the HUD replaces the planning
 * controls with it until the account has an avatar, and buying one mints it
 * straight into the game. Driven through the UI rather than through
 * `purchase.buy()` so that the gate, the payer choice and the consent step are
 * all exercised: a test that reached past them would not notice the gate
 * refusing to open.
 *
 * Idempotent by intent: it returns as soon as the account holds an avatar, so a
 * suite that already has one pays nothing.
 */
export async function stakeAnAvatar(page: Page): Promise<void> {
	if (((await roundStep(page)).deposited ?? 0) > 0) return;

	// The gate's own button. Its label carries the price, so it is matched on the
	// stem rather than in full.
	await page
		.getByRole('button', {name: /buy|get an avatar|play/i})
		.first()
		.click({timeout: 30_000});

	// WHICHEVER PAYER IS OFFERED. With one method the flow skips the choice
	// entirely, so this clicks only if the chooser is up.
	const chooser = page.locator('[data-testid="purchase-payment-methods"]');
	if (await chooser.isVisible({timeout: 10_000}).catch(() => false)) {
		await page
			.locator('[data-testid="purchase-pay-with-account"]')
			.or(page.locator('[data-testid="purchase-pay-with-wallet"]'))
			.first()
			.click({timeout: 30_000});
	}

	// The consent step, when the purchase has something to sign.
	const consent = page.getByRole('button', {name: /^(sign and buy|buy)$/i});
	if (await consent.isVisible({timeout: 10_000}).catch(() => false)) {
		await consent.click({timeout: 30_000});
	}

	// Settled ON THE CHAIN, not on the button: the avatar has to be in custody
	// before anything can be committed with it.
	await expect
		.poll(async () => (await roundStep(page)).deposited ?? 0, {
			message: "an avatar should be in the contract's custody to play with",
			timeout: 120_000,
		})
		.toBeGreaterThan(0);
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
 * The confirmed stake on one cell, as the board reports it.
 *
 * Assertions are made against the CHANGE in this rather than against an
 * absolute figure: the e2e chain is shared and reused, so the cell may
 * already carry stake from an earlier run. Total stake rather than the
 * claimant count for the same reason - a second placement by an account that
 * already holds a share of the cell adds stake without adding a claimant.
 */
/**
 * THE TEMPLATE'S MODEL, AND NOT THIS GAME'S. Kept only because the suite that
 * calls it is `test.fixme`d against a rewrite; see the note there.
 *
 * It reads a per-cell `totalStake` off a board of cells. This game has neither:
 * avatars occupy positions, and what is bonded is the avatar itself rather than
 * an amount staked on a square. Any call returns '0' here.
 */
export async function stakeOnCell(page: Page, cellID: string): Promise<string> {
	return page.evaluate(
		`(() => {
			${READ}
			const view = read(globalThis.context.viewState);
			if (view.step !== 'Loaded') return '0';
			const cell = view.cells.get(BigInt('${cellID}'));
			return cell ? cell.totalStake.toString() : '0';
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
 * Conditional because the e2e chain is shared and reused: a browser whose
 * account is already authorised is not asked again, and demanding the prompt
 * would fail on the second run for no reason.
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

	const box = await page.locator('canvas').boundingBox();
	if (!box) throw new Error('the canvas has no layout box');
	await page.mouse.click(
		box.x + box.width / 2 + offset.x,
		box.y + box.height / 2 + offset.y,
	);

	await expect
		.poll(async () => (await roundStep(page)).step, {
			message: 'clicking a cell should plan a placement',
			timeout: 15_000,
		})
		.toBe('Planning');
}
