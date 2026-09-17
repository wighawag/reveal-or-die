/**
 * The template game's constants, read off the deployment.
 *
 * Everything here comes from the Game contract's `linkedData` (what the deploy
 * script recorded) rather than being duplicated in the front end, so changing
 * the phase durations or the placement cost in `contracts/deploy` cannot leave
 * the UI describing a different game from the one on chain.
 */
import type {TypedDeployments} from '$lib/core/connection/types';
import {resolveCycleConfig, type CycleConfig} from '$lib/game/core/cycle';
import {
	optionalBigInt,
	readAddress,
	readBigInt,
	readNumber,
	type DeclaredValues,
} from '$lib/game/core/linked-data';

export type PlacementConfig = {
	cycle: CycleConfig;
	/**
	 * What one placement costs.
	 *
	 * ZERO ON THIS BRANCH, and read from the deployment rather than assumed, so
	 * this file does not have to know that. What is at stake here is custody of
	 * the avatar rather than a bond, and a bond of zero is what lets a
	 * commitment be made against a reserve nothing ever funds.
	 */
	placementCost: bigint;
	/**
	 * THE CHUNK: how many actions one reveal transaction may carry.
	 *
	 * READ OFF THE DEPLOYMENT AND NEVER GUESSED. A turn longer than this is
	 * committed as a hash CHAIN and revealed in several transactions, and the
	 * client has to cut it into exactly the pieces the contract will accept: cut
	 * it larger and every reveal reverts with `TooManyActions`, cut it smaller
	 * and every non-final one reverts with `InvalidFurtherActions`. Either way
	 * the failure arrives after the stake is already bonded.
	 *
	 * `readNumber` rather than `optionalNumber`, deliberately. There is no safe
	 * default: a client that guessed would hash a chain the contract cannot
	 * follow, and would do it confidently. A deployment that does not declare
	 * this is one this build cannot play, and saying so at startup is much
	 * cheaper than saying it a cycle later with somebody's bond in the balance.
	 *
	 * IT IS THE ONLY THING BOUNDING A TURN ON THIS BRANCH. `main` bounds one
	 * economically - the reserve buys ten placements and no more - and here a
	 * placement costs nothing, because custody of the avatar is the stake. So
	 * the length of a reveal was unbounded until this parameter existed.
	 */
	actionsPerReveal: number;
	/** The ERC20 the reserve would be denominated in. Unused here. */
	tokenAddress: `0x${string}`;
	/**
	 * Where a stake is acquired, and what it costs.
	 *
	 * The price is read off the SALE's own `linkedData` rather than the Game's,
	 * because it is the sale contract's to state: `StakeSale.purchase` reverts
	 * with `WrongPaymentAmount` unless the value it is sent matches exactly, so a
	 * number copied anywhere else is a number that can drift into reverting every
	 * purchase.
	 */
	sale: {
		address: `0x${string}`;
		/** In the chain's native currency, exact. Not a minimum. */
		price: bigint;
		/** How much one purchase yields, which here is one avatar. */
		amount: bigint;
		/**
		 * What the purchase forwards to the local signer, in the same transaction.
		 *
		 * This is what makes onboarding ONE transaction rather than two: the sale
		 * pays the signer before the price is checked, so the call that stakes puts
		 * gas in the key that will spend it. Funding the signer separately means a
		 * second transaction from a wallet the first one just emptied.
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
	 * GAME (how much board is playable at a glance), not about a rendering
	 * library, and because both canvas hosts have to agree on it.
	 */
	camera: {
		/** How much board is visible on the first frame. */
		initialVisible: {width: number; height: number};
		/** Zoom limits, as the smallest and largest slice of board on screen. */
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
 * Gas to allow for ONE TRANSACTION of each kind: a commit, and one reveal step.
 *
 * MEASURED, NOT REASONED ABOUT, and both numbers moved when the reveal became
 * chunked. On a local node, at `actionsPerReveal` of four:
 *
 *   first commit (cold slots)                     116,898
 *   later commit (warm slots)                       82,698
 *   reveal, full chunk, four fresh cells,
 *     each in a different zone, final              535,561
 *   the same chunk, non-final (writes the
 *     new head instead of closing the turn)        534,756
 *
 * The reveal's worst case is four FRESH cells in four DIFFERENT zones, because
 * `_place` appends to a per-zone index only on a cell's first claim, so that is
 * four new dynamic arrays. It is a bound on a TRANSACTION rather than on a turn,
 * which is the whole point of the chunk: a turn is unbounded and arrives in
 * `ceil(actions / actionsPerReveal)` of these.
 *
 * WHAT WAS WRONG BEFORE, since it is the reason these are measured now.
 * `COMMIT_GAS` was 100,000 against a real first commit of 116,898 - 16.9% short,
 * under a comment calling it "deliberately generous". It was harmless only
 * because it merely sizes the stipend; it stops being harmless the moment
 * anything passes it as a LIMIT, and the same comment says what that costs.
 * `REVEAL_GAS` was 2,000,000 against a measured 535,561, which is over-reserving
 * by a factor of four.
 *
 * WHAT THE CHUNK BOUNDS AND WHAT IT DOES NOT, because the next reader of these
 * numbers will be the credits work and this is the distinction it turns on.
 * `REVEAL_GAS` is a true maximum of ONE TRANSACTION and stays one in every game
 * on every chain, however long a turn is - that is the whole property the chunk
 * buys, and it is what makes a gas LIMIT possible at all. What the chunk does
 * not bound is the number of reveal STEPS, and in a game whose turns are
 * unbounded (any game where an action costs nothing, which includes
 * `with/nft-identity` here, and stratagems) there is no worst case for a TURN to
 * be found.
 *
 * So anything that wants to answer the player's actual question - how many TURNS
 * can I still play - cannot be sized from a maximum, and must be sized from an
 * EXPECTATION: how many actions a player is expected to submit per turn, which
 * is the game's to state and should be a named parameter rather than an implicit
 * one. That is why the stipend below is counted in STEPS: it is honest, and it
 * does not answer that question.
 *
 * The tempting alternative is to price a credit PER ACTION, which is exact and
 * gives up the thing credits exist for - "one credit is one user action" stops
 * being true, and a number that varies with what you happen to be doing is a
 * number nobody can plan against. An average with its expectation written down
 * is worth more than an exact figure with no unit.
 *
 * THAT LAST PARAGRAPH IS WHY THIS BRANCH IS THE INTERESTING CASE AND NOT A
 * FOOTNOTE. `main`'s turns are bounded economically at ten placements, so an
 * expectation there is a refinement of a maximum that exists. Here a placement
 * costs nothing, so there IS no maximum, and an expectation is the only thing a
 * stipend or a credit count can be built from at all.
 *
 * THE FIGURES ABOVE ARE `main`'S, AND THIS BRANCH MEASURES LOWER: 99,102 for a
 * first commit and 374,085 for a full fresh chunk, because a placement costs
 * nothing here so a reveal writes no per-cell stake, no cell total and nothing
 * to the reserve. They are kept anyway, and keeping them is the safe direction
 * for a number that sizes a RESERVATION: over-reserving costs a slightly larger
 * first payment, and under-reserving costs a player their gas mid-turn. What
 * could NOT be kept is `creditsGasMultiplier` in `contracts/rocketh/config.ts`,
 * which prices what a step is charged rather than reserving for it, so an
 * inherited figure there would have understated the moves a player has left by
 * more than half; that one is re-measured on this branch.
 *
 * THEY ARE NOT PASSED AS GAS LIMITS, which is a deliberate stop short of what
 * the credits design eventually wants. Passing a limit turns a number that is
 * too low into an out-of-gas mid-submission, and that is not a slow turn, it is
 * a missed reveal, which loses the bond AND blocks the next cycle until it is
 * acknowledged. These are measured against THIS game's contracts; contracts are
 * not inherited in this template tree, so a descendant runs code these numbers
 * were never measured against while inheriting this file unchanged. Sizing a
 * reservation that way is safe and imposing a ceiling that way is not. Passing
 * them as limits is the credits task's to do, with a per-deployment number and a
 * test that fails when a contract change outgrows it.
 */
const COMMIT_GAS = 150_000n;
const REVEAL_GAS = 600_000n;

/**
 * How many SUBMISSION STEPS of gas a new player is given.
 *
 * A step is one commit or one reveal transaction, which is the unit a chunked
 * reveal leaves: a turn longer than `actionsPerReveal` costs one commit plus
 * several reveals, so a player who plans long turns spends this faster than one
 * who plays a cell at a time. That is honest rather than unfortunate - a long
 * turn really does cost more - and it is why this is no longer counted in turns.
 *
 * The whole point of the stipend is that a player who has just staked can play
 * for a while without thinking about gas at all. When it does run out the
 * top-up flow is the remedy (and `resumeWhenGasArrives` picks the submission
 * back up by itself), so this is a starting float rather than a budget.
 */
const STEPS_OF_GAS = 100n;

export function resolvePlacementConfig(
	deployments: TypedDeployments,
): PlacementConfig {
	const linkedData = deployments.contracts.Game.linkedData as GameLinkedData;
	// The AVATAR sale, which is the one difference between this file and
	// `main`'s: what is sold differs, and what the client needs to know about a
	// sale (where, how much, how much gas it forwards) does not.
	const StakeSale = deployments.contracts.GameAvatarSale;
	const saleData = StakeSale.linkedData as DeclaredValues;

	// The chain's own statement of the worst gas price it expects, which is what
	// the credits machinery upstream prices actions with too. A chain that does
	// not declare one gets NO stipend rather than a guessed one: the purchase
	// still works, and the signer is funded by the top-up flow. See
	// `game/core/linked-data.ts` for why an absent parameter answers `undefined`
	// rather than a default.
	const worstGasPrice =
		optionalBigInt(deployments.chain.properties, 'expectedWorstGasPrice') ?? 0n;

	return {
		cycle: resolveCycleConfig(linkedData),
		placementCost: readBigInt(linkedData, 'placementCost'),
		actionsPerReveal: readNumber(linkedData, 'actionsPerReveal'),
		tokenAddress: readAddress(linkedData, 'tokens'),
		sale: {
			address: StakeSale.address,
			price: readBigInt(saleData, 'price'),
			amount: readBigInt(saleData, 'amount'),
			stipend: worstGasPrice * (COMMIT_GAS + REVEAL_GAS) * STEPS_OF_GAS,
		},
		cellSize: 10,
		camera: {
			initialVisible: {width: 24, height: 24},
			limits: {minWidth: 10, minHeight: 10, maxWidth: 100, maxHeight: 100},
		},
	};
}

/** What a set of placements will cost, and so what has to be bonded. */
export function costOfPlacements(
	config: PlacementConfig,
	count: number,
): bigint {
	return config.placementCost * BigInt(count);
}
