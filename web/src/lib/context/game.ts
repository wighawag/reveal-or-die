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
	createCycleTrackers,
	createThreePhase,
	staticCycleConfig,
	type CycleInfoStore,
	type ThreePhase,
	type TwoPhase,
} from '$lib/game/core/cycle';
import {
	createSubmission,
	type SubmissionStorage,
	type SubmissionStore,
} from '$lib/game/core/submission';
import {
	createCycleAdvance,
	type CycleAdvanceStore,
} from '$lib/game/core/advance';
import {createDerivedSecret} from '$lib/game/core/secret';
import {holdBoardUntilCycleEnds} from '$lib/game/core/handover';
// The framework's, not this app's. Both used to be COPIED into this file - the
// same logic in two places in one repo, only the local pair reachable, and
// nothing anywhere able to notice. See the merge that removed them.
import {
	refreshDuringReveal,
	settleBoardWhenCycleStarts,
} from '$lib/game/core/refresh';
import {
	createSubmissionRecovery,
	type RecoveryStore,
} from '$lib/game/core/recovery';
import {
	boardIsBehindClock,
	cyclePhaseOf,
	type CyclePhase,
} from '$lib/game/core/cycle-phase';
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
import {resolveWorldConfig, type WorldConfig} from '$lib/world/config';
import {
	buildWorldCommitment,
	createWorldCommitReveal,
	type Action,
} from '$lib/world/commit-reveal';
import {
	createSubmissionStorage,
	noSubmissionStorage,
	submissionStorageKey,
} from '$lib/world/storage';
import {createPlanning, type PlanningStore} from '$lib/world/planning';
import {createControls, type Controls} from '$lib/world/controls';
import {holdResolvingCycle} from '$lib/world/hold';
import {
	createAttendanceReader,
	createCycleAdvancer,
	createCycleReader,
	waitedForOnChain,
	THIS_CONTRACT_JUDGES_AN_ADVANCE,
} from '$lib/world/advance';
import {
	recoverByEnumeration,
	type AutoRecoveryState,
} from '$lib/world/recover-submission';
import {holdPlanUntilBoardReleases} from '$lib/world/display-plan';
import {
	createRevealOutcome,
	type RevealOutcome,
} from '$lib/world/reveal-outcome';
import {SignerOutOfFundsError} from '$lib/world/errors';
import {isRegistered, type DelegationValue} from '$lib/onchain/delegation';
import {
	createDeposited,
	hasAvatarInGame,
	isAtRisk,
	type DepositedState,
	type DepositedStore,
} from '$lib/world/deposited';
import {
	createActiveAvatar,
	type ActiveAvatarStore,
} from '$lib/world/active-avatar';
import type {GameIdentity} from '$lib/game/identity';
import {
	blocksCommitting,
	createMissedReveal,
	type MissedRevealStore,
} from '$lib/world/missed-reveal';
import {createAvatarAcquisition} from '$lib/world/acquisition';
import {
	createWorldReader,
	emptyWorld,
	createZonesForCamera,
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
	 * THE ACCOUNT, and it means the same thing here as in the template it comes
	 * from. Exposed because the account/signer distinction is the safety
	 * property of the whole design and is otherwise invisible from outside:
	 * every avatar the contract holds is filed under this address, while a
	 * different key pays the gas and sends the moves.
	 *
	 * NOT what the submission is keyed by. That is `activeIdentity`, and here
	 * the two are genuinely different values of different types - an address
	 * that OWNS avatars, and the avatar being played. The template holds one
	 * value under
	 * both names, which is why the two names exist at all.
	 */
	identity: Readable<`0x${string}` | undefined>;
	/**
	 * WHO IS PLAYING: what the submission, the commitment, the secret's domain
	 * separation and the storage key are all keyed by. See `$lib/game/identity`.
	 *
	 * The framework's concept, and this game's answer to it is an avatar, plus
	 * the `select` needed to switch - an account can own several. One active per
	 * client is a client convention rather than something the chain enforces:
	 * see `$lib/world/active-avatar`.
	 */
	activeIdentity: ActiveAvatarStore;
	/** Chain-synced wall clock. NOT `clock`, which is only a UI ticker. */
	chainTime: ChainTimeStore;
	/** Which cycle we are in, and how far through its phases. */
	cycleInfo: CycleInfoStore;
	/** Player-facing phases: play / commit / reveal. */
	threePhase: Readable<ThreePhase>;
	/** The same, collapsed to play / wait. */
	twoPhase: Readable<TwoPhase>;
	/** The commit-reveal submission: what is planned, committed, revealed. */
	submission: SubmissionStore<GameIdentity, Action>;
	/**
	 * Pushing the cycle on, which a policy with no clock needs a transaction for.
	 *
	 * Idle on an ordinary TIMED deployment, where the cycle is the clock and the
	 * contract refuses to be pushed outright. It is exposed anyway rather than
	 * hidden behind the policy, because what it is doing - spending the player's
	 * gas, unprompted, to keep the game moving - is something a HUD should be
	 * able to say out loud.
	 */
	cycleAdvance: CycleAdvanceStore;
	/** Clicks into a planned entry or a planned path. */
	planning: PlanningStore;
	/**
	 * What the turn that just resolved DID, while the submission is reporting a
	 * reveal.
	 *
	 * Here rather than in the HUD because it REMEMBERS: the submission drops the
	 * actions when it flips to `Revealed`, so whatever answers this has to have
	 * been watching, and a store built per component would answer differently
	 * depending on when that component mounted.
	 */
	revealOutcome: Readable<RevealOutcome | undefined>;
	/**
	 * Keys, a gamepad and the on-screen d-pad, translated into game actions.
	 *
	 * Here rather than in `Render` because input is not a rendering concern and
	 * the two have different lifetimes: `work:docs/audits/03-renderer.md` 4.2 is about
	 * exactly this, and the previous build's version lived inside the renderer,
	 * where its teardown called `removeAllListeners()` on an emitter the canvas
	 * was also using.
	 *
	 * Exposed so the d-pad can call it: a component is a third input device, and
	 * one that reached past this into `planning` would be a second mapping.
	 */
	controls: Controls;
	/**
	 * The avatars the contract holds for this account: what the player has at
	 * stake, and what there is to play with.
	 *
	 * This is where the template keeps a token RESERVE. The shapes differ because
	 * the stakes do - an NFT in custody rather than a balance bonded per cycle -
	 * so there is no amount and no per-cycle cost here, which is why `reserve`
	 * and `cost` are gone rather than renamed.
	 */
	deposited: DepositedStore;
	/**
	 * Buying an avatar, which mints it straight into the game.
	 *
	 * The remedy for the `deposit` step of the setup gate, and the only thing here
	 * that spends the player's own money rather than the signer's gas. The rail is
	 * the framework's (`$lib/game/acquire`); what this game supplies is
	 * `world/acquisition.ts`, which is the arguments and nothing else.
	 */
	purchase: AcquisitionStore;
	/**
	 * An unrevealed commitment from a past cycle, which blocks all further play
	 * until the player acknowledges it.
	 */
	missedReveal: MissedRevealStore;
	/**
	 * A commitment the chain holds for the cycle in progress that this browser
	 * has no memory of - a cleared browser, a second device, a private window.
	 * The turn is still revealable while the cycle lasts.
	 */
	recovery: RecoveryStore<Action>;
	/**
	 * Whether the app is currently working the lost turn out for itself, and
	 * what is left if it cannot. See `$lib/world/recover-submission`.
	 */
	autoRecovery: Readable<AutoRecoveryState>;
	/**
	 * Where the active avatar stands on chain, or undefined when it is not in the
	 * world. Read from the account's own deposited avatars rather than off the
	 * board, because the board is camera-scoped and the player can pan away from
	 * their own avatar.
	 */
	currentPosition: Readable<Position | undefined>;
	/**
	 * Which part of the cycle this is: play, the commit lock, the reveal, or the
	 * catch-up while the board fetches what the new cycle assumes.
	 *
	 * The clock and the move gate both read this, and the HUD words itself from
	 * it. See {@link CyclePhase} for why the old two-phase model was not enough.
	 */
	phase: Readable<CyclePhase>;
	/**
	 * Whether the player can actually take a turn right now: an identity to play
	 * as, permission for this browser to act as it, an avatar to move, and the
	 * cycle being in the window where moves mean anything.
	 *
	 * Clicks do nothing while this is false. Letting someone plan a whole turn
	 * they cannot commit is worse than not letting them start: the moves look
	 * accepted, and the failure only arrives at the commit, by which point the
	 * cycle is over.
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

/** What a setup step can be acted on with, where anything can be. */
export type SetupAction = 'authorise' | 'buy';

/**
 * The four parts of a cycle, as the player experiences them.
 *
 * A cycle is: a window to plan and commit in, a lock while those commits land,
 * the reveal in which every planned move resolves, and - at the boundary - a
 * moment while the board fetches the state the new cycle assumes. The old
 * two-phase model folded the middle two into one "wait", which is fine to
 * play on and useless to debug against, and had no slot at all for the fourth.
 *
 * `catching-up` lasts until the board's own cycle catches up with the clock's,
 * which is however long the chain takes to mine past the boundary (see
 * `settleBoardWhenCycleStarts` for why the clock is ahead of the chain there),
 * and it disappears the moment a fetch lands the new cycle's data. The
 * COUNTDOWN during it is the play window it is holding up, so "when can I
 * move" keeps ticking while it lasts.
 */
/**
 * Whether a turn can be taken right now.
 *
 * Its own function, like `setupNeeded` beside it, because it is a GATE and the
 * two ways to get a gate wrong are opposites: too strict and a ready player
 * watches the board refuse them for a fifth of every cycle; too loose and a
 * plan gets built from a position that is about to be invalidated. Neither is
 * visible by reading the wiring.
 *
 * It stays HERE while `CyclePhase` moves upstream, because what it gates on is
 * this game's `SetupNeeded`: what a player must have before they may act is the
 * game's rule, and only the phase half of the question is the framework's.
 */
export function canTakeTurnNow(
	setup: SetupNeeded | undefined,
	phase: CyclePhase,
): boolean {
	return setup === undefined && phase === 'play';
}

/**
 * Re-exported so this game's modules keep one import for what the context
 * offers. The model itself is the framework's (`game/core/cycle-phase.ts`):
 * every game on this template has a clock that can run ahead of its board.
 */
export type {CyclePhase};

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
	onchainState: OnchainStateStore<WorldState & {cycleNumber: number}>;
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
 * by hand - the submission resumes.
 *
 * It matters most for a reveal, where the window is short and the commitment is
 * already made: asking the player to notice the failure, top up, and then also
 * remember to press retry is three chances to lose their turn. Worse here than
 * in the template, because a reveal that never lands also BLOCKS the next
 * cycle until `acknowledgeMissedReveal` is called.
 *
 * Its own function, taking only the two stores it reads, because it is the one
 * piece of wiring here that SPENDS the player's gas without being asked. That
 * deserves tests, and tests of it should not require standing up an app
 * context. Exported for the tests and used only just below.
 */
export function resumeWhenGasArrives(params: {
	submission: Pick<
		SubmissionStore<GameIdentity, Action>,
		'subscribe' | 'value' | 'commit' | 'reveal'
	>;
	signerBalance: Readable<{step: string; value?: bigint}>;
}): () => void {
	const {submission, signerBalance} = params;
	let gasSeen: bigint | undefined;

	return signerBalance.subscribe(($balance) => {
		if ($balance.step !== 'Loaded' || $balance.value === undefined) return;
		const previous = gasSeen;
		gasSeen = $balance.value;
		// Only a RISE, and never the first reading. The first reading is just this
		// browser learning what the balance already was, which fixes nothing, and a
		// balance that fell is the failed move's own gas being spent elsewhere.
		if (previous === undefined || $balance.value <= previous) return;

		const $submission = submission.value;
		// The type the game constructed at its own boundary, not a fresh look at
		// the node's wording. This decides whether to SPEND the player's gas
		// unprompted, so it must resume only for the failure the arriving money
		// actually fixes: any other error is still an error once the balance rises,
		// and retrying it just burns the top-up.
		if (
			$submission.step !== 'Error' ||
			!($submission.error instanceof SignerOutOfFundsError)
		) {
			return;
		}
		// Which one is not a detail: revealing when a commit failed would send a
		// reveal for a commitment that was never made.
		if ($submission.during === 'reveal') void submission.reveal();
		else void submission.commit();
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

	// THE AVATAR COMES FIRST, and the order was the other way round until buying
	// one started carrying the authorisation with it.
	//
	// It used to ask to authorise first, on the grounds that authorising was the
	// cheaper of two transactions and a player who abandons setup half way should
	// have spent as little as possible. That reasoning died with the second
	// transaction: `purchase` now funds the signer in the same call, and the
	// signer registers itself out of that stipend, so buying an avatar IS
	// authorising. Asking for authorisation first would demand a transaction that
	// the very next step includes.
	//
	// `Loading` is not `no avatars`: treating an unfinished read as an empty one
	// would put the gate over a playable board on every load until it lands.
	if (deposited.step === 'Loaded' && !hasAvatarInGame(deposited)) {
		return {step: 'deposit'};
	}

	// Still reachable, and still needed: a player who ALREADY has an avatar on
	// this account but is opening a second browser, or who revoked this one. They
	// have nothing left to buy, so there is no purchase to fold the authorisation
	// into, and the top-up flow (register and fund in one) is the remedy.
	if (delegation.step === 'Loaded' && !isRegistered(delegation)) {
		return {step: 'authorise'};
	}
	return undefined;
}

/**
 * Run something once per cycle, on the turnover.
 *
 * `cycleInfo` re-emits on every tick of the clock, so the trigger is the
 * CHANGE and not the value; without that, anything hung off it runs once a
 * second forever. The first emission is deliberately not a change either:
 * `start()` has just done the initial reads, and treating "the cycle became
 * known" as a turnover would double every one of them on load.
 *
 * Its own function, like the two below, because it is wiring that acts
 * unprompted - it spends RPC calls with nobody asking - and a test of it
 * should not need an app context.
 */
export function onEachNewCycle(params: {
	cycleInfo: Readable<{currentCycleNumber: number}>;
	run: () => void;
}): () => void {
	const {cycleInfo, run} = params;
	let lastCycleNumber: number | undefined;
	return cycleInfo.subscribe(($cycle) => {
		if (
			lastCycleNumber !== undefined &&
			$cycle.currentCycleNumber !== lastCycleNumber
		)
			run();
		lastCycleNumber = $cycle.currentCycleNumber;
	});
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
	 * provides. See work:docs/plans/web-port.md.
	 *
	 * Undefined until the player connects, which the setup gate below turns into
	 * an instruction rather than a broken board.
	 */
	const account = core.account;

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
	// WHICH CLOCK THE DEPLOYMENT IS RUNNING, rather than the one this app would
	// prefer. A timed game is pure arithmetic and asks the chain nothing; the
	// other two policies can be moved by a transaction, so for them the chain is
	// the authority and `chainTime` only predicts between reads.
	//
	// THE DISPATCHER RATHER THAN THE TIMED TRACKER, and the comment that used to
	// stand here said this repo could not use it because its contracts have "no
	// `getCycle` to ask". That was wrong about the NAME and right about
	// everything else, which is a combination worth recording: the read exists
	// and is called `getEpoch`, and it answers under both policies, because
	// `_epoch()` returns the manual cycle when there is no clock. What was
	// genuinely missing was the other half - a commit phase under the manual
	// policy, which this game's contract derived away into `SKIP_COMMIT` - and
	// that is fixed in the same change as this line. See `$lib/world/advance`.
	const {
		cycleInfo,
		twoPhase,
		refresh: refreshCycle,
	} = createCycleTrackers({
		chainTime,
		config: staticCycleConfig(config.cycle),
		readCycle: createCycleReader({
			publicClient: core.publicClient,
			deployments: core.deployments,
		}),
	});
	const threePhase = createThreePhase(cycleInfo);
	const currentCycleNumber = derived(
		cycleInfo,
		($cycle) => $cycle.currentCycleNumber,
	);

	/**
	 * WHO PUSHES THE CYCLE, on a deployment where something has to.
	 *
	 * Built for every policy and INERT under the timed one: it reads the policy
	 * off the deployment, and under `timed` it polls nothing and sends nothing,
	 * so an ordinary deployment's RPC traffic is exactly what it was. Under
	 * `manual` it is what makes a round completable at all - the reveal phase
	 * does not open until somebody calls `advanceCycle`, and a reveal sent
	 * before it is refused with `InCommitmentPhase`.
	 */
	const cycleAdvance = createCycleAdvance({
		cycleInfo,
		readAttendance: createAttendanceReader({
			publicClient: core.publicClient,
			deployments: core.deployments,
			cycleNumber: () => get(currentCycleNumber),
			// WHO THE CYCLE WAITS FOR IS NOT ON CHAIN HERE, which is the one place
			// this game's contract is behind the framework and the reason this
			// argument exists at all. The template reads `getAttendance` and needs
			// to be told nothing; this game has no membership set, so a world that
			// wants unanimity has to say who is in it. An ordinary deployment says
			// nobody, which reads as `NoOneToWaitFor` and pushes nothing - the same
			// answer the contract would give. See `$lib/world/advance`.
			waitedFor: () => waitedForOnChain(deployments.chain.id),
		}),
		advance: createCycleAdvancer(core),
		refreshCycle,
		// NO, AND THE ANSWER IS THIS GAME'S TO GIVE, which is why it is a named
		// constant in `world/advance.ts` beside the evidence rather than a literal
		// here. This line arrived from the template saying `true`, merged cleanly,
		// and was false the moment it landed: that contract re-checks four
		// conditions and this one re-checks the policy alone.
		contractIsTheJudge: THIS_CONTRACT_JUDGES_AN_ADVANCE,
	});

	const {camera, cameraControl} = createCamera(config.camera);
	const eventEmitter = createCanvasEventEmitter();

	const onchainState = createPollingOnchainState<WorldState>({
		publicClient: core.publicClient,
		deployments,
		camera,
		cycleInfo,
		chainTime,
		// A turn's worth of travel beyond the camera, because the same zones scope
		// the reveal logs and an avatar's log is filed under the zone it ended in.
		zonesForCamera: createZonesForCamera({reach: config.numMoves}),
		read: createWorldReader({publicClient: core.publicClient, deployments}),
		emptyState: emptyWorld,
		fetchGate: core.chainFetchGate,
	});

	/**
	 * The settle that runs when a cycle begins. Constructed here - which is
	 * inert, since `watch()` is what opens the subscription, and opening it
	 * here would start the chain clock at construction time against ADR-0002 -
	 * and `start()` is what watches.
	 *
	 * What the player SEES is not this loop but the four-phase model: the
	 * catch-up is a phase on the clock, read off the gap itself, so it stays
	 * honest whether this settle is running, finished or gave up.
	 */
	const settle = settleBoardWhenCycleStarts({
		phase: twoPhase,
		cycleNumber: currentCycleNumber,
		// One cast, at the one place the mismatch is: the store's value is the
		// full `OnchainStateValue<WorldState>`, and svelte's store typing is
		// contravariant in the subscriber, so a store of a WIDER value does not
		// satisfy `Readable` of the narrower one even though every value it emits
		// has the `cycleNumber` this reads. The Loaded branch always carries it.
		state: onchainState as unknown as Readable<
			{step: 'Unloaded'} | {step: 'Loaded'; cycleNumber: number}
		>,
		refresh: () => onchainState.update(),
	});

	/**
	 * Is the board still showing the cycle that just ended?
	 *
	 * NOT THE SETTLE'S TIMER: a settle can still be running once a fetch has
	 * landed, and the board can be unfetched without any settle having been
	 * triggered. What the player experiences is the gap, so the gap is what this
	 * reads. The rule and the trap underneath it are `boardIsBehindClock`.
	 */
	const boardBehindClock = derived(
		[currentCycleNumber, onchainState],
		([$cycle, $state]) =>
			boardIsBehindClock({
				board: $state as {step: string; cycleNumber?: number},
				currentCycleNumber: $cycle,
			}),
	);

	/** The four-phase model the HUD and the move gate read. See {@link CyclePhase}. */
	const phase = derived([threePhase, boardBehindClock], ([$three, $behind]) =>
		cyclePhaseOf($three, $behind),
	);

	const deposited = createDeposited({deps: core, owner: account});

	const purchase = createAcquisition({
		deps: core,
		acquisition: createAvatarAcquisition({config, deployments}),
		owner: account,
		// The same grant the top-up flow shows, from the one place this app
		// declares it, so the two cannot describe two different keys.
		grant: SIGNER_GRANT,
		// The avatar is in the contract's custody the moment the purchase lands, so
		// re-reading is what takes the player past the setup gate and onto the board.
		onAcquired: () => void deposited.update(),
	});

	const activeIdentity = createActiveAvatar({
		deposited,
		owner: account,
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
		[deposited, activeIdentity],
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
	 * avatar can both change while the app is running, and a pending submission
	 * belonging to a different avatar would fail to reveal and read as a contract
	 * bug. See `submissionStorageKey` for why the avatar is part of the key at
	 * all.
	 */
	const storage: SubmissionStorage<Action> = {
		load: () => forCurrentAvatar().load(),
		save: (submission) => forCurrentAvatar().save(submission),
		clear: () => forCurrentAvatar().clear(),
	};

	function forCurrentAvatar(): SubmissionStorage<Action> {
		const avatarID = get(activeIdentity);
		if (avatarID === undefined) return noSubmissionStorage;
		return createSubmissionStorage({
			key: submissionStorageKey({
				chainID: deployments.chain.id,
				gameAddress: deployments.contracts.Game.address,
				avatarID,
			}),
		});
	}

	const missedReveal = createMissedReveal({
		deps: core,
		avatarID: activeIdentity,
		currentCycleNumber,
		// Acknowledging changes what the contract holds for this avatar, so the
		// deposited read is no longer current.
		onSettled: () => void deposited.update(),
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
	 * secret. A silent fallback would produce a submission that looks identical
	 * and is not recoverable, which is the failure this is here to prevent,
	 * and the setup gate already refuses to let anyone commit before signing in.
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
	 * ONE derivation, shared by the submission, by recovery and by the search.
	 *
	 * Built here rather than inline below because all three have to reproduce
	 * EXACTLY what was committed with. Separate call sites would compile, agree
	 * today, and diverge the moment one is edited - and the symptom is a player
	 * told their own turn is not the one they committed, with nothing logged.
	 */
	const makeSecret = createDerivedSecret<GameIdentity>({
		sign: signAsSigner,
		chainId: deployments.chain.id,
		contract: deployments.contracts.Game.address,
	});

	const submission = createSubmission<GameIdentity, Action>({
		cycleInfo,
		/**
		 * DERIVED, not random, so a cleared browser does not cost the avatar.
		 *
		 * Restores what the port dropped. The pre-port build derived the secret
		 * from a signature (`lib/private/localState.ts` in bomber-world), and the
		 * submission here fell back to 32 random bytes in local storage - which
		 * matters more in this game than in the template's, because what is at
		 * stake is an avatar that DIES after `numMissesAllowed` missed cycles.
		 * Clearing site data mid-cycle cost it.
		 *
		 * The identity is the AVATAR, not the account, which is why the framework
		 * passes it: a player who owns two avatars must not derive one secret for
		 * both. See `game/core/secret.ts`.
		 *
		 * What this does NOT recover on its own is the planned ACTIONS - the chain
		 * holds only the hash. See D9 in the template's plan.
		 */
		makeSecret,
		adapter: createWorldCommitReveal({
			deps: core,
			// Refuse to commit while an unrevealed commitment is in the way, and say
			// so in words the player can act on. `_makeCommitment` rejects one left
			// over from an earlier cycle with `PreviousCommitmentNotRevealed`, so
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
		/**
		 * KEEP THE LOOP TURNING EVEN WITH NOTHING PLANNED.
		 *
		 * `_getResolvedAvatar` says it in as many words: "we force character to
		 * continuously commit+reveal". With `numMissesAllowed = 3`, an avatar whose
		 * `lastEpoch` falls more than four cycles behind is set to `life = 0`.
		 * `lastEpoch` only advances on a REVEAL, so a player who watches a few
		 * cycles without moving loses the avatar they paid for, having done nothing
		 * wrong and been warned by nothing.
		 *
		 * Only while the avatar has something to LOSE by going quiet, which is
		 * `isAtRisk` and not "is it standing somewhere". One waiting to enter has no
		 * clock running against it (`_getResolvedAvatar` forces `life = 1` for an
		 * avatar that is not `inGame`), and one that is already DEAD has nothing
		 * left to protect: it keeps a position, so a check on that alone kept the
		 * loop running for a corpse, and `_makeCommitment` reverts with
		 * `AvatarIsDead` - a transaction the signer pays for and the contract
		 * refuses, once a cycle, for as long as the tab is open.
		 */
		commitWhenIdle: () => isAtRisk(get(deposited), get(activeIdentity)),
		// The AVATAR, not the account: `commit` and `reveal` both take an avatar id
		// and resolve the sender against its owner. `PlayerIdentity` is
		// `bigint | 0x${string}` for exactly this, so nothing has to widen.
		identity: activeIdentity,
		onSettled: async () => {
			// A settled submission moves the avatar, which changes both the board and
			// the account's own read of where it stands. Awaited by the submission
			// before it
			// reports itself revealed, so the confirmed position is in place by the
			// time the planned path stops being drawn: no flicker of the moves
			// disappearing and coming back.
			await Promise.all([onchainState.update(), deposited.update()]);
		},
	});

	const planning = createPlanning({
		submission,
		config,
		currentPosition,
		activeIdentity,
		player: account,
	});

	/**
	 * The chain says a commitment exists; this browser may not know that.
	 *
	 * Wired from the read `missedReveal` was already making, and from the same
	 * secret and hashing the submission commits with. Nothing is fetched for it.
	 */
	const recovery = createSubmissionRecovery<GameIdentity, Action>({
		submission,
		commitment: missedReveal.commitment,
		identity: activeIdentity,
		makeSecret,
		buildCommitment: buildWorldCommitment,
	});

	/**
	 * ...and this game can usually work out WHAT was committed, without asking.
	 *
	 * A turn here is a walk over walkable cells, and the maze keeps that small
	 * enough to search: see `$lib/world/recover-submission`, which is also where
	 * the measurement and the budget are. Where the search cannot answer - an
	 * avatar that was ENTERING, or a map more open than the budget - it says so
	 * and the
	 * player re-enters the turn, which is the route the template's game uses for
	 * everything.
	 */
	const autoRecovery = recoverByEnumeration({
		recovery,
		currentPosition,
		identity: activeIdentity,
		numMoves: config.numMoves,
		makeSecret,
		buildCommitment: buildWorldCommitment,
		commitment: missedReveal.commitment,
	});

	/**
	 * THE HELD BOARD, not the poller's raw answer.
	 *
	 * Reveals arrive one transaction at a time and in whatever order the mempool
	 * delivers them, so a board that draws each as it lands shows a simultaneous
	 * cycle playing out in payment order. The WHEN is the framework's
	 * (`$lib/game/core/handover`); what is held back is this game's own rule
	 * (`$lib/world/hold`), and only until the cycle is over.
	 *
	 * Everything about FETCHING - the settle, the catching-up phase, the RPC
	 * health - keeps reading the raw store, because those are about what the
	 * chain says and this is about what the player is shown.
	 */
	const heldBoard = holdBoardUntilCycleEnds<WorldState & {cycleNumber: number}>(
		{
			state: onchainState,
			phase: twoPhase,
			cycleNumber: currentCycleNumber,
			hold: holdResolvingCycle,
		},
	);

	const viewState = createViewState({
		onchainState: heldBoard.board,
		/**
		 * THE DISPLAY COPY of the plan, not the submission's live one.
		 *
		 * The two halves of a turn - the local overlay before it resolves, the
		 * board's account of it after - have to hand over with nothing in
		 * between, and the submission drops its actions the moment it reaches
		 * `Revealed`, seconds before the board releases what they did. See
		 * `$lib/world/display-plan`. It is released by the board's OWN signal, so
		 * the two cannot disagree about when the cycle ended.
		 *
		 * ONLY WHAT IS DRAWN. `planning.plan` itself is untouched, and everything
		 * that acts on a turn keeps reading it and the submission: a held display
		 * copy must not make the HUD offer an Undo for a turn already on chain.
		 */
		localState: holdPlanUntilBoardReleases({
			submission,
			plan: planning.plan,
			holding: heldBoard.holding,
		}),
		merge: mergeWorldView,
	});

	/**
	 * The player's own avatar as the BOARD holds it, camera-scoped.
	 *
	 * Used for what the chain ACCEPTED of the last turn: `lastTurn` on it is the
	 * resolved prefix out of `CommitmentRevealed`, which is the truth about what
	 * the turn did where the submission's own memory only knows what was revealed.
	 * Undefined whenever the avatar is not in the fetched zones - out of the
	 * world, or panned away from - which is why it is a fallback and not the
	 * only input.
	 */
	const myAvatarOnBoard = derived(
		[viewState, activeIdentity],
		([$view, $avatarID]) =>
			$view.step === 'Loaded' && $avatarID !== undefined
				? $view.avatars.get($avatarID)
				: undefined,
	);

	const revealOutcome = createRevealOutcome(submission, myAvatarOnBoard);

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
		[account, core.delegation, deposited],
		([$identity, $delegation, $deposited]) =>
			setupNeeded({
				identity: $identity,
				delegation: $delegation,
				deposited: $deposited,
			}),
	);

	/**
	 * Whether the player can actually take a turn right now.
	 *
	 * Three things used to stand between a player and their first move - an
	 * identity, permission for this browser, an avatar the contract is holding -
	 * and a fourth is added here: THE PLAY WINDOW. Nothing can be planned
	 * outside it, because everything the plan would be built from is stale
	 * there. During the reveal the avatar's next position is exactly the thing
	 * being decided; during the catch-up the board has not caught up with the
	 * cycle that just resolved. Planning from either is planning from a guess,
	 * and a plan the contract then refuses costs the turn to `stopProcessing`
	 * silently.
	 *
	 * Letting someone plan a turn they cannot commit is worse than not letting
	 * them start, and this is the same principle one cycle in: the moves look
	 * accepted, and the failure only arrives when it is too late to matter.
	 */
	const readyToPlay = derived([setup, phase], ([$setup, $phase]) =>
		canTakeTurnNow($setup, $phase),
	);

	/**
	 * Built here, but NOT listening here.
	 *
	 * Constructing it in the context is what gives every device one mapping;
	 * binding it to a keyboard is a lifetime question, and this file is the wrong
	 * scope to answer it. `start()` runs for the whole session (see
	 * `context/Context.svelte`), so attaching the keyboard here would plan moves
	 * while the player is on another page. The play route owns the binding
	 * instead, and says why.
	 */
	const controls = createControls({
		planning,
		submission,
		missedReveal,
		readyToPlay,
	});

	function start() {
		const stopSubmission = submission.start();
		const stopCycleAdvance = cycleAdvance.start();

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
		const unsubscribeAccount = account.subscribe(() => {
			void deposited.update();
			// Whether a commitment is outstanding is a fact about the AVATAR, not
			// about this browser: it has to be re-read when the account changes, and
			// it is how a player who lost their local state still finds out.
			void missedReveal.check();
		});

		// Same question, asked again for a different avatar. Switching avatars in
		// one browser is exactly the case where the local submission says nothing and
		// the chain may still be holding an unrevealed commitment.
		const unsubscribeAvatar = activeIdentity.subscribe(() => {
			void missedReveal.check();
		});

		// A submission that ends in Missed locally is very likely blocked on chain
		// too.
		//
		// And a submission that has just LANDED is the moment unanimity may have
		// been completed by this browser's own transaction: on a manual deployment
		// the reveal phase becomes pushable the instant the last commitment lands,
		// and the next cycle the instant the last reveal does. Asking then rather
		// than on the next poll is the whole difference between a round that feels
		// instant and one that pauses twice for a poll interval. It costs one read
		// when a submission changes state, and nothing on a timed deployment, where
		// the advance is inert.
		const unsubscribeSubmission = submission.subscribe(($submission) => {
			if ($submission.step === 'Missed') void missedReveal.check();
			if ($submission.step === 'Committed' || $submission.step === 'Revealed') {
				void cycleAdvance.check();
			}
		});

		const unsubscribeGas = resumeWhenGasArrives({
			submission,
			signerBalance: core.signerBalance,
		});

		// THE BOARD REFRESHES WHEN IT CAN CHANGE, and only then. During the reveal
		// window that is every second and a half, because another player's move
		// is invisible from here; at the commit phase's start it is a settle that
		// retries until the board has actually caught up, because the client's
		// clock crosses the cycle boundary ahead of the chain and a fetch that
		// gives up into backoff leaves the new cycle drawn on the previous one's
		// board.
		const stopSettleWatch = settle.watch();
		const stopRevealRefresh = refreshDuringReveal({
			phase: twoPhase,
			refresh: () => onchainState.update(),
		});

		// A purchase that was in flight when the tab was last closed finishes with
		// nobody watching: this browser did not send it, so none of the code that
		// normally follows one runs. Without this the player waits on "finishing
		// your purchase" until they reload again, having already reloaded once.
		const unsubscribePurchase = refreshWhenPendingAcquisitionSettles({
			acquisition: purchase,
			onSettled: () => void deposited.update(),
		});

		// Ask the chain about this ACCOUNT again whenever the cycle turns over.
		//
		// Both of these are questions about the CURRENT CYCLE rather than fixed
		// properties, which is what makes a per-cycle re-read the right cadence
		// rather than a poll bolted on.
		//
		// Whether a commitment counts as MISSED changes by itself: the very same
		// commitment is live in the cycle it was made and blocking in the next one.
		// Checking only on load and on account change means a tab that was open
		// across the boundary answers "nothing is wrong" once and never revisits
		// it, leaving the player silently blocked with no idea why committing does
		// nothing.
		//
		// And so does whether an avatar is still ALIVE. `_getResolvedAvatar`
		// computes `life` from how far `lastEpoch` has fallen behind the cycle
		// being asked about, so a kill happens on the chain's clock with nobody
		// sending anything. `deposited` used to be re-read only when something this
		// client did succeeded - a reveal, a purchase, an acknowledgement - which
		// is precisely the wrong condition for learning about a death, because a
		// death is what happens when this client STOPS succeeding. Nothing
		// succeeded again afterwards either: `_makeCommitment` reverts with
		// `AvatarIsDead`. So the client went on believing the avatar was alive
		// until the page was reloaded, and everything downstream inherited that -
		// no death notice, a corpse still selected as the active avatar, and the
		// missed-reveal panel demanding an acknowledgement for it.
		const unsubscribeCycle = onEachNewCycle({
			cycleInfo,
			run: () => {
				void missedReveal.check();
				void deposited.update();
			},
		});

		return () => {
			stopSubmission();
			stopCycleAdvance();
			eventEmitter.off('clicked', onClicked);
			unsubscribeAccount();
			unsubscribeAvatar();
			unsubscribeSubmission();
			unsubscribeCycle();
			unsubscribeGas();
			unsubscribePurchase();
			stopSettleWatch();
			stopRevealRefresh();
			// The search subscribes for the whole session, because the state it
			// reacts to can appear at any point in it: a second device commits, or
			// this one is opened again after its storage was cleared.
			autoRecovery.stop();
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
			cycleInfo,
			threePhase,
			twoPhase,
			submission,
			cycleAdvance,
			planning,
			revealOutcome,
			controls,
			deposited,
			purchase,
			missedReveal,
			recovery,
			autoRecovery: autoRecovery.state,
			currentPosition,
			phase,
			readyToPlay,
			setup,
		},
		render: {camera, cameraControl, gameRenderer, eventEmitter},
		start,
	};
}
