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
import {createDerivedSecret} from '$lib/game/core/secret';
import {
	createActiveIdentity,
	type ActiveIdentityStore,
	type GameIdentity,
} from '$lib/game/identity';
import {holdBoardUntilRoundEnds} from '$lib/game/core/handover';
import {createRoundRecovery, type RecoveryStore} from '$lib/game/core/recovery';
import {
	boardIsBehindClock,
	roundPhaseOf,
	type RoundPhase,
} from '$lib/game/core/round-phase';
import {
	createAcquisition,
	refreshWhenPendingAcquisitionSettles,
	type AcquisitionStore,
} from '$lib/game/acquire';
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
	buildPlacementCommitment,
	createPlacementCommitReveal,
	type Placement,
} from '$lib/placement/commit-reveal';
import {
	createRoundStorage,
	noRoundStorage,
	roundStorageKey,
} from '$lib/placement/storage';
import {createPlanning, type PlanningStore} from '$lib/placement/planning';
import {holdResolvingRound, type HeldBoardState} from '$lib/placement/hold';
import {holdPlanUntilBoardReleases} from '$lib/placement/display-plan';
import {SignerOutOfFundsError} from '$lib/placement/errors';
import {isRegistered, type DelegationValue} from '$lib/onchain/delegation';
import {createReserve, type ReserveStore} from '$lib/placement/reserve';
import {createStakeAcquisition} from '$lib/placement/acquisition';
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
	 * WHO IS SIGNED IN: the authenticated account, not the key that signs.
	 *
	 * THE ACCOUNT, and it stays the account in every game built on this
	 * template. It is an address here, on `with/nft-identity`, and in
	 * reveal-or-die, which made the same call independently.
	 *
	 * Exposed because the account/signer distinction is the safety property of
	 * the whole design and is otherwise invisible from outside: the account
	 * owns, and a different key pays the gas and sends the moves.
	 *
	 * NOT what the round is keyed by. That is `activeIdentity`, and the two hold
	 * the SAME VALUE here because the template is an address game - which is
	 * precisely why they have to be two members rather than one. A consumer
	 * asking "who am I signed in as" wants this one; a consumer asking "whose
	 * commitment is this" wants the other, and on a game whose identity is a
	 * token they are different values of different types.
	 */
	identity: Readable<`0x${string}` | undefined>;
	/**
	 * WHO IS PLAYING: what the round, the commitment, the stake and the round's
	 * storage key are all keyed by. See `$lib/game/identity`.
	 *
	 * Equal to `identity` here and NOT the same question. Where a game's
	 * identity is a token, the account still exists and still owns the token;
	 * this is the token.
	 */
	activeIdentity: ActiveIdentityStore;
	/** Chain-synced wall clock. NOT `clock`, which is only a UI ticker. */
	chainTime: ChainTimeStore;
	/** Which epoch we are in, and how far through its phases. */
	epochInfo: EpochInfoStore;
	/** Player-facing phases: play / commit / reveal. */
	threePhase: Readable<ThreePhase>;
	/**
	 * The four-part model the HUD draws and the move gate reads.
	 *
	 * `threePhase` plus the one state a clock cannot see: the board is still
	 * showing a round that is already over. See `game/core/round-phase.ts`.
	 */
	phase: Readable<RoundPhase>;
	/** The same, collapsed to play / wait. */
	twoPhase: Readable<TwoPhase>;
	/** The commit-reveal round: what is planned, committed, revealed. */
	round: RoundStore<GameIdentity, Placement>;
	/** Clicks into planned placements. */
	planning: PlanningStore;
	/** The tokens at stake, without which nobody would have to reveal. */
	reserve: ReserveStore;
	/**
	 * Getting a stake in the first place: one transaction, which also funds the
	 * key this browser plays with. See `$lib/game/acquire`.
	 */
	acquisition: AcquisitionStore;
	/**
	 * An unrevealed commitment from a past epoch, which blocks all further play
	 * until the player acknowledges the forfeit.
	 */
	missedReveal: MissedRevealStore;
	/**
	 * A commitment the chain holds for the round in progress that this browser
	 * has no memory of - a cleared browser, a second device, a private window.
	 * The stake is still recoverable while the epoch lasts. See
	 * `$lib/game/core/recovery`.
	 */
	recovery: RecoveryStore<Placement>;
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
		RoundStore<GameIdentity, Placement>,
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

	// THE STAKE COMES FIRST, and the order was the other way round until getting
	// one started carrying the authorisation with it.
	//
	// It used to ask to authorise first, on the grounds that both were wallet
	// transactions and a player who abandons setup half way should have spent as
	// little as possible. That reasoning survives; what changed is which order
	// serves it. Acquiring is now ONE transaction that stakes and funds the
	// signer in the same call, and the signer registers itself out of that
	// stipend, so staking IS authorising. Asking for the authorisation first now
	// demands a transaction that the very next step includes.
	//
	// `Unloaded` is not `no stake`: treating an unfinished read as an empty one
	// would put the gate over a playable board on every load until it lands.
	if (reserve.step === 'Loaded' && reserve.amount === 0n) {
		return {step: 'stake'};
	}

	// Still reachable, and still needed: a player who ALREADY has a stake on this
	// account but is opening a second browser, or who revoked this one. They have
	// nothing left to buy, so there is no purchase to fold the authorisation
	// into, and the top-up flow (register and fund in one) is the remedy.
	if (delegation.step === 'Loaded' && !isRegistered(delegation)) {
		return {step: 'authorise'};
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
	 * WHO IS SIGNED IN.
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
	 */
	const account = core.account;

	/**
	 * WHO IS PLAYING, which is a different question from who is signed in.
	 *
	 * The same value as `account` here and deliberately not the same NAME: the
	 * round, the secret's domain separation, the stake and the storage key are
	 * keyed by THIS, and a game whose identity is a token keys them by the
	 * token while the account goes on owning it. Every site below picks one of
	 * the two on purpose; see `$lib/game/identity` for the rule.
	 *
	 * Built through a provider rather than assigned, because D6 requires
	 * identity to be a SELECTION even where there is exactly one of them.
	 */
	// THE ONE SHARED LINE THIS BRANCH CHANGES. An avatar game has to LOOK UP who
	// is playing (custody, on chain) where an address game already knows, so the
	// provider is handed the two things a read needs. Everything downstream takes
	// the same store type and is unchanged.
	const activeIdentity = createActiveIdentity({account, deps: core});

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

	/**
	 * Is the board still showing the round that just ended?
	 *
	 * Derived from the two stores rather than tracked, so it cannot go stale: it
	 * is a comparison, not a state machine. The rule and the trap it avoids are
	 * in `game/core/round-phase.ts`.
	 */
	const boardBehindClock = derived(
		[epochInfo, onchainState],
		([$epoch, $state]) =>
			boardIsBehindClock({
				board: $state as {step: string; epoch?: number},
				currentEpoch: $epoch.currentEpoch,
			}),
	);

	const phase = derived([threePhase, boardBehindClock], ([$three, $behind]) =>
		roundPhaseOf($three, $behind),
	);

	// The stake is filed under WHO PLAYS, not under who signed in: a game whose
	// identity is a token bonds against the token.
	const reserve = createReserve({deps: core, config, identity: activeIdentity});

	const acquisition = createAcquisition({
		deps: core,
		acquisition: createStakeAcquisition({config, deployments}),
		// THE ACCOUNT, not the identity: a purchase is credited to whoever owns
		// the result, and that stays an account even when what it buys is a token.
		owner: account,
		// The same grant the top-up flow shows, from the one place this app
		// declares it, so the two cannot describe two different keys.
		grant: SIGNER_GRANT,
		// The reserve exists the moment the transaction lands, so re-reading is
		// what takes the player past the setup gate and onto the board.
		onAcquired: () => void reserve.update(),
	});

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
		// Keyed by WHO PLAYS, which is what the contract's commitment is keyed by.
		// (This comment used to say "the signer", which the code has not done since
		// the account became the player.)
		const player = get(activeIdentity);
		// `=== undefined`, not falsy: an identity that is a token id can be `0n`.
		if (player === undefined) return noRoundStorage;
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
		identity: activeIdentity,
		// The forfeit comes out of the reserve, so the number on screen changes.
		onSettled: () => void reserve.update(),
	});

	/**
	 * Sign with the LOCAL SIGNER, silently, for the commit secret.
	 *
	 * Taken off the signer executor rather than from a private key the game asks
	 * for: in signer mode its `account` is a viem local account, so it already
	 * signs without a prompt and without this file ever touching a key. It also
	 * means the composition root needs no new member, which matters because that
	 * is the most conflicted file in the tree.
	 *
	 * The SIGNER and not the account, deliberately, and the reason is the whole
	 * feature: sign-in derives the signer from a signature over an origin-scoped
	 * message the wallet produces locally, so the same account derives the same
	 * signer on any device and the secret comes back with it. Signing with the
	 * account would be equally recoverable and would put a wallet prompt on every
	 * commit, which is what the signer exists to remove.
	 *
	 * It THROWS when there is no signer rather than falling back to a random
	 * secret. A silent fallback would produce a round that looks identical and is
	 * not recoverable, which is the failure this is here to prevent, and the
	 * setup gate already refuses to let anyone commit before signing in.
	 */
	async function signAsSigner(message: string): Promise<`0x${string}`> {
		const executor = get(core.signerExecutor);
		// `signerAccount` and not `account`: this is the SIGNER's viem account, a
		// third thing again, and the outer `account` in this file is the player's.
		// One word for both would be the exact confusion this file now exists to
		// keep apart, and shadowing it would hide that behind a scope.
		const signerAccount =
			executor.status === 'ready' ? executor.account : undefined;
		if (
			!signerAccount ||
			typeof signerAccount === 'string' ||
			!signerAccount.signMessage
		) {
			throw new Error(
				'Cannot derive the commit secret: no local signer is available.',
			);
		}
		return signerAccount.signMessage({message});
	}

	/**
	 * ONE derivation, shared by the round and by recovery.
	 *
	 * Built here rather than inline below because `./placement/recover-round`
	 * has to reproduce EXACTLY what was committed with. Two call sites
	 * constructing their own would compile, agree today, and diverge the moment
	 * one of them is edited - and the symptom of that is a player being told
	 * their own turn is not the one they committed, with nothing logged
	 * anywhere.
	 */
	const makeSecret = createDerivedSecret<GameIdentity>({
		sign: signAsSigner,
		chainId: deployments.chain.id,
		contract: deployments.contracts.Game.address,
	});

	const round = createRound<GameIdentity, Placement>({
		epochInfo,
		/**
		 * DERIVED, not random, so a cleared browser does not cost the stake.
		 *
		 * The template ships this rather than leaving it to each game because all
		 * four games derive their secret, and because the parts that are easy to
		 * get wrong are the ones with no symptom: normalising the address, and
		 * putting the identity in the message. See `game/core/secret.ts`.
		 *
		 * What this does NOT recover on its own is the ACTIONS - the chain holds
		 * only the hash. See D9 in the plan on the `work` branch, and
		 * `$lib/placement/recover-round` for the half that asks the player.
		 */
		makeSecret,
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
		// WHO PLAYS. The moves are SENT by the local signer (see the game executor
		// in `context/core.ts`), which is a different thing again: the sender is
		// neither the account nor the identity.
		identity: activeIdentity,
		onSettled: async () => {
			// A settled round changes both the board and the reserve. Awaited by the
			// round before it reports itself revealed, so the confirmed placements
			// are on the board by the time the planned ones stop being drawn: no
			// flicker of the moves disappearing and coming back.
			await Promise.all([onchainState.update(), reserve.update()]);
		},
	});

	const planning = createPlanning({round});

	/**
	 * The chain says a commitment exists; this browser may not know that.
	 *
	 * Wired from the read `missedReveal` was already making, and from the same
	 * secret and hashing the round commits with. Nothing is fetched for it and
	 * the framework gained one method for it (`round.adopt`).
	 */
	const recovery = createRoundRecovery({
		round,
		commitment: missedReveal.commitment,
		identity: activeIdentity,
		makeSecret,
		buildCommitment: buildPlacementCommitment,
	});

	/**
	 * THE HELD BOARD, not the poller's raw answer.
	 *
	 * Reveals arrive one transaction at a time and in whatever order the mempool
	 * delivers them, so a board that draws each as it lands shows a simultaneous
	 * round playing out in payment order - which is the very thing committing is
	 * paid for to prevent. What is held back is only what the resolving round
	 * changed, and only until it is over; see `$lib/placement/hold`.
	 *
	 * Everything about FETCHING - the settle, the catching-up phase, the RPC
	 * health - keeps reading the RAW store, because those are about what the
	 * chain says and this is about what the player is shown.
	 */
	const heldBoard = holdBoardUntilRoundEnds<HeldBoardState>({
		state: onchainState,
		phase: twoPhase,
		epoch: derived(epochInfo, ($info) => $info.currentEpoch),
		hold: holdResolvingRound,
	});

	const viewState = createViewState({
		onchainState: heldBoard.board,
		/**
		 * THE DISPLAY COPY of the plan, not the round's live one.
		 *
		 * The two halves of a turn - the local overlay before it resolves, the
		 * board's account of it after - have to hand over with nothing in between,
		 * and the round drops its actions the moment it reaches `Revealed`, before
		 * the board releases what they did. Released by the board's OWN signal, so
		 * the two cannot disagree about when the round ended.
		 *
		 * ONLY WHAT IS DRAWN. `planning.plan` is untouched and everything that
		 * ACTS on a turn keeps reading it.
		 */
		localState: holdPlanUntilBoardReleases({
			round,
			plan: planning.plan,
			holding: heldBoard.holding,
		}),
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
	 * Ordered AFTER the stake, because acquiring one carries the authorisation
	 * with it. See `setupNeeded` for why that is the order that leaves a player
	 * who abandons setup half way having spent as little as possible.
	 */
	const setup = derived(
		// THE ACCOUNT: the first question this gate asks is whether anyone is
		// signed in at all, which is about the account and not about what it plays.
		[account, core.delegation, reserve],
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
		const unsubscribeIdentity = activeIdentity.subscribe(() => {
			void reserve.update();
			// Whether a commitment is outstanding is a fact about the IDENTITY, not
			// about this browser: it has to be re-read whenever the identity changes,
			// and it is how a player who lost their local state still finds out.
			//
			// Both reads are keyed by the identity, so this follows the identity and
			// not the account. They are the same store here; a game that can switch
			// identity under one account would otherwise never re-read on a switch.
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

		// A purchase that was in flight when the tab was last closed finishes with
		// nobody watching: this browser did not send it, so none of the code that
		// normally follows one runs, and the player would sit on "finishing what
		// you already paid for" until they reload again, having already reloaded
		// once.
		const unsubscribeAcquisition = refreshWhenPendingAcquisitionSettles({
			acquisition,
			onSettled: () => void reserve.update(),
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
			unsubscribeIdentity();
			unsubscribeRound();
			unsubscribeEpoch();
			unsubscribeGas();
			unsubscribeAcquisition();
		};
	}

	return {
		onchainState,
		viewState,
		game: {
			config,
			identity: account,
			activeIdentity,
			chainTime,
			epochInfo,
			threePhase,
			phase,
			twoPhase,
			round,
			planning,
			reserve,
			acquisition,
			missedReveal,
			recovery,
			cost,
			readyToPlay,
			setup,
		},
		render: {camera, cameraControl, gameRenderer, eventEmitter},
		start,
	};
}
