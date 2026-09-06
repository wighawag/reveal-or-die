import {expect, type Page} from '@playwright/test';

/**
 * Reading and driving THIS game's board, for the suites that play a round.
 *
 * A DELIBERATELY NEW PATH, not `fixtures/game.ts`. That file is the parent
 * template's game fixture and is listed in `.offshoot-omissions`: it reads a
 * per-cell `totalStake` off a board of cells, which this game does not have.
 * Writing this one beside it under a different name means the template can go
 * on changing its own fixture without ever conflicting with this, and the
 * omission stays a one-line lookup instead of a merge to re-decide.
 *
 * WHAT THIS GAME IS, since every assertion below depends on it. A player owns
 * an AVATAR, held in the game contract's custody - that custody is the bond,
 * and there is no token reserve and no per-cell stake. An avatar is either out
 * of the world or standing at a position. A turn is planned as a sequence of
 * actions (enter, move, exit), committed as a hash, and revealed in the next
 * phase; only the reveal puts anything on the board, which is the property the
 * commit-reveal round exists to have.
 *
 * Everything here reads the app's own stores rather than pixels. The board is a
 * canvas, so there is nothing to query in the DOM, and an assertion about what
 * the game BELIEVES fails with a value rather than with "element not found".
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

export type BoardState = {
	/** The commit-reveal round: Idle, Planning, Committing, Committed, Revealing, Revealed, Missed. */
	step: string;
	/** How many actions the player has planned this turn. */
	planned: number;
	/** The first planned action's kind and destination, if anything is planned. */
	plannedAction?: {type: string; to: {x: number; y: number}};
	/** Where the avatar IS, on chain. Undefined when it is out of the world. */
	position?: {x: number; y: number};
	/** How many avatars the contract holds for this account: what is at stake. */
	deposited?: number;
	/** Whether a turn could be taken right now. */
	readyToPlay: boolean;
};

/**
 * The board as the app currently understands it.
 *
 * NO BACKTICKS INSIDE THE EVALUATED BODY: it is a template literal, so one in a
 * comment ends the string and breaks the file.
 */
