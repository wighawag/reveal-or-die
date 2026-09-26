/**
 * This game's constants, read off the deployment.
 *
 * Everything here comes from the Game contract's `linkedData` (what the deploy
 * script recorded) rather than being duplicated in the front end, so changing
 * the phase durations or the move allowance in `contracts/deploy` cannot leave
 * the UI describing a different game from the one on chain.
 */
import type {TypedDeployments} from '$lib/core/connection/types';
import {resolveCycleConfig, type CycleConfig} from '$lib/game/core/cycle';
import {
	optionalBigInt,
	optionalNumber,
	readAddress,
	readBigInt,
	readNumber,
	type DeclaredValues,
} from '$lib/game/core/linked-data';

export type WorldConfig = {
	cycle: CycleConfig;
	/**
	 * How many Move actions one reveal may contain.
	 *
	 * The contract stops processing at this many (`MAX_MOVES` in
	 * `_forEachActions`) and silently ignores the rest, so the client has to
	 * enforce the same bound rather than let a player plan a turn that will be
	 * quietly truncated.
	 */
	numMoves: number;
	/**
	 * How many cycles an avatar may go without revealing before the contract
	 * kills it. It dies in the cycle after that.
	 *
	 * Read rather than assumed, because it is the whole of the only way to die
	 * in this game and the client is the ONLY thing that can ever explain a
	 * death: nothing on chain announces one - there is no event, and `life` is
	 * computed from how far `lastCycleNumber` has fallen behind - so the sentence the
	 * player is shown has to come from here.
	 *
	 * UNDEFINED FOR A DEPLOYMENT THAT PREDATES THE PARAMETER, in which case the
	 * explanation says what happened without a number rather than quoting one
	 * this build happens to believe. A wrong number in that sentence is worse
	 * than no number: it is the client telling the player the rules of a game
	 * that is not the one they are playing. `optionalNumber` in
	 * `game/core/linked-data.ts` is that distinction, and the argument for it
	 * is written there because every game on this template outlives a
	 * parameter eventually.
	 */
	numMissesAllowed?: number;
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

type GameLinkedData = DeclaredValues & {
	startTime: unknown;
	commitPhaseDuration: unknown;
	revealPhaseDuration: unknown;
};

/**
 * Gas to allow for one turn: a commit and the reveal that must follow it.
 *
 * Deliberately generous, and the reveal far more so than the commit. A commit
 * writes one hash; a reveal walks up to `numMoves` actions, each of which can
 * touch a zone index. Running out of gas mid-cycle is not a slow turn, it is a
 * missed reveal, which loses the turn AND blocks the next cycle until it is
 * acknowledged. Over-reserving costs a slightly larger first payment.
 */
const COMMIT_GAS = 100_000n;
const REVEAL_GAS = 5_000_000n;

/**
 * How many turns of gas a new player is given.
 *
 * The whole point of the stipend is that a player who has just bought an avatar
 * can play for a while without thinking about gas at all. When it does run out
 * the top-up flow is the remedy (and `resumeWhenGasArrives` picks the submission
 * back
 * up by itself), so this is a starting float rather than a budget.
 */
const TURNS_OF_GAS = 100n;

export function resolveWorldConfig(deployments: TypedDeployments): WorldConfig {
	const linkedData = deployments.contracts.Game.linkedData as GameLinkedData;

	const AvatarsSale = deployments.contracts.AvatarsSale;
	const saleData = AvatarsSale.linkedData as DeclaredValues;

	// The chain's own statement of the worst gas price it expects, which is what
	// the credits machinery upstream prices actions with too. A chain that does
	// not declare one gets NO stipend rather than a guessed one: the purchase
	// still works, and the signer is funded by the top-up flow.
	const worstGasPrice =
		optionalBigInt(deployments.chain.properties, 'expectedWorstGasPrice') ?? 0n;

	return {
		cycle: resolveCycleConfig(linkedData),
		numMoves: readNumber(linkedData, 'numMoves'),
		numMissesAllowed: optionalNumber(linkedData, 'numMissesAllowed'),
		avatarsAddress: readAddress(linkedData, 'avatars'),
		sale: {
			address: AvatarsSale.address,
			price: readBigInt(saleData, 'paymentAmount'),
			stipend: worstGasPrice * (COMMIT_GAS + REVEAL_GAS) * TURNS_OF_GAS,
		},
		cellSize: 10,
		camera: {
			initialVisible: {width: 24, height: 24},
			limits: {minWidth: 10, minHeight: 10, maxWidth: 100, maxHeight: 100},
		},
	};
}
