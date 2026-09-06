import {test, expect, describe} from '../fixtures/test';
import {name as APP_NAME} from '../../src/web-config.json';

/**
 * THE APP'S NAME COMES FROM THE APP, not from a literal here.
 *
 * `routes/+page.svelte` renders `src/web-config.json`'s `name` as both the
 * icon's `alt` and the hero heading, so that file is the single fact and this
 * suite reads the same one. Spelling "Jolly Roger" out instead made these tests
 * assert the TEMPLATE's identity rather than the app's, which is invisible for
 * as long as a descendant keeps the inherited name and breaks the moment one
 * does the first thing anybody does with a template: rename it. `reveal-or-die`
 * renamed itself and inherited two failures that had nothing to do with its
 * home page, which rendered perfectly.
 */
describe('Home Page', () => {
	test('should display the icon', async ({page}) => {
		await page.goto('/');

		// Check for the icon image, labelled with the app's own name.
		const icon = page.locator(`img[alt="${APP_NAME}"]`);
		await expect(icon).toBeVisible();
	});

	test('should have a link to the game', async ({page}) => {
		await page.goto('/');

		const playButton = page.getByRole('link', {name: /^play$/i}).first();
		await expect(playButton).toBeVisible();
		await expect(playButton).toHaveAttribute('href', /\/play/);
	});
});

describe('Home Page - Navigation', () => {
	test('should navigate to the game and back', async ({page}) => {
		await page.goto('/');

		const playLink = page.getByRole('link', {name: /^play$/i}).first();
		await expect(playLink).toBeVisible({timeout: 10000});

		// Go to the game. A click during SvelteKit hydration can be swallowed (the
		// router installs its handler mid-flight), so retry until the URL changes.
		await expect(async () => {
			await playLink.click();
			await page.waitForURL(/play/, {timeout: 3000});
		}).toPass({timeout: 15000});

		// The canvas is the game: it only mounts in the browser, so its presence
		// also says hydration got as far as running the page's own code.
		await expect(page.locator('canvas')).toBeVisible({timeout: 15000});

		// Navigate directly back to home using goto
		await page.goto('/');
		await page.waitForLoadState('load', {timeout: 15000});

		// Verify we're back on the home page by checking for its heading, which is
		// the app's own name (see the note at the top of this file).
		await expect(
			page.getByRole('heading', {name: APP_NAME, exact: true}),
		).toBeVisible({timeout: 10000});
	});
});
