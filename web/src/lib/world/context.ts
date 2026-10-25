/**
 * The game half of the app context.
 *
 * `createContext` used to build everything in one function. It is split so the
 * two halves can move independently: `core.ts` is jolly-roger's, merged down
 * from upstream and best left alone, while this file is the game composed on
 * the template's commit-reveal skeleton (`$lib/game/core/commit-reveal-game`).
 * The skeleton owns the WIRING (which store re-checks what, and when); this file
 * hands it the game's parts: the avatar, its position, the walk, the
 * enumeration recovery, the controls and the reveal outcome.
 *
 * Constructed synchronously and off-browser, like the core half: nothing here
 * starts IO, which belongs to `start()`. See ADR-0002.
 */
import {derived, get, type Readable} from 'svelte/store';
import type {CoreServices} from '$lib/context/core';
import type {SignerGrant} from '$lib/ui/delegation/grant';
import type {ChainTimeStore} from '$lib/game/core/chain-time';
import type {CycleInfoStore, ThreePhase, TwoPhase} from '$lib/game/core/cycle';
import type {SubmissionStore} from '$lib/game/core/submission';
import type {CycleAdvanceStore} from '$lib/game/core/advance';
// The framework's, not this app's. Both used to be COPIED into this file - the
// same logic in two places in one repo, only the local pair reachable, and
// nothing anywhere able to notice. See the merge that removed them.
import {
	refreshDuringReveal,
	settleBoardWhenCycleStarts,
} from '$lib/game/core/refresh';
import type {RecoveryStore} from '$lib/game/core/recovery';
import type {CyclePhase} from '$lib/game/core/cycle-phase';
import {
	createCommitRevealGame,
	onEachNewCycle,
	type SetupNeeded as FrameworkSetupNeeded,
} from '$lib/game/core/commit-reveal-game';
import type {AcquisitionStore} from '$lib/game/acquire';
import type {CameraControl, CameraWatcher} from '$lib/game/render/camera';
import type {CanvasEventEmitter} from '$lib/game/render/events';
import type {GameRenderer} from '$lib/game/core/seams';
import type {OnchainStateStore} from '$lib/onchain/state';
import type {ViewStateStore} from '$lib/view';

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
	submissionStorageKey,
} from '$lib/world/storage';
import {createPlanning, type PlanningStore} from '$lib/world/planning';
import {createControls, type Controls} from '$lib/world/controls';
import {holdResolvingCycle} from '$lib/world/hold';
import {
	createAttendanceReader,
	createCycleAdvancer,
	createCycleReader,
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
 * What stands between the player and their first move, in the order it has to
 * happen. `deposit` is where the template says `stake`: the same gate asked
 * about a different thing at stake, an avatar the contract holds rather than a
 * reserve. Gas is shown as information and is deliberately not a gate.
 */
export type SetupNeeded = FrameworkSetupNeeded<{step: 'deposit'}>;

/** What a setup step can be acted on with, where anything can be. */
export type SetupAction = 'authorise' | 'buy';

/**
 * This game's step of the setup gate: the contract has to be holding an avatar.
 *
 * The framework's `setupNeeded` puts it between signing in and authorising,
 * because buying an avatar funds the signer, which registers itself out of the
 * stipend: buying IS authorising. `Loading` is not "no avatars": treating an
 * unfinished read as an empty one would put the gate over a playable board on
 * every load until it lands.
 */
export function depositNeeded(
	deposited: DepositedState,
): {step: 'deposit'} | undefined {
	return deposited.step === 'Loaded' && !hasAvatarInGame(deposited)
		? {step: 'deposit'}
		: undefined;
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

/** This game's types, as the commit-reveal skeleton is told them. */
type WorldGame = {
	identity: GameIdentity;
	action: Action;
	board: WorldState & {cycleNumber: number};
	view: WorldView;
	planning: PlanningStore;
	missedReveal: MissedRevealStore;
	stake: {step: 'deposit'};
	surface: GameSurface;
};

export function createGameContext(core: CoreServices): GameContext {
	/**
	 * The address the game plays as: the AUTHENTICATED ACCOUNT, which owns the
	 * avatars, while the local signer acts for it, authorised on chain by
	 * `registerDelegate`. Losing the browser costs a key, not the avatars.
	 *
	 * The authority is ACCOUNT-WIDE, deliberately, and not per avatar:
	 * `_requireAccountForAvatar` resolves the avatar's owner and asks whether the
	 * sender may act for that account, so one active avatar per client is a
	 * convention this client keeps rather than a partition the chain provides.
	 * See work:docs/plans/web-port.md.
	 */
	const account = core.account;

	// `.get()`: deployments are fixed for the life of the app, and the game's
	// readers need them synchronously at construction.
	const deployments = core.deployments.get();
	const config = resolveWorldConfig(deployments);

	const deposited = createDeposited({deps: core, owner: account});

	/**
	 * WHO PLAYS: the avatar, not the account. `commit` and `reveal` both take an
	 * avatar id and resolve the sender against its owner, and a player who owns
	 * two must not derive one secret for both.
	 */
	const activeIdentity = createActiveAvatar({
		deposited,
		owner: account,
		chainID: deployments.chain.id,
		gameAddress: deployments.contracts.Game.address,
	});

	/**
	 * Where the active avatar stands, from the ACCOUNT'S OWN read. Not from the
	 * board, which is scoped to what the camera can see: a player who pans away
	 * would have it read as "not in the world", and the next click would be
	 * planned as an entry rather than a step.
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

	// The commit-reveal wiring is the framework's; what follows is this game.
	const world = createCommitRevealGame<WorldGame>(core, {
		identity: activeIdentity,
		contract: deployments.contracts.Game.address,
		cycle: {
			// THE DISPATCHER, not the timed tracker: `getCycleNumber` answers under
			// both policies, and the manual one has a commit phase since this game's
			// contract stopped deriving it away. See `$lib/world/advance`.
			config: config.cycle,
			readCycle: createCycleReader({
				publicClient: core.publicClient,
				deployments: core.deployments,
			}),
			readAttendance: createAttendanceReader({
				publicClient: core.publicClient,
				deployments: core.deployments,
			}),
			advance: createCycleAdvancer(core),
			// THE ANSWER IS THIS GAME'S TO GIVE, which is why it is a named constant
			// in `world/advance.ts` beside the evidence rather than a literal here.
			contractIsTheJudge: THIS_CONTRACT_JUDGES_AN_ADVANCE,
		},
		camera: config.camera,
		board: ({poll}) =>
			poll<WorldState>({
				// A turn's worth of travel beyond the camera, because the same zones
				// scope the reveal logs and an avatar's log is filed under the zone it
				// ended in.
				zonesForCamera: createZonesForCamera({reach: config.numMoves}),
				read: createWorldReader({publicClient: core.publicClient, deployments}),
				emptyState: emptyWorld,
			}),
		// Acknowledging changes what the contract holds for this avatar, so the
		// deposited read is no longer current.
		missedReveal: ({currentCycleNumber}) =>
			createMissedReveal({
				deps: core,
				avatarID: activeIdentity,
				currentCycleNumber,
				onSettled: () => void deposited.update(),
			}),
		blocksCommitting,
		adapter: ({beforeCommit}) => createWorldCommitReveal({deps: core, beforeCommit}),
		buildCommitment: buildWorldCommitment,
		// See `submissionStorageKey` for why the avatar is part of the key at all.
		storageFor: (avatarID) =>
			createSubmissionStorage({
				key: submissionStorageKey({
					chainID: deployments.chain.id,
					gameAddress: deployments.contracts.Game.address,
					avatarID,
				}),
			}),
		submission: {
			/**
			 * KEEP THE LOOP TURNING EVEN WITH NOTHING PLANNED. `_getResolvedAvatar`
			 * kills an avatar whose `lastCycleNumber`, which only a REVEAL moves,
			 * falls more than `numMissesAllowed` cycles behind. Only while the avatar
			 * has something to lose (`isAtRisk`): one waiting to enter has no clock
			 * running, and a dead one would make `_makeCommitment` revert with
			 * `AvatarIsDead` once a cycle, at the signer's expense.
			 */
			commitWhenIdle: () => isAtRisk(get(deposited), get(activeIdentity)),
		},
		isOutOfGas: (error) => error instanceof SignerOutOfFundsError,
		stake: {
			refresh: () => deposited.update(),
			needed: derived(deposited, depositNeeded),
			acquisition: createAvatarAcquisition({config, deployments}),
			grant: SIGNER_GRANT,
		},
		planning: ({submission}) =>
			createPlanning({
				submission,
				config,
				currentPosition,
				activeIdentity,
				player: account,
			}),
		hold: holdResolvingCycle,
		holdPlan: holdPlanUntilBoardReleases,
		merge: mergeWorldView,
		renderer: ({viewState}) =>
			createGameRenderer({viewState, cellSize: config.cellSize}),
		click: (position, {planning}) => {
			// Rounded rather than floored because cells are centred on their integer
			// coordinate (the cell at 3,4 spans 2.5..3.5).
			const cell = {x: Math.round(position.x), y: Math.round(position.y)};
			// Out of the world: a click chooses where to appear, and it is the WHOLE
			// turn (`_enter` sets `stopProcessing`), so it replaces the plan.
			if (get(currentPosition) === undefined) planning.enterAt(cell);
			// In the world: the next step of a path. `stepTo` refuses anything that
			// is not a legal single step, because a move the contract rejects
			// silently discards the REST of the turn as well.
			else planning.stepTo(cell);
		},
		/**
		 * THE PLAY WINDOW is a gate here: during the reveal the avatar's next
		 * position is exactly what is being decided, and during the catch-up the
		 * board has not caught up with it, so a plan built then is built from a
		 * guess, and one the contract refuses costs the turn to `stopProcessing`.
		 */
		onlyInPlayPhase: true,
		start: () => {
			const {missedReveal, twoPhase, currentCycleNumber, cycleInfo} = world.game;
			void deposited.update();
			// The deposited avatars are the ACCOUNT's, so they follow the account.
			const unsubscribeAccount = account.subscribe(() => {
				void deposited.update();
				void missedReveal.check();
			});
			// Whether an avatar is still ALIVE changes on the chain's clock with
			// nobody sending anything (`_getResolvedAvatar` computes `life` from how
			// far `lastCycleNumber` has fallen behind), and a death is exactly what
			// this client does not learn from its own successes: re-read per cycle.
			const unsubscribeCycle = onEachNewCycle({
				cycleInfo,
				run: () => void deposited.update(),
			});
			// THE BOARD REFRESHES WHEN IT CAN CHANGE: during the reveal, and in a
			// settle at the commit phase's start that retries until the board has
			// caught up with the clock.
			const settle = settleBoardWhenCycleStarts({
				phase: twoPhase,
				cycleNumber: currentCycleNumber,
				// One cast, at the one place the mismatch is: svelte's store typing is
				// contravariant in the subscriber, so a store of the wider value does
				// not satisfy `Readable` of the narrower one, though every Loaded value
				// carries the `cycleNumber` this reads.
				state: world.onchainState as unknown as Readable<
					{step: 'Unloaded'} | {step: 'Loaded'; cycleNumber: number}
				>,
				refresh: () => world.onchainState.update(),
			});
			const stopSettleWatch = settle.watch();
			const stopRevealRefresh = refreshDuringReveal({
				phase: twoPhase,
				refresh: () => world.onchainState.update(),
			});
			return () => {
				unsubscribeAccount();
				unsubscribeCycle();
				stopSettleWatch();
				stopRevealRefresh();
				// The search subscribes for the whole session, because the state it
				// reacts to can appear at any point in it.
				autoRecovery.stop();
			};
		},
	});

	/**
	 * ...and this game can usually work out WHAT was committed, without asking:
	 * a turn is a walk over walkable cells, small enough to search. See
	 * `$lib/world/recover-submission`. Same secret and hashing as the submission.
	 */
	const autoRecovery = recoverByEnumeration({
		recovery: world.game.recovery,
		currentPosition,
		identity: activeIdentity,
		numMoves: config.numMoves,
		makeSecret: world.makeSecret,
		buildCommitment: buildWorldCommitment,
		commitment: world.game.missedReveal.commitment,
	});

	/**
	 * The player's own avatar as the BOARD holds it: `lastTurn` on it is the
	 * resolved prefix out of `CommitmentRevealed`, the truth about what the turn
	 * did. Undefined whenever the avatar is not in the fetched zones.
	 */
	const myAvatarOnBoard = derived(
		[world.viewState, activeIdentity],
		([$view, $avatarID]) =>
			$view.step === 'Loaded' && $avatarID !== undefined
				? $view.avatars.get($avatarID)
				: undefined,
	);
	const revealOutcome = createRevealOutcome(
		world.game.submission,
		myAvatarOnBoard,
	);

	/**
	 * Built here, but NOT listening here: binding it to a keyboard is a lifetime
	 * question, and `start()` runs for the whole session, so the play route owns
	 * the binding instead.
	 */
	const controls = createControls({
		planning: world.game.planning,
		submission: world.game.submission,
		missedReveal: world.game.missedReveal,
		readyToPlay: world.game.readyToPlay,
	});

	return {
		onchainState: world.onchainState,
		viewState: world.viewState,
		game: {
			...world.game,
			config,
			activeIdentity,
			revealOutcome,
			controls,
			deposited,
			purchase: world.game.acquisition,
			autoRecovery: autoRecovery.state,
			currentPosition,
		},
		render: world.render,
		start: world.start,
	};
}
