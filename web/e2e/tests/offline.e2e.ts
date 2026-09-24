import {avatarIDFor} from 'reveal-or-die-contracts';
import {test, expect, describe} from '../fixtures/test';
import {boardState, skipTutorial} from '../fixtures/board';
import {seatsPlayedByTheWorld, tableOf} from '../../src/lib/game/lobby/seats';

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
 * and the units hold; neither has ever been able to say anything about this.
 *
 * IT CLAIMS NO WALLET ACCOUNT FROM THE SHARED POOL, and that is a fact about
 * this suite rather than an oversight. It sends plenty of transactions - eight
 * per round with three members - and every one of them is on a chain that
 * exists only inside this test's own page, from keys that world holds, on a
 * chain id minted for it. There is no shared nonce to race for, because
 * there is nothing shared.
 *
 * `test/e2e-account-claims.test.ts` decides which files need a claim by
 * SEARCHING THE SOURCE for the fixtures that connect a shared wallet, so a
 * comment naming those fixtures is indistinguishable from using them. Describe
 * them, do not spell them.
 *
 * IT READS THE APP'S OWN STORES RATHER THAN THE SCREEN, which is what
 * `fixtures/board.ts` already does and for the same reason: the board is a
 * canvas, so there is nothing to query in the DOM, and an assertion about what
 * the game BELIEVES fails with a value rather than with "element not found".
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT is timing. A test that pinned a round's
 * duration would fail on a busy machine and say nothing about the game. For the
 * record it runs in about three seconds, which is worth knowing only because it
 * is fast enough to look suspicious: a chain, this game's four deploys, a
 * sign-in, a delegation and eight transactions really do cost that little in a
 * worker.
 *
 * CHECKED FOR TEETH, and the first attempt at checking it was wrong in a way
 * worth recording. Disabling the played players' POLL changed nothing and the
 * test still passed - because `pokeWhenTheHumanActs` drives them too, so the
 * poll is a backstop and not the mechanism. Silencing their pass loop outright
 * fails this test at `Committed`: the reveal phase never opens, because
 * unanimity is never reached. That is the property this file exists to assert,
 * and it also proves the three parts that cannot be seen from outside - the
 * world declaring who it waits for, the attendance reader assembling the tally
 * from per-avatar reads, and the advance client refusing until it is unanimous.
 */

/**
 * The avatars the world plays, computed the way the world computes them.
 *
 * `avatarIDFor` from the contracts package rather than `offlineIdentityOf` from
 * `$lib/offline`: they are the same function, and importing the world module
 * into the playwright process would drag a chain implementation and an
 * IndexedDB persistence layer in with it for the sake of one line of
 * arithmetic.
 *
 * `tableOf(3)` because that is what pressing "Sit down" with the default takes,
 * and `seatsPlayedByTheWorld` because the seat model is what says which of them
 * the world holds a key for. Derived rather than written out, so a change to
 * the seat model is a change this test follows instead of one it contradicts.
 */
const PLAYED = seatsPlayedByTheWorld(tableOf(3)).map((seat) =>
	avatarIDFor(seat.address, 0n).toString(),
);

