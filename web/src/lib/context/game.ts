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
import {resolveWorldConfig, type WorldConfig} from '$lib/world/config';
import {createWorldCommitReveal, type Action} from '$lib/world/commit-reveal';
import {
	createRoundStorage,
	noRoundStorage,
	roundStorageKey,
} from '$lib/world/storage';
import {createPlanning, type PlanningStore} from '$lib/world/planning';
import {SignerOutOfFundsError} from '$lib/world/errors';
import {isRegistered, type DelegationValue} from '$lib/onchain/delegation';
import {
	createDeposited,
	hasAvatarInGame,
	type DepositedState,
	type DepositedStore,
} from '$lib/world/deposited';
import {
	createActiveAvatar,
	type ActiveAvatarStore,
} from '$lib/world/active-avatar';
import {
	blocksCommitting,
	createMissedReveal,
	type MissedRevealStore,
} from '$lib/world/missed-reveal';
import {
	createWorldReader,
	emptyWorld,
	zonesForCamera,
	type WorldState,
} from '$lib/world/state';
import {mergeWorldView, type WorldView} from '$lib/world/view';
import {createGameRenderer, type GameSurface} from '$lib/world/render';
import {bigIntIDToXY, type Position} from 'reveal-or-die-contracts';

export type Game = {
	config: WorldConfig;
	/**
	 * WHO the player is: the authenticated account, not the key that signs.
	 *
	 * Exposed because the distinction is the safety property of the whole design
	 * and is otherwise invisible from outside - every avatar the contract holds
	 * is filed under this address, while a different address pays the gas. See
	 * `gameIdentity` below.
	 *
	 * NOT what the round is keyed by. This game commits per AVATAR, so that is
	 * `activeAvatarID`.
	 */
	identity: Readable<`0x${string}` | undefined>;
	/**
	 * WHICH avatar this client plays, and how to switch.
	 *
	 * The round, the commitment and the storage key are all keyed by it. One per
	 * client is a client convention rather than something the chain enforces:
	 * see `$lib/world/active-avatar`.
	 */
	activeAvatarID: ActiveAvatarStore;
	/** Chain-synced wall clock. NOT `clock`, which is only a UI ticker. */
	chainTime: ChainTimeStore;
	/** Which epoch we are in, and how far through its phases. */
	epochInfo: EpochInfoStore;
	/** Player-facing phases: play / commit / reveal. */
	threePhase: Readable<ThreePhase>;
	/** The same, collapsed to play / wait. */
	twoPhase: Readable<TwoPhase>;
	/** The commit-reveal round: what is planned, committed, revealed. */
	round: RoundStore<bigint, Action>;
	/** Clicks into a planned entry or a planned path. */
	planning: PlanningStore;
	/**
	 * The avatars the contract holds for this account: what the player has at
	 * stake, and what there is to play with.
	 *
	 * This is where the template keeps a token RESERVE. The shapes differ because
	 * the stakes do - an NFT in custody rather than a balance bonded per round -
	 * so there is no amount and no per-round cost here, which is why `reserve`
	 * and `cost` are gone rather than renamed.
	 */
	deposited: DepositedStore;
	/**
	 * An unrevealed commitment from a past epoch, which blocks all further play
	 * until the player acknowledges it.
	 */
	missedReveal: MissedRevealStore;
	/**
	 * Where the active avatar stands on chain, or undefined when it is not in the
	 * world. Read from the account's own deposited avatars rather than off the
	 * board, because the board is camera-scoped and the player can pan away from
	 * their own avatar.
	 */
	currentPosition: Readable<Position | undefined>;
	/**
	 * Whether the player can actually take a turn: they have an identity to play
	 * as, permission for this browser to act as it, and an avatar to move.
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
 *
 * `deposit` is where the template says `stake`. It is the same gate asked about
 * a different thing at stake: there a reserve has to be non-zero, here the
 * contract has to be holding an avatar. `fund-signer` is gone with the token
 * reserve; gas is shown as information and is deliberately not a gate (see
 * `setup` below).
 */
export type SetupNeeded =
	{step: 'sign-in'} | {step: 'authorise'} | {step: 'deposit'};

export type Render = {
	camera: CameraWatcher;
	cameraControl: CameraControl;
	/**
	 * `GameSurface` is the game's own choice of rendering library, named in one
	 * place (`$lib/world/render`). Nothing in the framework mentions pixi, which
	 * is what lets a descendant swap the renderer without touching the context.
	 */
	gameRenderer: GameRenderer<GameSurface>;
	eventEmitter: CanvasEventEmitter;
};

export type GameContext = {
	onchainState: OnchainStateStore<WorldState & {epoch: number}>;
	viewState: ViewStateStore<WorldView>;
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
 * navbar). Watching the SIGNER'S BALANCE rather than the flow keeps the two
 * decoupled: whatever put gas in the account - the flow, a faucet, a transfer
 * by hand - the round resumes.
 *
 * It matters most for a reveal, where the window is short and the commitment is
 * already made: asking the player to notice the failure, top up, and then also
 * remember to press retry is three chances to lose their turn. Worse here than
 * in the template, because a reveal that never lands also BLOCKS the next
 * epoch until `acknowledgeMissedReveal` is called.
 *
 * Its own function, taking only the two stores it reads, because it is the one
 * piece of wiring here that SPENDS the player's gas without being asked. That
 * deserves tests, and tests of it should not require standing up an app
 * context. Exported for the tests and used only just below.
 */
export function resumeWhenGasArrives(params: {
	round: Pick<
		RoundStore<bigint, Action>,
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
	/** The avatars the game contract holds for this account. */
	deposited: DepositedState;
}): SetupNeeded | undefined {
	const {identity, delegation, deposited} = params;
	if (!identity) return {step: 'sign-in'};
	// Only once the read has landed. Treating Unloaded as "not authorised" would
	// flash the gate over a board that is perfectly playable, on every load, for
	// as long as the first read takes.
	if (delegation.step === 'Loaded' && !isRegistered(delegation)) {
		return {step: 'authorise'};
	}
	// Same rule, same reason: `Loading` is not `no avatars`.
	if (deposited.step === 'Loaded' && !hasAvatarInGame(deposited)) {
		return {step: 'deposit'};
	}
	return undefined;
}

export function createGameContext(core: CoreServices): GameContext {
	/**
	 * The address the game plays as: the AUTHENTICATED ACCOUNT.
	 *
	 * Not the signer, though the signer is what SENDS every move. The two are
	 * different questions and conflating them was a real bug: the template used
	 * to play as the signer, which made a key generated by one browser the owner
	 * of everything it won. Clearing site data destroyed the identity and the
	 * stake with it, with nothing to recover from, and any copy of that key held
	 * the money.
	 *
	 * So the account owns, and the signer acts for it, authorised on chain by
	 * `registerDelegate`. Losing the browser now costs a key: the player
	 * authorises another one and their avatars are untouched.
	 *
	 * The authority is ACCOUNT-WIDE, deliberately, and not per avatar:
	 * `_requireAccountForAvatar` resolves the avatar's owner and asks whether the
	 * sender may act for that account. Every signer the account has delegated can
	 * therefore move every avatar it owns, which is why one active avatar per
	 * client is a convention this client keeps rather than a partition the chain
	 * provides. See docs/plans/web-port.md.
	 *
	 * Undefined until the player connects, which the setup gate below turns into
	 * an instruction rather than a broken board.
	 */
	const gameIdentity = core.account;

	// `.get()` rather than `get(store)`: deployments are fixed for the life of
	// the app, and the game's readers need them synchronously at construction.
	const deployments = core.deployments.get();
	const config = resolveWorldConfig(deployments);

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
	const currentEpoch = derived(epochInfo, ($epoch) => $epoch.currentEpoch);

	const {camera, cameraControl} = createCamera(config.camera);
	const eventEmitter = createCanvasEventEmitter();

	const onchainState = createPollingOnchainState<WorldState>({
		publicClient: core.publicClient,
		deployments,
		camera,
		epochInfo,
		chainTime,
		zonesForCamera,
		read: createWorldReader({publicClient: core.publicClient, deployments}),
		emptyState: emptyWorld,
		fetchGate: core.chainFetchGate,
	});

	const deposited = createDeposited({deps: core, owner: gameIdentity});

	const activeAvatarID = createActiveAvatar({
		deposited,
		owner: gameIdentity,
		chainID: deployments.chain.id,
		gameAddress: deployments.contracts.Game.address,
	});

	/**
	 * Where the active avatar stands, from the ACCOUNT'S OWN read.
	 *
	 * Not from `onchainState`, which is scoped to what the camera can see: a
	 * player who pans away from their avatar would have it read as "not in the
	 * world", and the next click would be planned as an entry rather than a step.
	 * `avatarsPerOwner` answers about the account wherever the camera happens to
	 * be pointing.
	 */
	const currentPosition = derived(
		[deposited, activeAvatarID],
		([$deposited, $avatarID]): Position | undefined => {
			if ($deposited.step !== 'Loaded' || $avatarID === undefined) {
				return undefined;
			}
			const avatar = $deposited.avatars.find((a) => a.avatarID === $avatarID);
			if (!avatar || !avatar.inGame) return undefined;
			return bigIntIDToXY(avatar.position);
		},
	);

	/**
	 * Storage that follows the avatar being played.
	 *
	 * Resolved per call rather than captured once: the account and the active
	 * avatar can both change while the app is running, and a pending round
	 * belonging to a different avatar would fail to reveal and read as a contract
	 * bug. See `roundStorageKey` for why the avatar is part of the key at all.
	 */
	const storage: RoundStorage<Action> = {
		load: () => forCurrentAvatar().load(),
		save: (round) => forCurrentAvatar().save(round),
		clear: () => forCurrentAvatar().clear(),
	};

	function forCurrentAvatar(): RoundStorage<Action> {
		const avatarID = get(activeAvatarID);
		if (avatarID === undefined) return noRoundStorage;
		return createRoundStorage({
			key: roundStorageKey({
				chainID: deployments.chain.id,
				gameAddress: deployments.contracts.Game.address,
				avatarID,
			}),
		});
	}

	const missedReveal = createMissedReveal({
		deps: core,
		avatarID: activeAvatarID,
		currentEpoch,
		// Acknowledging changes what the contract holds for this avatar, so the
		// deposited read is no longer current.
		onSettled: () => void deposited.update(),
	});

	const round = createRound<bigint, Action>({
		epochInfo,
		adapter: createWorldCommitReveal({
			deps: core,
			// Refuse to commit while an unrevealed commitment is in the way, and say
			// so in words the player can act on. `_makeCommitment` rejects one left
			// over from an earlier epoch with `PreviousCommitmentNotRevealed`, so
			// without this the only symptom is every commit failing with a bare
			// revert. Acknowledging is never done on their behalf: see
			// `$lib/world/missed-reveal`.
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
		// The AVATAR, not the account: `commit` and `reveal` both take an avatar id
		// and resolve the sender against its owner. `PlayerIdentity` is
		// `bigint | 0x${string}` for exactly this, so nothing has to widen.
		identity: activeAvatarID,
		onSettled: async () => {
			// A settled round moves the avatar, which changes both the board and the
			// account's own read of where it stands. Awaited by the round before it
			// reports itself revealed, so the confirmed position is in place by the
			// time the planned path stops being drawn: no flicker of the moves
			// disappearing and coming back.
			await Promise.all([onchainState.update(), deposited.update()]);
		},
	});

	const planning = createPlanning({
		round,
		config,
		currentPosition,
		activeAvatarID,
		player: gameIdentity,
	});

	const viewState = createViewState({
		onchainState,
		localState: planning.plan,
		merge: mergeWorldView,
	});

	const gameRenderer = createGameRenderer({
		viewState,
		cellSize: config.cellSize,
	});

	/**
	 * What stands between the player and their first move.
	 *
	 * Three things: an identity, permission for this browser to act as it, and an
	 * avatar the contract is holding. It does NOT gate on the signer having gas.
	 * Doing that produced a dead end - "your play key needs gas" with no way to
	 * act on it, while the one button that could have helped was hidden behind
	 * the very gate that was complaining. Gas is shown in the HUD as information;
	 * it is not a gate.
	 *
	 * Authorisation IS a gate, and for the opposite reason: it is not a
	 * degradation but a hard stop. `commit` resolves the caller against the
	 * account's registered delegates and reverts with `NotDelegate` if they do
	 * not match, so without it a player can plan a whole turn, watch the commit
	 * fail, and have no idea why. Same principle as the deposit gate: never
	 * invite a move that cannot be made.
	 *
	 * Ordered before the deposit because it is the cheaper mistake to make first.
	 * Depositing puts an avatar into the contract's custody; authorising is one
	 * transaction that also funds the signer's gas. A player who stops halfway
	 * through setup should be left having spent as little as possible.
	 */
	const setup = derived(
		[gameIdentity, core.delegation, deposited],
		([$identity, $delegation, $deposited]) =>
			setupNeeded({
				identity: $identity,
				delegation: $delegation,
				deposited: $deposited,
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
			// which is what the avatar objects and the grid are both drawn with.
			const cell = {x: Math.round(position.x), y: Math.round(position.y)};

			// Out of the world: a click chooses where to appear, and it is the WHOLE
			// turn. `_enter` sets `stopProcessing`, so anything planned after an
			// Enter would be silently dropped by the reveal; `enterAt` replaces the
			// plan rather than appending, which also lets the player re-pick a spawn
			// by clicking somewhere else.
			if (get(currentPosition) === undefined) {
				planning.enterAt(cell);
				return;
			}
			// In the world: a click is the next step of a path. `stepTo` refuses
			// anything that is not a legal single step, because a move the contract
			// rejects sets `stopProcessing` and silently discards the REST of the
			// turn as well.
			planning.stepTo(cell);
		};
		eventEmitter.on('clicked', onClicked);

		void deposited.update();
		void missedReveal.check();
		const unsubscribeAccount = gameIdentity.subscribe(() => {
			void deposited.update();
			// Whether a commitment is outstanding is a fact about the AVATAR, not
			// about this browser: it has to be re-read when the account changes, and
			// it is how a player who lost their local state still finds out.
			void missedReveal.check();
		});

		// Same question, asked again for a different avatar. Switching avatars in
		// one browser is exactly the case where the local round says nothing and
		// the chain may still be holding an unrevealed commitment.
		const unsubscribeAvatar = activeAvatarID.subscribe(() => {
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
		// is live in the epoch it was made and blocking in the next one. Checking
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
			unsubscribeAvatar();
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
			activeAvatarID,
			chainTime,
			epochInfo,
			threePhase,
			twoPhase,
			round,
			planning,
			deposited,
			missedReveal,
			currentPosition,
			readyToPlay,
			setup,
		},
		render: {camera, cameraControl, gameRenderer, eventEmitter},
		start,
	};
}
