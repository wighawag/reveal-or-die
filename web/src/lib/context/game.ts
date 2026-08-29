/**
 * The game half of the app context.
 *
 * `createContext` used to build everything in one function. It is split so the
 * two halves can move independently: `core.ts` is jolly-roger's, merged down
 * from upstream and best left alone, while this file is the commit-reveal
 * framework wired to one particular game. A descendant keeps the shape and
 * swaps the game imports below the line; a merge from upstream touches the
 * other file.
 *
 * Constructed synchronously and off-browser, like the core half: nothing here
 * starts IO, which belongs to `start()`. See ADR-0002.
 */
import {derived, get, type Readable} from 'svelte/store';
import type {CoreServices} from './core';
import type {SignerGrant} from '$lib/ui/delegation/grant';
import {createChainTime, type ChainTimeStore} from '$lib/game/core/chain-time';
import {
	createThreePhase,
	createTimedEpochTrackers,
	staticEpochConfig,
	type EpochInfoStore,
	type ThreePhase,
	type TwoPhase,
} from '$lib/game/core/epoch';
import {
	createRound,
	type RoundStorage,
	type RoundStore,
} from '$lib/game/core/round';
import {
	createCamera,
	type CameraControl,
	type CameraWatcher,
} from '$lib/game/render/camera';
import {
	createCanvasEventEmitter,
	type CanvasEventEmitter,
} from '$lib/game/render/events';
import type {GameRenderer} from '$lib/game/core/seams';
import {
	createPollingOnchainState,
	type OnchainStateStore,
} from '$lib/onchain/state';
import {createViewState, type ViewStateStore} from '$lib/view';

// ---------------------------------------------------------------------------
// The game itself. Everything below is what a descendant replaces; everything
// above is the framework it plugs into.
// ---------------------------------------------------------------------------
import {
	resolvePlacementConfig,
	type PlacementConfig,
} from '$lib/placement/config';
import {
	createPlacementCommitReveal,
	type Placement,
} from '$lib/placement/commit-reveal';
import {
	createRoundStorage,
	noRoundStorage,
	roundStorageKey,
} from '$lib/placement/storage';
import {createPlanning, type PlanningStore} from '$lib/placement/planning';
import {SignerOutOfFundsError} from '$lib/placement/errors';
import {isRegistered, type DelegationValue} from '$lib/onchain/delegation';
import {createReserve, type ReserveStore} from '$lib/placement/reserve';
import {
	blocksCommitting,
	createMissedReveal,
	type MissedRevealStore,
} from '$lib/placement/missed-reveal';
import {
	createBoardReader,
	emptyBoard,
	zonesForCamera,
	type BoardState,
} from '$lib/placement/state';
import {mergeBoardView, type BoardView} from '$lib/placement/view';
import {createGameRenderer, type GameSurface} from '$lib/placement/render';
import {cellID} from '$lib/placement/cells';

export type Game = {
	config: PlacementConfig;
	/**
	 * WHO the player is: the authenticated account, not the key that signs.
	 *
	 * Exposed because the distinction is the safety property of the whole design
	 * and is otherwise invisible from outside - the reserve, the commitment and
	 * every cell won are filed under this address, while a different address pays
	 * the gas. See `gameIdentity` below.
	 */
	identity: Readable<`0x${string}` | undefined>;
	/** Chain-synced wall clock. NOT `clock`, which is only a UI ticker. */
	chainTime: ChainTimeStore;
	/** Which epoch we are in, and how far through its phases. */
	epochInfo: EpochInfoStore;
	/** Player-facing phases: play / commit / reveal. */
	threePhase: Readable<ThreePhase>;
	/** The same, collapsed to play / wait. */
	twoPhase: Readable<TwoPhase>;
	/** The commit-reveal round: what is planned, committed, revealed. */
	round: RoundStore<`0x${string}`, Placement>;
	/** Clicks into planned placements. */
	planning: PlanningStore;
	/** The tokens at stake, without which nobody would have to reveal. */
	reserve: ReserveStore;
	/**
	 * An unrevealed commitment from a past epoch, which blocks all further play
	 * until the player acknowledges the forfeit.
	 */
	missedReveal: MissedRevealStore;
	/** What the planned round will cost the player. */
	cost: Readable<bigint>;
	/**
	 * Whether the player can actually take a turn: they have an identity to play
	 * as, and a reserve to bond from.
	 *
	 * Clicks do nothing while this is false. Letting someone plan a whole turn
	 * they cannot commit is worse than not letting them start: the moves look
	 * accepted, and the failure only arrives at the commit, by which point the
	 * round is over.
	 */
	readyToPlay: Readable<boolean>;
	/** What is still missing before a turn can be taken, if anything. */
	setup: Readable<SetupNeeded | undefined>;
};

