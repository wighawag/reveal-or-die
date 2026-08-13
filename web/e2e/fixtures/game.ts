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
 * With an empty reserve the HUD shows a "Deposit to play" gate INSTEAD of the
 * planning controls; once there is a reserve the same action is a secondary
 * "Add stake" button.
 */
export async function stake(page: Page): Promise<void> {
	const deposit = page.getByRole('button', {name: /deposit to play/i});
	if (await deposit.isVisible({timeout: 5_000}).catch(() => false)) {
		await deposit.click();
		return;
	}
	await page.getByRole('button', {name: /add stake/i}).click();
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
