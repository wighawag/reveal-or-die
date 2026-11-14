import {describe, expect, it} from 'vitest';
import {decodeAbiParameters, zeroAddress} from 'viem';
import {
	createAvatarAcquisition,
	createSeatAcquisition,
	createTableSeatAcquisition,
	purchaseArgs,
} from '$lib/world/acquisition';
import type {WorldConfig} from '$lib/world/config';
import type {TypedDeployments} from '$lib/core/connection/types';
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
 *
 * Everything ABOVE these arguments - who pays, the consent step, the stipend
 * pairing, the recovery of a purchase that outlived its tab - is the shared
 * acquisition rail and is tested at `test/lib/game/acquire/`.
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
		// already-minted. It is also what makes the rail's guard against buying
		// twice a question about the player's MONEY: a second attempt does not
		// collide with the first, it mints another avatar and charges again.
		const seen = new Set<bigint>();
		for (let i = 0; i < 64; i++) seen.add(randomSubID());
		expect(seen.size).toBe(64);
	});
});

describe('a seat at an ETH-mode table (step R1b)', () => {
	const TABLE = '0x000000000000000000000000000000000000ab1e' as const;
	const KEY = '0x2222222222222222222222222222222222222222' as const;
	const config = {
		sale: {address: GAME, price: 1n, stake: 100n, stipend: 7n},
	} as unknown as WorldConfig;
	const deployments = {
		contracts: {
			Game: {address: TABLE, abi: []},
			AvatarsSale: {address: GAME, abi: []},
		},
	} as unknown as TypedDeployments;
	const eth = createTableSeatAcquisition({config, deployments, stake: 100n});

	it("joins the table for its stake and forwards the key's stipend in the same call", () => {
		expect(eth.address).toBe(TABLE);
		expect(eth.functionName).toBe('join');
		expect(eth.price).toBe(100n);
		expect(
			eth.request({owner: PLAYER, stipendTo: KEY, stipend: 7n}),
		).toMatchObject({args: [KEY, 7n], value: 107n});
		// with no key to fund, nothing is forwarded
		expect(
			eth.request({owner: PLAYER, stipendTo: undefined, stipend: 0n}),
		).toMatchObject({args: [zeroAddress, 0n], value: 100n});
	});

	it('is the seat once the table reads as ETH mode, the avatar purchase otherwise', () => {
		let ethMode = false;
		const avatar = createAvatarAcquisition({config, deployments});
		const seat = createSeatAcquisition({avatar, eth, isEthMode: () => ethMode});
		expect(seat.address).toBe(GAME);
		expect(seat.functionName).toBe('purchase');
		ethMode = true;
		expect(seat.address).toBe(TABLE);
		expect(seat.functionName).toBe('join');
		expect(seat.price).toBe(100n);
		expect(
			seat.request({owner: PLAYER, stipendTo: KEY, stipend: 7n}).value,
		).toBe(107n);
	});
});