/**
 * What stands between the player and their first move.
 *
 * Ordered by what has to happen first, so the UI only ever asks for one thing.
 */
export type SetupNeeded =
	| {step: 'sign-in'}
	| {step: 'authorise'}
	| {step: 'fund-signer'}
	| {step: 'stake'};

export type Render = {
	camera: CameraWatcher;
	cameraControl: CameraControl;
	/**
	 * `GameSurface` is the game's own choice of rendering library, named in one
	 * place (`$lib/placement/render`). Nothing in the framework mentions pixi,
	 * which is what lets a descendant swap the renderer without touching the
	 * context.
	 */
	gameRenderer: GameRenderer<GameSurface>;
	eventEmitter: CanvasEventEmitter;
};

export type GameContext = {
	onchainState: OnchainStateStore<BoardState & {epoch: number}>;
	viewState: ViewStateStore<BoardView>;
	game: Game;
	render: Render;
	/** Begin the game's own IO. Returns the teardown. */
	start(): () => void;
};

/**
 * Carry on once the gas arrives.
 *
 * A move that failed for want of gas is the one failure the player can fix, and
 * the fix happens elsewhere (the top-up flow, reachable from the HUD and the
 * top bar). Watching the SIGNER'S BALANCE rather than the flow keeps the two
 * decoupled: whatever put gas in the account - the flow, a faucet, a transfer
 * by hand - the round resumes.
 *
 * It matters most for a reveal, where the window is short and the stake is
 * already committed: asking the player to notice the failure, top up, and then
 * also remember to press retry is three chances to lose their bond.
 *
 * Its own function, taking only the two stores it reads, because it is the one
 * piece of wiring here that SPENDS the player's gas without being asked. That
 * deserves tests, and tests of it should not require standing up an app
 * context. Exported for the tests and used only just below.
 */
export function resumeWhenGasArrives(params: {
	round: Pick<
		RoundStore<`0x${string}`, Placement>,
		'subscribe' | 'value' | 'commit' | 'reveal'
	>;
	signerBalance: Readable<{step: string; value?: bigint}>;
}): () => void {
	const {round, signerBalance} = params;
	let gasSeen: bigint | undefined;

	return signerBalance.subscribe(($balance) => {
		if ($balance.step !== 'Loaded' || $balance.value === undefined) return;
		const previous = gasSeen;
		gasSeen = $balance.value;
		// Only a RISE, and never the first reading. The first reading is just this
		// browser learning what the balance already was, which fixes nothing, and a
		// balance that fell is the failed move's own gas being spent elsewhere.
		if (previous === undefined || $balance.value <= previous) return;

		const $round = round.value;
		// The type the game constructed at its own boundary, not a fresh look at
		// the node's wording. This decides whether to SPEND the player's gas
		// unprompted, so it must resume only for the failure the arriving money
		// actually fixes: any other error is still an error once the balance rises,
		// and retrying it just burns the top-up.
		if (
			$round.step !== 'Error' ||
			!($round.error instanceof SignerOutOfFundsError)
		) {
			return;
		}
		// Which one is not a detail: revealing when a commit failed would send a
		// reveal for a commitment that was never made.
		if ($round.during === 'reveal') void round.reveal();
		else void round.commit();
	});
}

/**
 * What stands between the player and their first move.
 *
 * Its own pure function because it is a GATE, and the two ways to get a gate
 * wrong are opposites: too strict and it hides a playable board behind a demand
 * the player has already met, too loose and it invites a turn that reverts.
 * Neither is visible by reading it, so both are tested.
 */
export function setupNeeded(params: {
	identity: `0x${string}` | undefined;
	/**
	 * The delegation read, which is already SCOPED to this browser's signer.
	 *
	 * No signer is passed alongside it, and none is missing: the read asks the
	 * chain about the (account, signer) pair, so `allowed` is the answer about
	 * this browser rather than about whichever delegate happened to be listed
	 * first. It used to be an address comparison here, which only worked while an
	 * account could have exactly one delegate.
	 */
	delegation: DelegationValue;
	reserve: {step: string; amount?: bigint};
}): SetupNeeded | undefined {
	const {identity, delegation, reserve} = params;
	if (!identity) return {step: 'sign-in'};
	// Only once the read has landed. Treating Unloaded as "not authorised" would
	// flash the gate over a board that is perfectly playable, on every load, for
	// as long as the first read takes.
	if (delegation.step === 'Loaded' && !isRegistered(delegation)) {
		return {step: 'authorise'};
	}
	if (reserve.step === 'Loaded' && reserve.amount === 0n) {
		return {step: 'stake'};
	}
	return undefined;
}

