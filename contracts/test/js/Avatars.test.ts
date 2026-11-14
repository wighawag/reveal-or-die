import {expect} from 'earl';
import {describe, it} from 'node:test'; // using node:test as hardhat v3 do not support vitest
import {network} from 'hardhat';
import {setupFixtures} from './utils/index.js';
import {avatarIDFor, purchaseArgs, salePriceOf} from '../../js/avatar-id.js';
import {encodeAbiParameters, zeroAddress} from 'viem';

const {provider, networkHelpers} = await network.connect();
const {deployAll} = setupFixtures(provider);

/**
 * An avatar has to COST something, and the mint is what enforces it.
 *
 * This is not a test about a price. `Avatars` is the thing AT STAKE in the
 * commit-reveal round - a missed reveal loses it after the configured number of
 * misses - and the framework's whole foundation is "something must be at stake,
 * or nobody has to reveal" (AGENTS.md). A free mint does not make the game
 * cheap, it makes the commitment meaningless: a player who dislikes what they
 * committed to goes quiet, loses the avatar, and mints another one for gas.
 *
 * `Avatars.mint` used to be `external` with NO ACCESS CONTROL, so all of that
 * was one call away, and `_safeMint` only rejects a tokenID that already
 * exists - so the free avatars were well-formed ones, at the ids the sale would
 * have produced.
 *
 * The tests below therefore assert the INVARIANT ("the sale is the only way to
 * get one") rather than the mechanism, so they keep their meaning if payment
 * later moves to an ERC20: what must stay true is that minting goes through
 * something that charges.
 */

/** The deposit payload the sale forwards: just the owner. */
const payloadFor = (owner: `0x${string}`) =>
	encodeAbiParameters([{type: 'address'}], [owner]);

/** Run `fn` and give back the error text, or '' if it did not throw. */
async function rejectionOf(fn: () => Promise<unknown>): Promise<string> {
	try {
		await fn();
		return '';
	} catch (e) {
		return String(e);
	}
}

describe('Avatars', function () {
	it('refuses a mint from anyone but the sale', async function () {
		const {env, Avatars, unnamedAccounts} =
			await networkHelpers.loadFixture(deployAll);

		const attacker = unnamedAccounts[0];
		const victim = unnamedAccounts[1];
		// A well-formed id, at exactly the slot the sale would have used. The
		// old bug was not that free avatars looked odd; they were identical.
		const avatarID = avatarIDFor(victim, 0n);

		const rejection = await rejectionOf(() =>
			env.execute(Avatars, {
				account: attacker,
				functionName: 'mint',
				args: [victim, avatarID, payloadFor(victim)],
			}),
		);

		// The REASON matters. A bare "it threw" check passes when the arguments
		// are simply wrong, which would leave this asserting nothing - the same
		// trap Game.test.ts calls out for `NotDelegate`.
		expect(rejection.includes('NotMinter')).toEqual(true);

		// And nothing was minted, which is the thing the player actually cares
		// about. Asserted separately because a revert that still had an effect
		// would satisfy the check above.
		const exists = await rejectionOf(() =>
			env.read(Avatars, {functionName: 'ownerOf', args: [avatarID]}),
		);
		expect(exists === '').toEqual(false);
	});

	it('mints through the sale, which is what makes it cost something', async function () {
		const {env, Game, Avatars, AvatarsSale, unnamedAccounts} =
			await networkHelpers.loadFixture(deployAll);

		const buyer = unnamedAccounts[0];
		const subID = 0n;
		const avatarID = avatarIDFor(buyer, subID);
		const price = salePriceOf(AvatarsSale.linkedData);

		// Guards the test: a price of zero would make every assertion here
		// vacuous, since paying nothing and paying the price would be the same
		// transaction.
		expect(price > 0n).toEqual(true);

		await env.execute(AvatarsSale, {
			account: buyer,
			functionName: 'purchase',
			args: purchaseArgs({
				gameAddress: Game.address,
				owner: buyer,
				subID,
			}),
			value: price,
		});

		// It went to the Game, because that is what the purchase payload asks
		// for, so the avatar exists and is in custody.
		const owner = await env.read(Avatars, {
			functionName: 'ownerOf',
			args: [avatarID],
		});
		expect(owner.toLowerCase()).toEqual(Game.address.toLowerCase());
	});

	it('refuses a purchase that underpays', async function () {
		const {env, Game, AvatarsSale, unnamedAccounts} =
			await networkHelpers.loadFixture(deployAll);

		const buyer = unnamedAccounts[0];
		const price = salePriceOf(AvatarsSale.linkedData);

		const rejection = await rejectionOf(() =>
			env.execute(AvatarsSale, {
				account: buyer,
				functionName: 'purchase',
				args: purchaseArgs({
					gameAddress: Game.address,
					owner: buyer,
					subID: 0n,
				}),
				value: price - 1n,
			}),
		);
		expect(rejection.includes('WrongPaymentAmount')).toEqual(true);
	});

	/**
	 * The deployment WIRES the mint, and until it does nothing can be minted at
	 * all. Worth asserting because `minter` defaults to zero: a deployment that
	 * forgot this step would fail loudly here rather than quietly shipping a
	 * game whose stake cost nothing.
	 */
	it('points the mint at the sale proxy, not the implementation', async function () {
		const {env, Avatars, AvatarsSale} =
			await networkHelpers.loadFixture(deployAll);

		const minter = await env.read(Avatars, {functionName: 'minter'});
		expect(minter.toLowerCase()).toEqual(AvatarsSale.address.toLowerCase());
		expect(minter).not.toEqual(zeroAddress);
	});

	it('lets only the minter admin re-point the mint', async function () {
		const {env, Avatars, namedAccounts, unnamedAccounts} =
			await networkHelpers.loadFixture(deployAll);

		const stranger = unnamedAccounts[0];
		const rejection = await rejectionOf(() =>
			env.execute(Avatars, {
				account: stranger,
				functionName: 'setMinter',
				args: [stranger],
			}),
		);
		expect(rejection.includes('NotMinterAdmin')).toEqual(true);

		// The admin CAN, which is the half that makes paying in another token a
		// new sale contract rather than a migration. A check that only ever
		// refuses is as broken as one that only ever allows.
		await env.execute(Avatars, {
			account: namedAccounts.admin,
			functionName: 'setMinter',
			args: [namedAccounts.admin],
		});
		const minter = await env.read(Avatars, {functionName: 'minter'});
		expect(minter.toLowerCase()).toEqual(namedAccounts.admin.toLowerCase());
	});
});
