import {expect, type Page} from '@playwright/test';

/**
 * The contracts page, as a place two kinds of suite have to drive.
 *
 * SEPARATE FROM stalling-wallet.ts, and the separation is load-bearing rather
 * than tidiness. `test/e2e-account-claims.test.ts` reads "imports
 * fixtures/stalling-wallet" as "drives the stalling wallet, and therefore
 * claims one of its accounts", which is exactly the right heuristic: that pool
 * exists so two suites cannot race for one address's nonce. When these locators
 * lived in that file, `contracts.e2e.ts` and `pending-operation.e2e.ts` - both
 * of which drive the BURNER - imported it for a form locator and were counted
 * as claiming stalling account 0 alongside the escape hatch. The guard fired,
 * correctly, on a claim none of them had made.
 *
 * So what is shared here is the PAGE: which contract, which write, which form,
 * which button. Who is asked to sign it is the caller's business.
 */

/**
 * The write this fixture drives, named once.
 *
 * `revokeDelegate`, this app's own, for the reasons in `sendAndStall` above. The
 * suites import it rather than restating it, because a suite that asserts on a
 * form has to be looking at the form that was actually filled.
 */
export const WRITE_FUNCTION = 'revokeDelegate nonpayable';

/** The contract `sendAndStall` drives, which is NOT the one the page opens on. */
export const WRITE_CONTRACT = 'Game';

/**
 * Put the contracts page on a named contract.
 *
 * The page opens on the FIRST deployed contract (`contractNames[0]`), and this
 * app deploys three, so that is `Avatars` and the Game has to be asked for. The
 * template deploys one and never needed this, which is why the inherited walk
 * went straight to the Write tab and looked for a function that was on a
 * contract nobody had selected.
 *
 * Shared with `contracts.e2e.ts`, which drives the same page for its own
 * reasons: one definition of "how you get to a contract here".
 */
export async function selectContract(
	page: Page,
	name: string = WRITE_CONTRACT,
): Promise<void> {
	// BY `data-slot`, NOT BY ROLE. bits-ui renders the trigger as a plain
	// `button` whose accessible name is the selected contract, so
	// `getByRole('combobox')` matches nothing here.
	const trigger = page.locator('[data-slot="select-trigger"]');
	await expect(trigger).toBeVisible({timeout: 30_000});
	const selected = () => trigger.textContent().then((t) => (t ?? '').trim());
	// Already there: the page opens on one of them, and re-picking it is a no-op
	// that still costs a dropdown round trip.
	if ((await selected()) === name) return;

	await trigger.click();
	// EXACTLY, because the list is `Object.keys(deployments.contracts)` and a
	// routed proxy publishes a dozen of them: `Game`, but also `Game_Proxy`,
	// `Game_Implementation` and one entry per route. A substring match on "Game"
	// is ambiguous between all of them.
	await page
		.locator('[data-slot="select-item"]')
		.filter({hasText: new RegExp(`^\\s*${name}\\s*$`)})
		.first()
		.click({timeout: 30_000});
	await expect.poll(selected, {timeout: 30_000}).toBe(name);
}

/**
 * The write form `sendAndStall` drives, and its submit control.
 *
 * Exported because a suite asserts on the very control this clicked (that it
 * says "Executing..." and stops saying it), and two definitions of the same
 * locator is one definition too many.
 *
 * The submit control is matched on the STEM, so it is the same locator whether
 * it reads "Execute" or "Executing...". `/execute/i` matches only the first of
 * those, since "executing" does not contain "execute", and a test then reads as
 * though the button had vanished at exactly the moment it was busy.
 */
export const writeForm = (page: Page) =>
	page
		.locator('[class*="card"], [class*="function"]')
		.filter({has: page.getByText(WRITE_FUNCTION)})
		.first();

export const executeButton = (page: Page) =>
	writeForm(page).locator('button', {hasText: /execut/i});
