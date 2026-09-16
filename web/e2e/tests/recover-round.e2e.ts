import {test, expect, describe} from '../fixtures/test';
import {
	authoriseToPlay,
	boardState,
	clearAnyMissedReveal,
	currentPhase,
	planOnCanvas,
	stakeAnAvatar,
	stepInAnyDirection,
} from '../fixtures/board';

/**
 * A turn the chain holds and this browser has lost - worked out, not asked for.
 *
 * The situation is the ordinary one rather than an exotic mode: a cleared
 * browser, a second device, a private window, a reinstall and a storage write
 * that silently failed all produce the identical state. The contract holds a
 * commitment, a reveal is owed this cycle, and the client knows nothing about
 * it. Unhandled, the turn is lost and three of those in a row kill the avatar.
 *
 * WHAT THIS GAME DOES THAT THE TEMPLATE'S CANNOT. A turn here is a walk of at
 * most `numMoves` steps over walkable cells, and the maze keeps that small
 * enough to SEARCH: the app recomputes the secret, enumerates the walks and
 * hashes them until one matches what the chain is holding. So the player is
 * asked nothing and presses nothing, which is the assertion below - the round
 * comes back on its own. The template's game has to ask, because a turn there
 * is any subset of the cells on an open board.
 *
 * SHORTEST FIRST is why this is fast rather than merely possible. A turn of one
 * step is found within a handful of candidates; the thousands only get
 * enumerated when the answer is not there at all.
 *
 * IT ALL HAS TO HAPPEN INSIDE ONE CYCLE, which shapes the test: a commitment is
 * recoverable only while the cycle it belongs to is running, and one tick later
 * it is a missed reveal, which is a different suite's subject.
 */
describe('A turn the chain holds and this browser has lost', () => {
	// Its own burner account: this test deliberately leaves a commitment that
	// nothing can open for a few seconds, and one open commitment exists per
	// player per cycle. 2 is the signer-out-of-gas suite's.
	test.use({walletAccountIndex: 4});

	test('is found by searching, and revealed without asking the player', async ({
		connectedPage,
		authoriseBrowser,
	}) => {
		// Up to three full rounds: entering the world, then the round that is lost.
		test.setTimeout(400_000);
		const page = connectedPage;

		await authoriseToPlay(page, authoriseBrowser);
		await clearAnyMissedReveal(page);
		await stakeAnAvatar(page);

		// THE AVATAR HAS TO BE IN THE WORLD, and that is not setup dressing: the
		// search walks from where the avatar STANDS, so an avatar that is still
		// entering has no position to walk from and the app would correctly fall
		// back to asking. That case is covered by unit tests; this one is about
		// the search actually working.
		if ((await boardState(page)).position === undefined) {
			await planOnCanvas(page, {x: 40, y: 30});
			const commitEntry = page.getByRole('button', {name: /commit now/i});
			if (await commitEntry.isEnabled().catch(() => false)) {
				await commitEntry.click().catch(() => {});
			}
			await expect
				.poll(async () => (await boardState(page)).position !== undefined, {
					message: 'the avatar should enter the world',
					timeout: 180_000,
				})
				.toBe(true);
		}
		const home = (await boardState(page)).position;
		expect(
			home,
			'the avatar must be standing somewhere to walk from',
		).toBeDefined();

		// A play phase with room for everything that follows: the commit, losing
		// the round, a reload, and the search.
		await expect
			.poll(
				async () => {
					const phase = await currentPhase(page);
					return phase.phase === 'play' && phase.timeLeft > 15;
				},
				{message: 'a play phase with room in it', timeout: 120_000},
			)
			.toBe(true);

		// One step, in whichever direction the maze allows.
		await stepInAnyDirection(page);
		expect((await boardState(page)).planned, 'a step is planned').toBe(1);

		const commit = page.getByRole('button', {name: /commit now/i});
		if (await commit.isEnabled().catch(() => false)) {
			await commit.click().catch(() => {});
		}
		await expect
			.poll(async () => (await boardState(page)).step, {
				message: 'the commitment should reach the chain',
				timeout: 60_000,
			})
			.toBe('Committed');

		// Lose everything this browser knew about the turn, without losing WHO the
		// player is. A fresh browser context would be a different player: the
		// burner wallet generates its accounts per browser and the signer is
		// derived from those, so the secret would not come back and the test would
		// prove nothing.
		const cleared = await page.evaluate(() => {
			const keys = Object.keys(localStorage).filter((k) =>
				k.startsWith('__world_round_'),
			);
			for (const k of keys) localStorage.removeItem(k);
			return keys.length;
		});
		expect(cleared, 'there was a stored round to destroy').toBeGreaterThan(0);

		await page.reload();
		await expect(page.locator('canvas')).toBeVisible({timeout: 30_000});

		// THE WHOLE POINT. Nothing below touches the page: no click, no key, no
		// button. The app reads the chain, finds a commitment it has no round for,
		// recomputes the secret and searches the maze for the walk that hashes to
		// it. If the search were broken this would sit at `Idle` until the cycle
		// turned over and the suite would fail here.
		await expect
			.poll(async () => (await boardState(page)).step, {
				message: 'the lost turn should be worked out and adopted',
				timeout: 60_000,
			})
			.toBe('Committed');

		// And it was not done by asking: the notice that would have appeared is
		// the fallback, and this game did not need it.
		await expect(
			page.getByText(/this browser has lost the moves/i),
			'nothing should have been asked of the player',
		).toBeHidden();

		// A recovered round is a RESTORED round, so it reveals itself on the phase
		// change exactly like any other. Nothing was sent to recover it; the
		// commitment was already on chain.
		await expect
			.poll(async () => (await boardState(page)).step, {
				message: 'the recovered round should reveal itself',
				timeout: 180_000,
			})
			.toBe('Revealed');
	});
});
