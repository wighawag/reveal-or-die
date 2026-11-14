/**
 * What this game acquires, and how: the seam the acquisition rail plugs into.
 *
 * This game stakes an AVATAR the contract holds, so what a new player has to
 * get is one of those. `AvatarsSale.purchase` mints and deposits in a SINGLE
 * transaction: it is given the Game's address as the recipient, so the NFT is
 * minted straight into the contract's custody and `avatarsPerOwner` reports it
 * immediately. There is no separate approve-and-transfer step, and there should
 * not be one, because the two-step version leaves an avatar sitting in a wallet
 * where it does nothing and looks like a bug.
 *
 * The OWNER is carried in `data` rather than being the recipient. That is the
 * whole trick of the arrangement: `to` is where the token goes (the Game), and
 * the encoded address is who it belongs to. `AvatarsSale._executeMint` decodes
 * it and packs it into the token id, which is why the id can be computed here
 * before the transaction is even sent.
 *
 * Everything else - who pays, the consent, the stipend, the signer registering
 * itself afterwards, and finding a purchase that outlived its tab - is
 * `$lib/game/acquire` and is not this game's to write.
 */
import type {Abi} from 'viem';
import type {TypedDeployments} from '$lib/core/connection/types';
import type {Acquisition} from '$lib/game/acquire';
import {
	purchaseArgs,
	purchaseValue,
	randomSubID,
} from 'reveal-or-die-contracts';
import type {WorldConfig} from './config';

/**
 * Gas to keep back when asking whether a payer can afford the purchase.
 *
 * A contract call with a value transfer, generously rounded: being short here
 * offers a payer who then fails in the wallet, while being generous only sends
 * someone to the other payment method a little early.
 */
const PURCHASE_GAS = 400_000n;

export function createAvatarAcquisition(params: {
	config: WorldConfig;
	deployments: TypedDeployments;
}): Acquisition {
	const {config, deployments} = params;
	return {
		address: config.sale.address,
		functionName: 'purchase',
		// what the wallet pays besides the stipend: the price and the stake the
		// avatar carries (step R1a)
		price: config.sale.price + config.sale.stake,
		stipend: config.sale.stipend,
		gas: PURCHASE_GAS,
		request: ({owner, stipendTo, stipend}) => ({
			abi: deployments.contracts.AvatarsSale.abi as Abi,
			// The packing and the argument order live in the CONTRACTS package
			// rather than here, deliberately: both have to match Solidity exactly,
			// and `contracts/test/js/Game.test.ts` purchases with `purchaseArgs` and
			// then commits for `avatarIDFor`, so both are pinned against a real
			// chain on every contract test run. A copy here would be a copy that can
			// drift.
			//
			// `subID` is RANDOM, which is what makes a second purchase a second
			// avatar rather than a collision with the first - and therefore why the
			// rail's guard against buying twice is about the player's money rather
			// than about tidiness.
			args: purchaseArgs({
				gameAddress: deployments.contracts.Game.address,
				owner,
				subID: randomSubID(),
				stipendTo,
				stipend,
			}),
			// `purchaseValue`, not the price. The sale subtracts the stipend from
			// `msg.value` and then requires the remainder to equal the price
			// EXACTLY, so the two have to be computed together or the purchase
			// reverts with `WrongPaymentAmount`.
			value: purchaseValue({
				price: config.sale.price,
				stake: config.sale.stake,
				stipend,
			}),
		}),
	};
}

/**
 * Re-exported so a caller does not have to reach past this module for them.
 *
 * Same reason as the packing above: they live in the contracts package because
 * they must match Solidity, and the contract test is what pins them.
 */
export {avatarIDFor, purchaseArgs} from 'reveal-or-die-contracts';
