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
} from '$lib/game/render/pixi/events';
import type {GameRenderer} from '$lib/game/core/seams';
import {
	createPollingOnchainState,
	type OnchainStateStore,
} from '$lib/onchain/state';
import {createViewState, type ViewStateStore} from '$lib/view';
import type {Container} from 'pixi.js';

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
import {createBoardRenderer} from '$lib/placement/render/board-renderer';
import {cellID} from '$lib/placement/cells';

export type Game = {
	config: PlacementConfig;
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
	{step: 'sign-in'} | {step: 'fund-signer'} | {step: 'stake'};

export type Render = {
	camera: CameraWatcher;
	cameraControl: CameraControl;
	gameRenderer: GameRenderer<Container>;
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

export function createGameContext(core: CoreServices): GameContext {
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

	const {camera, cameraControl} = createCamera();
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

	const reserve = createReserve({deps: core, config});

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
		const player = get(core.gameIdentity);
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
		identity: core.gameIdentity,
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

	const gameRenderer = createBoardRenderer({
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
	 * Deliberately only two things: an identity, and a stake. It does NOT gate on
	 * the signer having gas. Doing that produced a dead end - "your play key needs
	 * gas" with no way to act on it, while the one button that could have helped
	 * (staking, which goes through the wallet and offers the faucet on its own
	 * when funds are short) was hidden behind the very gate that was complaining.
	 * Gas is shown in the HUD as information; it is not a gate.
	 */
	const setup = derived(
		[core.gameIdentity, reserve],
		([$identity, $reserve]): SetupNeeded | undefined => {
			if (!$identity) return {step: 'sign-in'};
			if ($reserve.step === 'Loaded' && $reserve.amount === 0n) {
				return {step: 'stake'};
			}
			return undefined;
		},
	);

	const readyToPlay = derived(setup, ($setup) => $setup === undefined);

	function start() {
		const stopRound = round.start();

		// A click is only a click to the canvas; what it MEANS is decided here, so
		// the render layer stays free of game rules.
		const onClicked = (position: {x: number; y: number}) => {
			// Ignore clicks until the player could actually commit them.
			if (!get(readyToPlay)) return;
			planning.toggle(cellID(position.x, position.y));
		};
		eventEmitter.on('clicked', onClicked);

		void reserve.update();
		void missedReveal.check();
		const unsubscribeAccount = core.gameIdentity.subscribe(() => {
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
		};
	}

	return {
		onchainState,
		viewState,
		game: {
			config,
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
