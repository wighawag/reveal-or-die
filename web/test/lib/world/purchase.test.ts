import {describe, expect, it} from 'vitest';
import {decodeAbiParameters, zeroAddress} from 'viem';
import {purchaseArgs} from '$lib/world/purchase';
import {
	avatarIDFor,
	ownerOfAvatarID,
	randomSubID,
} from 'reveal-or-die-contracts';

/**
 * Six positional arguments, two of which are addresses that mean opposite
 * things.
 *
 * `AvatarsSale.purchase(to, subID, data, tipTo, tipAmount, referrer)` takes the
 * recipient of the NFT as `to` and the OWNER encoded inside `data`. Here `to` is
 * the Game, so the avatar arrives already deposited, and the owner is the
 * player. Swapping them does not revert: it mints a perfectly good avatar into
 * the player's wallet, where `avatarsPerOwner` never sees it and every commit
 * fails. That failure is why this list is a pure function with a test rather
 * than an inline array.
 */

const GAME = '0x000000000000000000000000000000000000dead' as const;
const PLAYER = '0x1111111111111111111111111111111111111111' as const;

describe('the arguments to AvatarsSale.purchase', () => {
	it('sends the avatar to the GAME, not to the player', () => {
		const [to] = purchaseArgs({gameAddress: GAME, owner: PLAYER, subID: 1n});
		expect(to).toBe(GAME);
		expect(to).not.toBe(PLAYER);
	});

	it('names the player as the owner, in the data payload', () => {
		const [, , data] = purchaseArgs({
			gameAddress: GAME,
			owner: PLAYER,
			subID: 1n,
		});
		const [decoded] = decodeAbiParameters([{type: 'address'}], data);
		expect(decoded.toLowerCase()).toBe(PLAYER);
	});

	it('carries the subID through untouched', () => {
		const subID = 123456789n;
		const [, id] = purchaseArgs({gameAddress: GAME, owner: PLAYER, subID});
		expect(id).toBe(subID);
	});

	it('asks for no tip and no referrer', () => {
		// Both are `SaleViaNativePayment` machinery this game does not use, and a
		// non-zero tip recipient would silently take part of the payment, leaving
		// `paymentAmount != PAYMENT_AMOUNT` and reverting the purchase.
		const [, , , tipTo, tipAmount, referrer] = purchaseArgs({
			gameAddress: GAME,
			owner: PLAYER,
			subID: 1n,
		});
		expect(tipTo).toBe(zeroAddress);
		expect(tipAmount).toBe(0n);
		expect(referrer).toBe(zeroAddress);
	});
});

describe('the avatar id these arguments will produce', () => {
	/**
	 * The packing itself lives in the contracts package and is pinned against a
	 * real chain by `contracts/test/js/Game.test.ts`, which purchases with these
	 * arguments and then commits for this id. What is checked here is only that
	 * the app can name the avatar it is about to buy BEFORE the transaction is
	 * sent, which is what makes the purchase reportable.
	 */
	it('is derivable from the owner and subID alone', () => {
		expect(avatarIDFor(PLAYER, 0n)).toBe(BigInt(PLAYER) << 96n);
		expect(avatarIDFor(PLAYER, 7n)).toBe((BigInt(PLAYER) << 96n) + 7n);
	});

	it('round-trips back to the owner', () => {
		const id = avatarIDFor(PLAYER, randomSubID());
		expect(ownerOfAvatarID(id)).toBe(PLAYER);
	});
});

describe('the random subID', () => {
	it('fits in the uint96 the contract takes', () => {
		// A value that overflows uint96 would be truncated by abi encoding, so the
		// avatar minted would not be the one the client computed, and the client
		// would be left committing for an id that does not exist.
		const limit = 1n << 96n;
		for (let i = 0; i < 64; i++) {
			const subID = randomSubID();
			expect(subID).toBeGreaterThanOrEqual(0n);
			expect(subID).toBeLessThan(limit);
		}
	});

	it('does not repeat', () => {
		// Not a cryptographic claim, just enough to catch a generator that returns
		// a constant, which would make every second purchase revert as
		// already-minted.
		const seen = new Set<bigint>();
		for (let i = 0; i < 64; i++) seen.add(randomSubID());
		expect(seen.size).toBe(64);
	});
});
