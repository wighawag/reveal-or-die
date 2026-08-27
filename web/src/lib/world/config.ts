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
		/**
		 * What the purchase forwards to the local signer, in the same transaction.
		 *
		 * This is what makes onboarding ONE transaction rather than two: the sale's
		 * `extraNativeTokenRecipient` pays the signer before the price is checked,
		 * so the call that puts an avatar in the game puts gas in the key that will
		 * play it. Funding the signer separately means a second transaction from a
		 * wallet the first one just emptied, which is exactly the two-faucet-claim
		 * onboarding this replaced.
		 *
		 * Sized in TURNS rather than as a round number, because what the player
		 * actually needs is a number of moves: see `TURNS_OF_GAS`.
		 */
		stipend: bigint;
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

/**
 * Gas to allow for one turn: a commit and the reveal that must follow it.
 *
 * Deliberately generous, and the reveal far more so than the commit. A commit
 * writes one hash; a reveal walks up to `numMoves` actions, each of which can
 * touch a zone index. Running out of gas mid-round is not a slow turn, it is a
 * missed reveal, which loses the turn AND blocks the next epoch until it is
 * acknowledged. Over-reserving costs a slightly larger first payment.
 */
const COMMIT_GAS = 100_000n;
const REVEAL_GAS = 5_000_000n;

/**
 * How many turns of gas a new player is given.
 *
 * The whole point of the stipend is that a player who has just bought an avatar
 * can play for a while without thinking about gas at all. When it does run out
 * the top-up flow is the remedy (and `resumeWhenGasArrives` picks the round back
 * up by itself), so this is a starting float rather than a budget.
 */
const TURNS_OF_GAS = 100n;

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
			// The chain's own statement of the worst gas price it expects, which is
			// what the credits machinery upstream prices actions with too. A chain
			// that does not declare one gets no stipend rather than a guessed one:
			// the purchase still works, and the signer is funded by the top-up flow.
			stipend:
				BigInt(
					(deployments.chain.properties.expectedWorstGasPrice as
						string | number | undefined) ?? 0,
				) *
				(COMMIT_GAS + REVEAL_GAS) *
				TURNS_OF_GAS,
		},
		cellSize: 10,
		camera: {
			initialVisible: {width: 24, height: 24},
			limits: {minWidth: 10, minHeight: 10, maxWidth: 100, maxHeight: 100},
		},
	};
}