export async function boardState(page: Page): Promise<BoardState> {
	return page.evaluate(`(() => {
		${READ}
		const context = globalThis.context;
		const round = read(context.game.round);
		const plan = read(context.game.planning.plan);
		const position = read(context.game.currentPosition);
		const deposited = read(context.game.deposited);
		const planned = plan && plan.planned ? plan.planned : [];
		const first = planned[0];
		return {
			step: round.step,
			planned: planned.length,
			plannedAction: first
				? {type: first.type, to: {x: first.to.x, y: first.to.y}}
				: undefined,
			// Positions are plain numbers here; every bigint has to leave as a
			// string, because bigint cannot cross the evaluate boundary.
			position: position ? {x: position.x, y: position.y} : undefined,
			deposited:
				deposited.step === 'Loaded' ? deposited.avatars.length : undefined,
			readyToPlay: read(context.game.readyToPlay) === true,
		};
	})()`) as Promise<BoardState>;
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
 * Let this browser act for the account, if the app is asking.
 *
 * The signer sends the moves and the ACCOUNT owns the avatar, so a signer that
 * is not a registered delegate cannot commit at all. Optional because the gate
 * is only shown once per browser.
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
 * Clear an unrevealed commitment left behind by an earlier run.
 *
 * The e2e chain is shared and reused, and one missed reveal blocks every later
 * commitment until it is acknowledged, so a suite that did not do this would
 * fail on the previous run's leftovers rather than on anything of its own.
 */
export async function clearAnyMissedReveal(page: Page): Promise<void> {
	const acknowledge = page.getByRole('button', {
		name: /acknowledge|settle|got it/i,
	});
	if (!(await acknowledge.isVisible({timeout: 5_000}).catch(() => false)))
		return;
	await acknowledge.click({timeout: 30_000}).catch(() => {});
	await expect
		.poll(async () => (await boardState(page)).step, {
			message: 'a missed reveal should clear once acknowledged',
			timeout: 60_000,
		})
		.not.toBe('Missed');
}

/**
 * Put an avatar in the contract's custody, which is what this game bonds.
 *
 * THE BOND IS THE AVATAR. There is no reserve to top up: the HUD's setup gate
 * offers to buy one until the account holds one, and buying mints it straight
 * into the game. Driven through the UI rather than through `purchase.buy()` so
 * that the gate, the payer choice and the consent step are all exercised.
 *
 * Idempotent: it returns immediately when the account already holds an avatar,
 * which on a shared, reused chain is the normal case.
 */
export async function stakeAnAvatar(page: Page): Promise<void> {
	if (((await boardState(page)).deposited ?? 0) > 0) return;

	// The gate's own button. Its label carries the price, so it is matched on the
	// stem rather than in full.
	await page
		.getByRole('button', {name: /buy|get an avatar/i})
		.first()
		.click({timeout: 30_000});

	// WHICHEVER PAYER IS OFFERED. With only one method the flow skips the choice
	// entirely, so this acts only if the chooser is actually up.
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
	// before anything can be planned with it.
	await expect
		.poll(async () => (await boardState(page)).deposited ?? 0, {
			message: "an avatar should be in the contract's custody to play with",
			timeout: 120_000,
		})
		.toBeGreaterThan(0);
}

/**
 * Get the welcome overlay out of the way, which every fresh browser sees.
 *
 * NOT A MODAL, so waiting for `[role="dialog"]` to clear does not cover it: the
 * tutorial renders inline over the board and simply swallows the click, and the
 * failure then lands on "clicking the board should plan something" with a board
 * that never received the click. It appears once `readyToPlay` turns true and
 * is remembered in localStorage, so a fresh context - which is every test here -
 * always meets it.
 *
 * Skipped rather than toured: the tour is its own thing to test, and this is
 * the shortest honest way past it.
 */
export async function skipTutorial(page: Page): Promise<void> {
	const skip = page.getByRole('button', {name: /^skip$/i});
	// `isVisible()` is a SNAPSHOT, not a wait. Asking once returned false while
	// the overlay was still a moment away - it appears when `readyToPlay` turns
	// true, which is not when the board finishes loading - and the click then
	// went into the overlay that arrived immediately afterwards. Bounded, so an
	// app that never shows it costs one count.
	if ((await skip.count()) === 0) return;
	await skip.click({timeout: 5_000}).catch(() => {});
}

/**
 * Plan a turn by clicking the board, in a phase where the click counts.
 *
 * A click is only a click to the canvas; the game decides what it MEANS (see
 * `context/game.ts`): out of the world it chooses where to appear and replaces
 * the whole plan, in the world it appends one step. So this is the entry
 * planner, and the caller says how far from the middle to aim.
 *
 * Waits for a play phase with time left rather than clicking immediately: a
 * click during the commit lock or the reveal is ignored, and the failure would
 * otherwise land on the assertion after it.
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

	// CLICK UNTIL IT TAKES, clearing whatever is over the board first.
	//
	// Anything covering the canvas swallows the click silently, and the two
	// things that do are different: an ordinary modal, and the welcome overlay,
	// which is not a modal at all (see `skipTutorial`). Worse, the overlay
	// appears when `readyToPlay` turns true, which can be AFTER this helper
	// starts - so dismissing it once up front is a race this lost.
	//
	// Retrying is safe rather than merely convenient: out of the world a click
	// is an Enter, and `enterAt` REPLACES the plan instead of appending to it,
	// precisely so a player can re-pick a spawn by clicking elsewhere. Clicking
	// the same spot twice therefore plans the same single action.
	await expect
		.poll(
			async () => {
				await skipTutorial(page);
				if ((await page.locator('[role="dialog"]').count()) > 0) return 0;
				const box = await page.locator('canvas').boundingBox();
				if (!box) return 0;
				await page.mouse.click(
					box.x + box.width / 2 + offset.x,
					box.y + box.height / 2 + offset.y,
				);
				return (await boardState(page)).planned;
			},
			{
				message: 'clicking the board should plan something',
				timeout: 30_000,
			},
		)
		.toBeGreaterThan(0);
}
