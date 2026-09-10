import {expect} from 'earl';
import {describe, it} from 'node:test'; // using node:test as hardhat v3 do not support vitest
import {network} from 'hardhat';
import {setupFixtures, avatarOwner} from './utils/index.js';
import {zeroAddress} from 'viem';

const {provider, networkHelpers} = await network.connect();
const {deployAll} = setupFixtures(provider);

/**
 * Getting set up to play, in one transaction.
 *
 * The client rail above this contract is what a player actually meets, and the
 * property it depends on is here: ONE call both puts something at risk and
 * funds the local key that will spend it. If those come apart, the rail is two
 * transactions again and the second one is sent from a wallet the first just
 * spent down.
 *
 * WHAT IS AT RISK IS THE ONLY THING THAT CHANGES ON THIS BRANCH. Upstream the
 * call mints an ERC20 and credits a reserve; here it mints an avatar straight
 * into the game's custody. The arguments, the value split and the exactness of
 * the payment check are the same, which is why `$lib/game/acquire` and this
 * game's `placement/acquisition.ts` do not have to know which one they are
 * talking to.
 *
 * The filename is upstream's, deliberately: see the note in
 * `deploy/020_deploy_stake_sale.ts` for why renaming it would cost more than
 * it is worth.
 */

function saleConfig(GameAvatarSale: {linkedData?: unknown}) {
	const data = GameAvatarSale.linkedData as {price: string};
	return {price: BigInt(data.price)};
}

async function balanceOf(
	provider: {request: (args: {method: string; params: unknown[]}) => unknown},
	address: `0x${string}`,
): Promise<bigint> {
	return BigInt(
		(await provider.request({
			method: 'eth_getBalance',
			params: [address, 'latest'],
		})) as string,
	);
}

async function nextAvatarID(env: any, GameAvatarSale: any): Promise<bigint> {
	return (
		((await env.read(GameAvatarSale, {
			functionName: 'lastAvatarID',
		})) as bigint) + 1n
	);
}

