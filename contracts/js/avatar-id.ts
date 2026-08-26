/**
 * How an avatar's id is built.
 *
 * HERE RATHER THAN IN THE APP, for the same reason `commitmentHash` and
 * `zoneID` are here: it has to match Solidity exactly, and a mismatch is
 * neither a compile error nor a failed read. `AvatarsSale._executeMint`
 * computes the token id itself and mints it, so a client that derived a
 * different id would send its money, get an avatar, and then be unable to name
 * it: every `commit` afterwards reverts with an avatar the contract has never
 * heard of.
 *
 * Keeping it next to the Solidity means `contracts/test/js/Game.test.ts`
 * exercises this exact function against a real chain on every run: the test
 * purchases with these arguments and then commits for the id this returns, so a
 * wrong packing fails there rather than in a browser.
 */

import {encodeAbiParameters, zeroAddress} from 'viem';

/** `AvatarsSale._executeMint`: `(uint256(uint160(owner)) << 96) + subID`. */
export function avatarIDFor(owner: `0x${string}`, subID: bigint): bigint {
	return (BigInt(owner) << 96n) + subID;
}

/** The account an avatar id was minted for, recovered from the id. */
export function ownerOfAvatarID(avatarID: bigint): `0x${string}` {
	const address = (avatarID >> 96n) & ((1n << 160n) - 1n);
	return `0x${address.toString(16).padStart(40, '0')}` as `0x${string}`;
}

/** `subID` is a uint96 in the contract, so this is its exclusive upper bound. */
export const SUB_ID_LIMIT = 1n << 96n;

/**
 * A random `subID`.
 *
 * Random rather than derived from how many avatars the account already owns.
 * An index is guessable and therefore collides between two tabs of the same
 * account, and worse, it collides with ITSELF on a retry: a purchase whose
 * receipt was never seen but which did land would be retried onto the same id
 * and revert as already-minted, leaving the player unable to buy a second one.
 *
 * The cost of random is the opposite failure: a retry mints a SECOND avatar and
 * charges for it. That is why the purchase store refuses to run twice
 * concurrently, and why nothing retries this automatically.
 */
export function randomSubID(): bigint {
	const bytes = new Uint8Array(12); // 96 bits
	crypto.getRandomValues(bytes);
	let value = 0n;
	for (const byte of bytes) value = (value << 8n) | BigInt(byte);
	return value;
}

/**
 * The arguments to `AvatarsSale.purchase`, for a mint straight into the game.
 *
 * HERE, next to the id packing, and for the same reason. Six positional
 * arguments, two of which are addresses that mean opposite things: `to` is the
 * recipient of the NFT and the address encoded in `data` is its OWNER. This
 * game wants the Game contract to receive it (so it arrives already deposited)
 * on behalf of the player.
 *
 * Swapping those two does NOT revert. It mints a perfectly good avatar into the
 * player's own wallet, where `avatarsPerOwner` never reports it and every
 * `commit` fails for an avatar the game is not holding. A silent failure that
 * costs the player money is exactly the kind this package exists to pin: the
 * contract test purchases with THIS function and then commits for
 * `avatarIDFor(owner, subID)`, so a wrong order or a wrong payload fails there,
 * against a real chain, rather than in somebody's browser.
 *
 * `tipTo`/`tipAmount` and `referrer` are `SaleViaNativePayment` machinery this
 * game does not use. A non-zero tip recipient is not merely unused: it is
 * subtracted from `msg.value` before the price check, so it would revert the
 * purchase with `WrongPaymentAmount`.
 */
export function purchaseArgs(params: {
	/** Who receives the NFT. The GAME, so the avatar arrives deposited. */
	gameAddress: `0x${string}`;
	/** Who it belongs to. Encoded into `data`, and packed into the token id. */
	owner: `0x${string}`;
	subID: bigint;
}) {
	return [
		params.gameAddress,
		params.subID,
		// There is no controller to name. Who may PLAY an avatar is delegation,
		// granted account-wide by the owner's signature, not fixed at deposit time.
		encodeAbiParameters([{type: 'address'}], [params.owner]),
		zeroAddress,
		0n,
		zeroAddress,
	] as const;
}
