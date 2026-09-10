/**
 * What this game acquires, and how: the seam the acquisition rail plugs into.
 *
 * THIS BRANCH GATES ON CUSTODY OF AN AVATAR, so what a new player has to get is
 * a token, minted straight into the game where it is at stake from the moment
 * it exists. `GameAvatarSale.purchase` is one call that mints it AND funds the
 * local signer's gas, which is what lets the rail above this file be one
 * transaction end to end.
 *
 * IT IS THE SAME FILE AS UPSTREAM WITH TWO WORDS CHANGED, and that is the
 * measurement rather than a coincidence. `main`'s version says "a game that
 * gates differently (custody of an item the player bought, a pass) replaces
 * this file and nothing else: the rail takes the address, the function name,
 * the price, the stipend and the arguments, and has no opinion about what
 * arrives." This is that claim being cashed: the sale contract underneath is a
 * different contract doing a different thing, and the client difference is the
 * deployment it names and the gas it reserves.
 */
import type {Abi} from 'viem';
import type {TypedDeployments} from '$lib/core/connection/types';
import {acquisitionTotal, type Acquisition} from '$lib/game/acquire';
import type {PlacementConfig} from './config';

/**
 * Gas to keep back when asking whether a payer can afford the purchase.
 *
 * A contract call with a value transfer plus an ERC721 mint, the custody
 * record the game writes when it receives it, and the index entry that goes
 * with it - generously rounded. It is larger than the ERC20 figure upstream
 * because a mint writes more, and being short here offers a payer who then
 * fails in the wallet, while being generous only sends someone to the other
 * payment method a little early.
 */
const PURCHASE_GAS = 600_000n;

export function createStakeAcquisition(params: {
	config: PlacementConfig;
	deployments: TypedDeployments;
}): Acquisition {
	const {config, deployments} = params;
	return {
		address: config.sale.address,
		functionName: 'purchase',
		price: config.sale.price,
		stipend: config.sale.stipend,
		gas: PURCHASE_GAS,
		request: ({owner, stipendTo, stipend}) => ({
			abi: deployments.contracts.GameAvatarSale.abi as Abi,
			// `owner` first, then where the gas goes and how much of the value it
			// is. The owner is an ARGUMENT rather than `msg.sender` on purpose:
			// that is what lets a wallet pay for an account that has none of its
			// own, and buying somebody else an avatar is a gift, because only its
			// owner can ever play it or take it out.
			args: [
				owner,
				// The contract refuses a stipend with nowhere to go rather than
				// keeping it, so these two have to move together.
				stipendTo ?? '0x0000000000000000000000000000000000000000',
				stipend,
			],
			// The whole value, not the price. The sale subtracts the stipend from
			// `msg.value` and then requires the remainder to equal the price
			// EXACTLY, so the two have to be computed together or the purchase
			// reverts with `WrongPaymentAmount`.
			value: acquisitionTotal({price: config.sale.price, stipend}),
		}),
	};
}