describe('GameAvatarSale', function () {
	it('puts an avatar at stake AND funds their play key, in one call', async function () {
		const {env, Game, GameAvatarSale, unnamedAccounts} =
			await networkHelpers.loadFixture(deployAll);

		const {price} = saleConfig(GameAvatarSale);
		const payer = unnamedAccounts[0];
		const signer = unnamedAccounts[1];
		const stipend = 12345n;

		const avatarID = await nextAvatarID(env, GameAvatarSale);
		const signerBefore = await balanceOf(provider, signer);

		await env.execute(GameAvatarSale, {
			account: payer,
			functionName: 'purchase',
			args: [payer, signer, stipend],
			value: price + stipend,
		});

		// BOTH, from one transaction. Asserting only the avatar would pass with
		// the stipend silently kept by the sale, which is the failure that leaves
		// a player staked and unable to move.
		//
		// And the avatar is IN THE GAME rather than in the buyer's wallet, which
		// is the difference between owning one and having one at stake.
		expect(await avatarOwner(env, Game, avatarID)).toEqual(payer);
		expect(await balanceOf(provider, signer)).toEqual(signerBefore + stipend);
	});

	it('gives the avatar to the PLAYER while somebody else pays', async function () {
		// The case an account with no wallet of its own depends on: it cannot send
		// anything, so somebody else's wallet sets it up. Only the player may end
		// up with the avatar, or "pay for a friend" would quietly buy one for the
		// payer.
		const {env, Game, GameAvatarSale, unnamedAccounts} =
			await networkHelpers.loadFixture(deployAll);

		const {price} = saleConfig(GameAvatarSale);
		const payer = unnamedAccounts[2];
		const player = unnamedAccounts[3];

		const avatarID = await nextAvatarID(env, GameAvatarSale);

		await env.execute(GameAvatarSale, {
			account: payer,
			functionName: 'purchase',
			args: [player, zeroAddress, 0n],
			value: price,
		});

		expect(await avatarOwner(env, Game, avatarID)).toEqual(player);
	});

	it('refuses a value that is not the price plus what it forwards', async function () {
		// The check is EXACT in both directions, and each direction is a real
		// client bug: sizing the value from the price alone leaves the stipend
		// taken out of the payment, and sending price plus stipend while naming
		// nobody to forward it to would leave the stipend stuck in the sale.
		const {env, GameAvatarSale, unnamedAccounts} =
			await networkHelpers.loadFixture(deployAll);

		const {price} = saleConfig(GameAvatarSale);
		const payer = unnamedAccounts[4];
		const signer = unnamedAccounts[5];
		const stipend = 1000n;

		await expect(
			env.execute(GameAvatarSale, {
				account: payer,
				functionName: 'purchase',
				args: [payer, signer, stipend],
				value: price,
			}),
		).toBeRejected();

		await expect(
			env.execute(GameAvatarSale, {
				account: payer,
				functionName: 'purchase',
				args: [payer, zeroAddress, 0n],
				value: price + stipend,
			}),
		).toBeRejected();

		// A stipend with nowhere to go is refused rather than kept.
		await expect(
			env.execute(GameAvatarSale, {
				account: payer,
				functionName: 'purchase',
				args: [payer, zeroAddress, stipend],
				value: price + stipend,
			}),
		).toBeRejected();
	});

	it('leaves the avatar usable: it can commit straight away', async function () {
		// The avatar is only worth buying if the game will let it play. Reading
		// custody alone would pass with an NFT the game never actually received,
		// since the custody record and the token transfer are different writes.
		const {
			env,
			Game,
			GameAvatarSale,
			unnamedAccounts,
			advanceToEpoch,
			getEpoch,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const {price} = saleConfig(GameAvatarSale);
		const player = unnamedAccounts[6];
		const {epoch: startEpoch} = getEpoch(await getTimestamp());
		await advanceToEpoch(startEpoch + 2, true);

		const avatarID = await nextAvatarID(env, GameAvatarSale);
		await env.execute(GameAvatarSale, {
			account: player,
			functionName: 'purchase',
			args: [player, zeroAddress, 0n],
			value: price,
		});

		await env.execute(Game, {
			account: player,
			functionName: 'makeCommitment',
			args: [
				avatarID,
				'0x000000000000000000000000000000000000000000000001',
				0n,
				zeroAddress,
			],
		});

		// Committed, so the avatar is pinned: this is the same property the
		// bonded reserve has upstream, expressed in custody.
		await expect(
			env.execute(Game, {
				account: player,
				functionName: 'withdrawAvatar',
				args: [avatarID, player],
				gas: 1000000n,
			}),
		).toBeRejected();
	});

	it('is the ONLY way an avatar can be minted', async function () {
		// THE RULE THIS BRANCH INHERITS FROM reveal-or-die, which shipped this
		// same NFT with an open `mint` and therefore with no stake at all: a
		// player who disliked what they had committed to could go quiet, lose the
		// avatar and mint another one for gas. A stake that costs nothing to
		// acquire is not a stake, and that voids the invariant the whole
		// framework rests on.
		//
		// The mechanism is one address, and the assertion is about the mechanism
		// rather than about the price: charging in an ERC20 later is a new sale
		// and one `setMinter` call, and this test keeps its meaning through that.
		const {env, GameAvatars, GameAvatarSale, unnamedAccounts} =
			await networkHelpers.loadFixture(deployAll);

		const stranger = unnamedAccounts[7];

		await expect(
			env.execute(GameAvatars, {
				account: stranger,
				functionName: 'mint',
				args: [stranger, 999999n, '0x'],
				gas: 1000000n,
			}),
		).toBeRejectedWith(`custom error 'NotMinter(`);

		// It is shut because exactly one address is open, and that address is a
		// sale that charges. Read from the deployment rather than assumed, so
		// this fails if the wiring in `020_deploy_stake_sale.ts` is dropped -
		// which would otherwise leave a deployment where NOBODY can mint and the
		// game cannot be entered at all.
		expect(
			String(
				await env.read(GameAvatars, {functionName: 'minter'}),
			).toLowerCase(),
		).toEqual(GameAvatarSale.address.toLowerCase());
	});
});