describe('Playing offline', () => {
	test('boots a world in the tab and plays a whole cycle in it', async ({
		page,
	}) => {
		// GUARDS THE GUARD. The final assertion counts how many of these reached
		// the board, so a seat model that stopped yielding any played seats would
		// make it `toBe(0)` and pass over a world where nobody but the human ever
		// acted. A table of three is one human and two played.
		expect(PLAYED).toHaveLength(2);

		await page.goto('/offline/');

		// THE LOBBY COMES FIRST, AND NOTHING HAS BOOTED YET. Membership is baked
		// into a world by provisioning - what enrols a player here is the game
		// holding their avatar - so how many seats there are has to be settled
		// before a chain exists. This press is not a gate in front of the game, it
		// is the one decision the game needs.
		await expect(page.getByText('How many at the table?')).toBeVisible({
			timeout: 60_000,
		});
		await page.getByTestId('sit-down').click();

		// The world is up: this strip is rendered by the route only once the
		// chain, the deploy and the connection have all happened.
		await expect(
			page.getByText('Everything below runs against a chain inside this tab'),
		).toBeVisible({timeout: 180_000});

		// The membership this world was provisioned with, on screen, because it
		// cannot be changed without starting a new one.
		await expect(page.getByText('3 seats at this table')).toBeVisible();

		// AND THE BOARD IS NOT GATED ON ANYTHING. There is nothing left to ask
		// for: the world bought every seat an avatar and gave it gas during
		// provisioning, and it registered the key this browser plays with in the
		// step that derived it. Asserted as a fact on the chain rather than as an
		// absent button, because an absent button is also what a world that never
		// got that far looks like.
		await expect
			.poll(
				() =>
					page.evaluate(`(() => {
					const read = (store) => {
						let value;
						const stop = store.subscribe((v) => (value = v));
						if (typeof stop === 'function') stop();
						return value;
					};
					const world = globalThis.offlineWorld;
					if (!world) return 'no world';
					const delegation = read(world.context.delegation);
					if (delegation.step !== 'Loaded') return delegation.step;
					return delegation.allowed === true ? 'allowed' : 'refused';
				})()`),
				{timeout: 120_000},
			)
			.toBe('allowed');

		// AND IT SAID SO. A step taken for the player still has to be one they
		// were told about: online this is a transaction they sign and pay for, and
		// meeting it for the first time there, unexplained, in front of a board
		// they have already decided to play, is the experience this sentence
		// exists to prevent.
		await expect(
			page.getByText('one transaction you sign and pay for'),
		).toBeVisible();

		// A manual cycle starts at 2 and moves for no reason except a transaction.
		await expect.poll(() => cycleNumber(page), {timeout: 60_000}).toBe(2);

		// The avatar the world bought this browser is in custody, which is this
		// game's whole answer to "something must be at stake".
		await expect
			.poll(async () => (await boardState(page)).deposited, {timeout: 120_000})
			.toBe(1);
		await expect
			.poll(async () => (await boardState(page)).readyToPlay, {
				timeout: 120_000,
			})
			.toBe(true);

		// PLAN AN ENTRY THROUGH THE CANVAS, because the click path is where the
		// bugs are. Not `planOnCanvas` from the board fixture: that one waits for
		// a play phase with seconds left on it, and a manual cycle has no clock at
		// all - `ManualCycleInfo` carries no timings, so `timeLeft` is zero
		// forever and the helper would time out waiting for a countdown that does
		// not exist. Out of the world a click is an Enter, and `enterAt` REPLACES
		// the plan rather than appending, so clicking twice plans the same single
		// action and retrying is safe.
		await expect
			.poll(
				async () => {
					await skipTutorial(page);
					if ((await page.locator('[role="dialog"]').count()) > 0) return 0;
					const box = await page.locator('canvas').boundingBox();
					if (!box) return 0;
					await page.mouse.click(
						box.x + box.width / 2 + 40,
						box.y + box.height / 2 + 30,
					);
					return (await boardState(page)).planned;
				},
				{message: 'clicking the board should plan an entry', timeout: 60_000},
			)
			.toBeGreaterThan(0);

		await page
			.getByRole('button', {name: /commit/i})
			.first()
			.click();

		// THE WHOLE CLAIM IN TWO ASSERTIONS. The reveal only happens if somebody
		// pushed the cycle after the commit - a reveal sent in the commit phase is
		// refused with `InCommitmentPhase` - and cycle 3 only happens if somebody
		// pushed it again after the reveal. Nothing in `web/src` could do either
		// until `game/core/advance.ts` and `world/advance.ts`, and nothing in
		// `contracts/src` could open a manual commit phase for it to push out of.
		//
		// AND THEY ARE A FAR STRONGER GATE THAN THEY LOOK, because the world
		// enrols THREE waited-for members and plays two of them. The reveal phase
		// cannot open until every one of them has committed and the next cycle
		// cannot start until every commitment has been opened - which here is the
		// CLIENT's guard rather than the contract's, since this game keeps no
		// attendance. So both assertions say the other two players ACTED.
		await expect
			.poll(async () => (await boardState(page)).step, {timeout: 120_000})
			.toBe('Revealed');
		await expect.poll(() => cycleNumber(page), {timeout: 120_000}).toBe(3);

		// AND THE OTHER TWO REACHED THE BOARD, which no count of transactions and
		// no phase assertion can tell you. A player that commits and reveals an
		// EMPTY turn satisfies every assertion above - it is a legal turn, it
		// writes `lastEpoch`, it counts as a reveal, and it leaves the human
		// looking at a board with one avatar on it.
		//
		// BY NAME, not by count. The ids are derived from the seat addresses the
		// same way the world derives them, so this cannot be satisfied by the
		// human's own avatar plus anything else that happens to be in view; and
		// `inGame` is the contract's own word for "has entered the maze", which
		// only a revealed Enter sets.
		await expect
			.poll(
				async () => {
					const onBoard = await page.evaluate(`(() => {
						const read = (store) => {
							let value;
							const stop = store.subscribe((v) => (value = v));
							if (typeof stop === 'function') stop();
							return value;
						};
						const world = globalThis.offlineWorld;
						if (!world) return [];
						const view = read(world.context.viewState);
						if (view.step !== 'Loaded') return [];
						return [...view.avatars.entries()]
							.filter(([, avatar]) => avatar.inGame)
							.map(([id]) => id.toString());
					})()`);
					return PLAYED.filter((id) => (onBoard as string[]).includes(id))
						.length;
				},
				{
					message: 'the two played seats should be standing in the maze',
					timeout: 120_000,
				},
			)
			.toBe(PLAYED.length);
	});
});

/** The cycle the world is in, read off the app's own tracker. */
async function cycleNumber(page: import('@playwright/test').Page) {
	return page.evaluate(`(() => {
		const read = (store) => {
			let value;
			const stop = store.subscribe((v) => (value = v));
			if (typeof stop === 'function') stop();
			return value;
		};
		const world = globalThis.offlineWorld;
		if (!world) return -1;
		return read(world.context.game.cycleInfo).currentCycleNumber;
	})()`);
}