/**
 * WHAT THIS APP'S BROWSER KEY IS FOR, in this app's own words.
 *
 * Inherited plumbing, app-specific answer. The template owns the sentences it
 * lands in (see `ui/delegation/grant.ts`); this is the verb phrase inside them,
 * and it is shown in the two places where being wrong is most expensive: the
 * dialog asking the user to authorise a key, and the account panel row saying
 * what that key can do.
 *
 * Upstream this said "post greetings", because upstream's demo posts greetings
 * and the sentence was hard-coded in shared code. A game inheriting that told
 * its players the key was for posting greetings. If you fork THIS template,
 * change this line.
 */
export const SIGNER_GRANT: SignerGrant = {action: 'play your moves'};

export function createGameContext(core: CoreServices): GameContext {
	/**
	 * The address the game plays as: the AUTHENTICATED ACCOUNT.
	 *
	 * Not the signer, though the signer is what SENDS every move. The two are
	 * different questions and conflating them was a real bug: the template used
	 * to play as the signer, which made a key generated by one browser the owner
	 * of the reserve and of every cell it claimed. Clearing site data destroyed
	 * the identity and the stake with it, with nothing to recover from, and any
	 * copy of that key held the money.
	 *
	 * So the account owns, and the signer acts for it, authorised on chain by
	 * `registerDelegate`. Losing the browser now costs a key: the player
	 * authorises another one and their reserve and board are untouched.
	 *
	 * Undefined until the player connects, which the setup gate below turns into
	 * an instruction rather than a broken board.
	 *
	 * Derived here rather than read off the context because WHICH address a game
	 * plays as is the game's own decision; the core just offers both.
	 */
	const gameIdentity = core.account;

	// `.get()` rather than `get(store)`: deployments are fixed for the life of
	// the app, and the game's readers need them synchronously at construction.
	const deployments = core.deployments.get();
	const config = resolvePlacementConfig(deployments);

	// Chain-synced, unlike the UI clock: the phases are defined against block
	// timestamps, and a browser clock that drifts would show the wrong phase and
	// let the player plan into a window that has already closed.
	const chainTime = createChainTime({
		publicClient: core.publicClient,
		minPollingInterval: 100,
	});
	const {epochInfo, twoPhase} = createTimedEpochTrackers({
		chainTime,
		config: staticEpochConfig(config.epoch),
	});
	const threePhase = createThreePhase(epochInfo);

	const {camera, cameraControl} = createCamera(config.camera);
	const eventEmitter = createCanvasEventEmitter();

	const onchainState = createPollingOnchainState<BoardState>({
		publicClient: core.publicClient,
		deployments,
		camera,
		epochInfo,
		chainTime,
		zonesForCamera,
		read: createBoardReader({publicClient: core.publicClient, deployments}),
		emptyState: emptyBoard,
		fetchGate: core.chainFetchGate,
	});

	const reserve = createReserve({deps: core, config, gameIdentity});

	/**
	 * Storage that follows the connected player.
	 *
	 * Resolved per call rather than captured once: the account can change while
	 * the app is running, and a pending round belonging to a different address
	 * would fail to reveal and read as a contract bug.
	 */
	const storage: RoundStorage<Placement> = {
		load: () => forCurrentPlayer().load(),
		save: (round) => forCurrentPlayer().save(round),
		clear: () => forCurrentPlayer().clear(),
	};

	function forCurrentPlayer(): RoundStorage<Placement> {
		// Keyed by the address that PLAYS (the signer), which is what the
		// contract's commitment is keyed by.
		const player = get(gameIdentity);
		if (!player) return noRoundStorage;
		return createRoundStorage({
			key: roundStorageKey({
				chainID: deployments.chain.id,
				gameAddress: deployments.contracts.Game.address,
				player,
			}),
		});
	}

	const missedReveal = createMissedReveal({
		deps: core,
		config,
		gameIdentity,
		// The forfeit comes out of the reserve, so the number on screen changes.
		onSettled: () => void reserve.update(),
	});

	const round = createRound<`0x${string}`, Placement>({
		epochInfo,
		adapter: createPlacementCommitReveal({
			deps: core,
			config,
			// Refuse to commit while an unrevealed commitment is in the way, and say
			// so in words the player can act on. Acknowledging it forfeits their
			// bond, so it is never done on their behalf: see
			// `$lib/placement/missed-reveal`.
			beforeCommit: async () => {
				await missedReveal.check();
				if (blocksCommitting(missedReveal.value)) {
					throw new Error(
						'An earlier commitment was never revealed. Acknowledge the missed reveal to play again.',
					);
				}
			},
		}),
		storage,
		// The game plays as the local signer, not as the wallet: see the game
		// executor in `context/core.ts`.
		identity: gameIdentity,
		onSettled: async () => {
			// A settled round changes both the board and the reserve. Awaited by the
			// round before it reports itself revealed, so the confirmed placements
			// are on the board by the time the planned ones stop being drawn: no
			// flicker of the moves disappearing and coming back.
			await Promise.all([onchainState.update(), reserve.update()]);
		},
	});

	const planning = createPlanning({round});

	const viewState = createViewState({
		onchainState,
		localState: planning.plan,
		merge: mergeBoardView,
	});

	const gameRenderer = createGameRenderer({
		viewState,
		cellSize: config.cellSize,
	});

	const cost = derived(
		planning.count,
		($count) => BigInt($count) * config.placementCost,
	);

	/**
	 * What stands between the player and their first move.
	 *
	 * Three things: an identity, permission for this browser to act as it, and a
	 * stake. It does NOT gate on the signer having gas. Doing that produced a
	 * dead end - "your play key needs gas" with no way to act on it, while the one
	 * button that could have helped (staking, which goes through the wallet and
	 * offers the faucet on its own when funds are short) was hidden behind the
	 * very gate that was complaining. Gas is shown in the HUD as information; it
	 * is not a gate.
	 *
	 * Authorisation IS a gate, and for the opposite reason: it is not a
	 * degradation but a hard stop. `makeCommitment` resolves the caller against
	 * the account's registered delegate and reverts with `NotDelegate` if they do
	 * not match, so without it a player can plan a whole turn, watch the commit
	 * fail, and have no idea why. Same principle as the stake gate: never invite
	 * a move that cannot be made.
	 *
	 * Ordered before the stake because it is the cheaper mistake to make first.
	 * Staking moves real tokens into a reserve that only this account can
	 * withdraw; authorising is one transaction that also funds the signer's gas.
	 * A player who stops halfway through setup should be left having spent as
	 * little as possible.
	 */
	const setup = derived(
		[gameIdentity, core.delegation, reserve],
		([$identity, $delegation, $reserve]) =>
			setupNeeded({
				identity: $identity,
				delegation: $delegation,
				reserve: $reserve,
			}),
	);

	const readyToPlay = derived(setup, ($setup) => $setup === undefined);

	function start() {
		const stopRound = round.start();

		// A click is only a click to the canvas; what it MEANS is decided here, so
		// the render layer stays free of game rules.
		const onClicked = (position: {x: number; y: number}) => {
			// Ignore clicks until the player could actually commit them.
			if (!get(readyToPlay)) return;
			// The canvas reports WHERE, in game units and unsnapped; which cell that
			// is, is this game's rule. Rounded rather than floored because cells are
			// centred on their integer coordinate (the cell at 3,4 spans 2.5..3.5),
			// which is what `CellObject` and the grid are both drawn with.
			planning.toggle(cellID(Math.round(position.x), Math.round(position.y)));
		};
		eventEmitter.on('clicked', onClicked);

		void reserve.update();
		void missedReveal.check();
		const unsubscribeAccount = gameIdentity.subscribe(() => {
			void reserve.update();
			// Whether a commitment is outstanding is a fact about the ACCOUNT, not
			// about this browser: it has to be re-read when the account changes, and
			// it is how a player who lost their local state still finds out.
			void missedReveal.check();
		});

		// A round that ends in Missed locally is very likely blocked on chain too.
		const unsubscribeRound = round.subscribe(($round) => {
			if ($round.step === 'Missed') void missedReveal.check();
		});

		const unsubscribeGas = resumeWhenGasArrives({
			round,
			signerBalance: core.signerBalance,
		});

		// Re-check when the epoch turns over.
		//
		// Whether a commitment counts as MISSED is a question about the current
		// epoch, not a fixed property of the commitment: the very same commitment
		// is live in the epoch it was made and forfeit in the next one. Checking
		// only on load and on account change means a tab that was open across the
		// boundary answers "nothing is wrong" once and never revisits it, leaving
		// the player silently blocked with no idea why committing does nothing.
		let lastEpoch: number | undefined;
		const unsubscribeEpoch = epochInfo.subscribe(($epoch) => {
			if (lastEpoch !== undefined && $epoch.currentEpoch !== lastEpoch) {
				void missedReveal.check();
			}
			lastEpoch = $epoch.currentEpoch;
		});

		return () => {
			stopRound();
			eventEmitter.off('clicked', onClicked);
			unsubscribeAccount();
			unsubscribeRound();
			unsubscribeEpoch();
			unsubscribeGas();
		};
	}

	return {
		onchainState,
		viewState,
		game: {
			config,
			identity: gameIdentity,
			chainTime,
			epochInfo,
			threePhase,
			twoPhase,
			round,
			planning,
			reserve,
			missedReveal,
			cost,
			readyToPlay,
			setup,
		},
		render: {camera, cameraControl, gameRenderer, eventEmitter},
		start,
	};
}
