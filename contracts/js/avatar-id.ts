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
 * `extraNativeTokenRecipient`/`extraNativeTokenAmount` are THE SIGNER STIPEND,
 * and they are the reason a new player needs only one transaction. The sale
 * forwards that amount to that address before it checks the price, so the same
 * call that puts an avatar in the game also puts gas in the key that will play
 * it. Without it the player has an avatar they cannot move, and funding the
 * signer separately means a second transaction from a wallet the first one just
 * emptied.
 *
 * `msg.value` must therefore be `price + stipend`: the contract subtracts the
 * stipend first and then requires the remainder to equal `PAYMENT_AMOUNT`
 * EXACTLY, so getting this pair out of step reverts with `WrongPaymentAmount`
 * rather than overpaying. `purchaseValue` below is the other half of this
 * function and they should be read together.
 *
 * `referrer` is unused machinery and stays zero.
 */
export function purchaseArgs(params: {
	/** Who receives the NFT. The GAME, so the avatar arrives deposited. */
	gameAddress: `0x${string}`;
	/** Who it belongs to. Encoded into `data`, and packed into the token id. */
	owner: `0x${string}`;
	subID: bigint;
	/** The local signer, which needs gas to commit and reveal. */
	stipendTo?: `0x${string}`;
	/** How much to forward to it, out of the same `msg.value`. */
	stipend?: bigint;
}) {
	const stipend = params.stipend ?? 0n;
	// A recipient with nothing to send is worse than no recipient: the contract
	// takes the `!= address(0)` branch and makes a zero-value call, which a
	// contract wallet can reject and turn into `FailedToTransferNativeToken`.
	const stipendTo = stipend > 0n ? (params.stipendTo ?? zeroAddress) : zeroAddress;

	return [
		params.gameAddress,
		params.subID,
		// There is no controller to name. Who may PLAY an avatar is delegation,
		// granted account-wide by the owner's signature, not fixed at deposit time.
		encodeAbiParameters([{type: 'address'}], [params.owner]),
		stipendTo,
		stipendTo === zeroAddress ? 0n : stipend,
		zeroAddress,
	] as const;
}

/**
 * What to send with those arguments.
 *
 * Its own function so the two cannot drift: the sale subtracts the stipend from
 * `msg.value` and then demands the remainder equal the price exactly, so a
 * caller that remembered the stipend in one place and forgot it in the other
 * gets `WrongPaymentAmount` and no avatar.
 */
export function purchaseValue(params: {price: bigint; stipend?: bigint}): bigint {
	return params.price + (params.stipend ?? 0n);
}
