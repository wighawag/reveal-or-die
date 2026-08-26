import {test, expect, describe} from '../fixtures/test';

describe('Home Page', () => {
	test('should display the icon', async ({page}) => {
		await page.goto('/');

		// Check for the icon image
		const icon = page.locator('img[alt="Jolly Roger"]');
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

		// Verify we're back on home page by checking for the Jolly Roger heading
		await expect(page.getByRole('heading', {name: /jolly roger/i})).toBeVisible(
			{timeout: 10000},
		);
	});
});
