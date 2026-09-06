import {test, expect, describe} from '../fixtures/test';
import {
	authoriseToPlay,
	boardState,
	clearAnyMissedReveal,
	planOnCanvas,
	stakeAnAvatar,
} from '../fixtures/board';

/**
 * A commit-reveal round on THIS board, end to end in a real browser.
 *
 * WHY THIS FILE EXISTS RATHER THAN `game.e2e.ts`. The template's game suite
 * plays a different game - a placement staked on a CELL, asserted through that
 * cell's `totalStake` - and it is listed in `.offshoot-omissions` because none
 * of that exists here. This is the same three beats (plan, commit, reveal)
 * asserted against what this game actually has: an avatar, in or out of the
 * world, at a position.
 *
 * Its own path on purpose. The template can go on changing its own suite
 * without ever conflicting with this one, which is the whole point of omitting
 * that file rather than overwriting it.
 *
 * THE PROPERTY UNDER TEST is the one the round exists for: what is committed is
 * hidden until it is revealed. A test that only checked "the avatar ends up
 * where I clicked" would pass just as well against a game with no commit phase
 * at all, so the middle assertion - nothing on the board while the commitment
 * stands - is the one that would catch the round collapsing into a plain move.
 */
describe('A commit-reveal round', () => {
	// One open commitment per player per epoch, so this file takes its own burner
	// account (the contracts suite uses index 1).
	test.use({walletAccountIndex: 0});

	test('plans an entry, hides it until the reveal, and lands it on the board', async ({
		connectedPage,
		authoriseBrowser,
	}) => {
		// A full round has to wait out a commit phase and a reveal phase.
		test.slow();
		// Already on `/play` with the canvas mounted and a wallet connected: that
		// is what `connectedPage` is. Navigating again here tore the app down and
		// left `globalThis.context` undefined for the read below.
		const page = connectedPage;

		// WHO OWNS AND WHO SENDS ARE DIFFERENT ADDRESSES, and that is the design
		// rather than an implementation detail. A round is two transactions every
		// epoch, so sending them from the wallet would prompt twice a round for
		// ever; hence a local signer. But that signer is a key this browser made,
		// holding nothing and lost with the site data, so it must not BE the
		// player: the account owns the avatar, and the signer merely acts for it.
		const senders = await page.evaluate(() => {
			const context = (globalThis as unknown as {context: any}).context;
			const read = <T>(store: {
				subscribe: (run: (v: T) => void) => unknown;
			}) => {
				let value!: T;
				const stop = store.subscribe((v: T) => (value = v)) as
					(() => void) | {unsubscribe(): void};
				if (typeof stop === 'function') stop();
				else stop.unsubscribe();
				return value;
			};
			const signer = read<any>(context.signerExecutor);
			return {
				account: read<string | undefined>(context.account),
				signer: signer.status === 'ready' ? signer.address : undefined,
				identity: read<string | undefined>(context.game.identity),
			};
		});
		expect(senders.signer, 'the signer should be ready').toBeTruthy();
		expect(
			senders.signer?.toLowerCase(),
			'the sender must not be the account, or there is nothing to prove',
		).not.toBe(senders.account?.toLowerCase());
		// The claim that matters: the game's identity is the ACCOUNT. If it were
		// the signer, clearing site data would destroy the player along with the
		// avatar they have at stake, unrecoverably.
		expect(
			senders.identity?.toLowerCase(),
			'the game must play as the account, not as the key that signs',
		).toBe(senders.account?.toLowerCase());

		// The signer SENDS the moves, and one that is not a registered delegate of
		// the account cannot commit at all.
		await authoriseToPlay(page, authoriseBrowser);

		// A commitment left unrevealed by an earlier run on this shared chain
		// blocks every later one.
		await clearAnyMissedReveal(page);

		// THE BOND IS THE AVATAR: the contract holds one for this account, and
		// that custody is what the player has at risk. Idempotent, so a chain that
		// already has one costs nothing here.
		await stakeAnAvatar(page);

		// OUT OF THE WORLD FIRST, which is what makes the assertion after the
		// reveal mean something. If the avatar were already standing somewhere,
		// "it is on the board" would have been true before the round started.
		const before = await boardState(page);
		expect(
			before.position,
			'this round is about ENTERING, so the avatar must start out of the world',
		).toBeUndefined();

		// Plan the entry by clicking the board. Out of the world a click chooses
		// where to appear and is the whole turn.
		await planOnCanvas(page, {x: 40, y: 30});

		const planned = await boardState(page);
		expect(planned.step, 'planning should open the round').toBe('Planning');
		expect(
			planned.plannedAction?.type,
			'a click from out of the world plans an entry',
		).toBe('enter');
		expect(
			planned.position,
			'planning must not move the avatar: nothing is on chain yet',
		).toBeUndefined();
		const target = planned.plannedAction?.to;
		if (!target) throw new Error('the round planned nothing to enter with');

		// Commit. Pressing the button while it is live keeps the test short, but
		// the round also commits itself as the phase closes, so this deliberately
		// does not REQUIRE the button: waiting for it to be enabled would race the
		// auto-commit and then wait for ever for a button that has done its job.
		const commit = page.getByRole('button', {name: /commit now/i});
		if (await commit.isEnabled().catch(() => false)) {
			await commit.click().catch(() => {});
		}

		await expect
			.poll(async () => (await boardState(page)).step, {
				message: 'the commitment should reach the chain',
				timeout: 90_000,
			})
			.toBe('Committed');

		// THE ASSERTION THIS SUITE IS FOR. The commitment is on chain and the
		// avatar is still nowhere: only this browser knows where it is about to
		// appear. A round that put the avatar on the board here would have no
		// hidden phase at all, and every other assertion in this file would still
		// pass.
		expect(
			(await boardState(page)).position,
			'a commitment must not put anything on the board',
		).toBeUndefined();

		// The reveal is driven by the round when the phase turns over: an
		// unrevealed commitment blocks all further play, so it is never left to
		// the player to remember.
		await expect
			.poll(async () => (await boardState(page)).step, {
				message: 'the round should reveal itself in the reveal phase',
				timeout: 120_000,
			})
			.toBe('Revealed');

		// And only now is the avatar in the world, exactly where it was planned.
		await expect
			.poll(async () => (await boardState(page)).position, {
				message: 'the revealed entry should put the avatar on the board',
				timeout: 30_000,
			})
			.toEqual(target);

		expect(
			(await boardState(page)).planned,
			'the plan should have cleared once it resolved',
		).toBe(0);
	});
});
