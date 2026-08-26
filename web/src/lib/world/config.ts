/**
 * This game's constants, read off the deployment.
 *
 * Everything here comes from the Game contract's `linkedData` (what the deploy
 * script recorded) rather than being duplicated in the front end, so changing
 * the phase durations or the move allowance in `contracts/deploy` cannot leave
 * the UI describing a different game from the one on chain.
 */
import type {TypedDeployments} from '$lib/core/connection/types';
import {resolveEpochConfig, type EpochConfig} from '$lib/game/core/epoch';

export type WorldConfig = {
	epoch: EpochConfig;
	/**
	 * How many Move actions one reveal may contain.
	 *
	 * The contract stops processing at this many (`MAX_MOVES` in
	 * `_forEachActions`) and silently ignores the rest, so the client has to
	 * enforce the same bound rather than let a player plan a turn that will be
	 * quietly truncated.
	 */
	numMoves: number;
	/** The avatar NFT, which is what a player has at stake. */
	avatarsAddress: `0x${string}`;
	/**
	 * Where an avatar is bought, and what it costs.
	 *
	 * Read off the SALE's own `linkedData` rather than the Game's, because the
	 * price is the sale contract's to state: `SaleViaNativePayment.purchase`
	 * reverts with `WrongPaymentAmount` unless `msg.value` matches `PAYMENT_AMOUNT`
	 * exactly, so a number copied anywhere else is a number that can drift into
	 * reverting every purchase.
	 */
	sale: {
		address: `0x${string}`;
		/** In the chain's native currency, exact. Not a minimum. */
		price: bigint;
	};
	/**
	 * Pixels per cell at 1:1 zoom.
	 *
	 * Only a scene-graph renderer cares: it is the unit pixi content is authored
	 * in. The camera and the click maths are in game units and do not use it.
	 */
	cellSize: number;
	/**
	 * What the camera may show, in CELLS.
	 *
	 * Here rather than in a canvas component because it is a statement about the
	 * GAME (how much world is readable at a glance), not about a rendering
	 * library, and because both canvas hosts have to agree on it.
	 */
	camera: {
		initialVisible: {width: number; height: number};
		limits: {
			minWidth: number;
			minHeight: number;
			maxWidth: number;
			maxHeight: number;
		};
	};
};

type GameLinkedData = {
	startTime: unknown;
	commitPhaseDuration: unknown;
	revealPhaseDuration: unknown;
	numMoves: unknown;
	avatars: unknown;
};

type SaleLinkedData = {
	paymentAmount: unknown;
};

export function resolveWorldConfig(deployments: TypedDeployments): WorldConfig {
	const linkedData = deployments.contracts.Game.linkedData as GameLinkedData;

	const AvatarsSale = deployments.contracts.AvatarsSale;
	const saleData = AvatarsSale.linkedData as SaleLinkedData;

	return {
		epoch: resolveEpochConfig(linkedData),
		numMoves: Number(linkedData.numMoves as string | number | bigint),
		avatarsAddress: linkedData.avatars as `0x${string}`,
		sale: {
			address: AvatarsSale.address,
			price: BigInt(saleData.paymentAmount as string | number | bigint),
		},
		cellSize: 10,
		camera: {
			initialVisible: {width: 24, height: 24},
			limits: {minWidth: 10, minHeight: 10, maxWidth: 100, maxHeight: 100},
		},
	};
}
