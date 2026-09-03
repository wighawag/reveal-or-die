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
import {resolveWorldConfig, type WorldConfig} from '$lib/world/config';
import {createWorldCommitReveal, type Action} from '$lib/world/commit-reveal';
import {
	createRoundStorage,
	noRoundStorage,
	roundStorageKey,
} from '$lib/world/storage';
import {createPlanning, type PlanningStore} from '$lib/world/planning';
import {createControls, type Controls} from '$lib/world/controls';
import {holdBoardUntilRoundEnds} from '$lib/world/hold';
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
import {
	blocksCommitting,
	createMissedReveal,
	type MissedRevealStore,
} from '$lib/world/missed-reveal';
import {
	createPurchase,
	refreshWhenPendingPurchaseSettles,
	type PurchaseStore,
} from '$lib/world/purchase';
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
	 * What the turn that just resolved DID, while the round is reporting a
	 * reveal.
	 *
	 * Here rather than in the HUD because it REMEMBERS: the round drops the
	 * actions when it flips to `Revealed`, so whatever answers this has to have
	 * been watching, and a store built per component would answer differently
	 * depending on when that component mounted.
	 */
	revealOutcome: Readable<RevealOutcome | undefined>;
	/**
	 * Keys, a gamepad and the on-screen d-pad, translated into game actions.
	 *
	 * Here rather than in `Render` because input is not a rendering concern and
	 * the two have different lifetimes: `docs/audits/03-renderer.md` 4.2 is about
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
	 * the stakes do - an NFT in custody rather than a balance bonded per round -
	 * so there is no amount and no per-round cost here, which is why `reserve`
	 * and `cost` are gone rather than renamed.
	 */
	deposited: DepositedStore;
	/**
	 * Buying an avatar, which mints it straight into the game.
	 *
	 * The remedy for the `deposit` step of the setup gate, and the only thing here
	 * that spends the player's own money rather than the signer's gas.
	 */
	purchase: PurchaseStore;
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
	 * Which part of the round this is: play, the commit lock, the reveal, or the
	 * catch-up while the board fetches what the new round assumes.
	 *
	 * The clock and the move gate both read this, and the HUD words itself from
	 * it. See {@link RoundPhase} for why the old two-phase model was not enough.
	 */
	phase: Readable<RoundPhase>;
	/**
	 * Whether the player can actually take a turn right now: an identity to play
	 * as, permission for this browser to act as it, an avatar to move, and the
	 * round being in the window where moves mean anything.
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

/** What a setup step can be acted on with, where anything can be. */
export type SetupAction = 'authorise' | 'buy';

/**
 * The four parts of a round, as the player experiences them.
 *
 * An epoch is: a window to plan and commit in, a lock while those commits land,
 * the reveal in which every planned move resolves, and - at the boundary - a
 * moment while the board fetches the state the new round assumes. The old
 * two-phase model folded the middle two into one "wait", which is fine to
 * play on and useless to debug against, and had no slot at all for the fourth.
 *
 * `catching-up` lasts until the board's own epoch catches up with the clock's,
 * which is however long the chain takes to mine past the boundary (see
 * `settleBoardWhenRoundStarts` for why the clock is ahead of the chain there),
 * and it disappears the moment a fetch lands the new round's data. The
 * COUNTDOWN during it is the play window it is holding up, so "when can I
 * move" keeps ticking while it lasts.
 */
export type RoundPhase = 'play' | 'commit' | 'reveal' | 'catching-up';

/**
 * Whether a turn can be taken right now.
 *
 * Its own function, like `setupNeeded` beside it, because it is a GATE and the
 * two ways to get a gate wrong are opposites: too strict and a ready player
 * watches the board refuse them for a fifth of every round; too loose and a
 * plan gets built from a position that is about to be invalidated. Neither is
 * visible by reading the wiring.
 */
export function canTakeTurnNow(
	setup: SetupNeeded | undefined,
	phase: RoundPhase,
): boolean {
	return setup === undefined && phase === 'play';
}

/**
 * Which part of the round this is, from the three-phase tracker and whether
 * the board is behind the clock.
 *
 * CATCHING-UP WINS over the phase the clock says, deliberately: if the board
 * is behind, that is the more actionable truth, whether the clock thinks it is
 * the lock, the reveal or the new window.
 *
 * Pure, and exported for the tests, because the HUD and the move gate both
 * read it and neither should re-derive it.
 */
export function roundPhaseOf(
	three: {phase: 'play' | 'commit' | 'reveal'},
	boardBehindClock: boolean,
): RoundPhase {
	if (boardBehindClock) return 'catching-up';
	if (three.phase === 'reveal') return 'reveal';
	if (three.phase === 'commit') return 'commit';
	return 'play';
}

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
 * Refresh the board more often while reveals are landing on it.
 *
 * Standing avatars change at EXACTLY ONE MOMENT in an epoch: during the reveal
 * phase, as each player's commitment resolves. The poller behind the board runs
 * on a fixed interval (5s) that is right for the commit phase - when nothing on
 * the board can change, and it is only catching pans and account switches - and
 * slow for the reveal one. A browser that does not itself hold the round (a
 * second player watching, or the same player in another window) is told about a
 * move up to a full interval after it happens, which reads as the board ignoring
 * the reveal until the next epoch has already started.
 *
 * So while the phase is `wait` - the reveal window plus the lock before it - an
 * explicit `update()` is issued on a short cadence. That is the seam's own
 * "the game knows something changed" call, the same one the round's
 * `onSettled` uses after a local reveal; a timer is just that request repeated,
 * because another player's reveal is invisible from here by design.
 *
 * THE FAST CADENCE OUTLIVES THE WINDOW BY A GRACE PERIOD, because late
 * landings cluster at the boundary: a reveal whose transaction was still in
 * flight when the clock crossed, a node whose block timestamps trail the wall
 * clock the client interpolates from. Observed once as the other player's
 * avatar standing still for a few seconds INTO the play phase, which is the
 * 5s poll's worst case showing through. Anything later than the grace is
 * genuinely rare on a quiet board, and the poller owns it.
 *
 * Its own function, taking only the two stores it reads, for the same reason
 * `resumeWhenGasArrives` is: it is wiring that acts unprompted, it deserves
 * tests, and a test should not need an app context for it.
 */
export function refreshDuringReveal(params: {
	phase: Readable<{phase: 'play' | 'wait'}>;
	refresh: () => Promise<unknown> | unknown;
	/** How often to refresh while reveals are landing. Defaults to 1.5s. */
	intervalMs?: number;
	/**
	 * How long to keep the fast cadence after the window closes. Defaults to
	 * 4s. Set it to 0 for the strict "only while waiting" behaviour.
	 */
	graceMs?: number;
}): () => void {
	const {phase, refresh} = params;
	const intervalMs = params.intervalMs ?? 1500;
	const graceMs = params.graceMs ?? 4000;

	let timer: ReturnType<typeof setInterval> | undefined;
	function stop() {
		if (timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	}

	/**
	 * When the wait last ended, so the grace can be measured from it. Starts at
	 * minus infinity, so a page OPENED mid-play - which owes no catch-up - is
	 * already past any grace.
	 */
	let waitEnded: number | undefined = -Infinity;

	/**
	 * The interval checks the grace ITSELF rather than waiting for the phase to
	 * re-emit: `twoPhase` ticks every second, but correctness that depends on a
	 * store keeping emitting is correctness borrowed, not owned.
	 */
	function tick() {
		// `undefined` is "the window is still open", which is not a grace to
		// spend: the subtraction below would be NaN, so it is asked first.
		if (waitEnded !== undefined && Date.now() - waitEnded >= graceMs) {
			stop();
			return;
		}
		void refresh();
	}

	const unsubscribe = phase.subscribe(($phase) => {
		if ($phase.phase === 'wait') {
			waitEnded = undefined;
			stop();
			timer = setInterval(tick, intervalMs);
			return;
		}
		// OFF once the window has been closed for longer than the grace: nothing
		// on the board can change in the commit phase, so the poller's own
		// interval is doing all the work there is to do, and a second cadence
		// would just be a second bill from the RPC.
		if (waitEnded === undefined) waitEnded = Date.now();
		if (timer === undefined && Date.now() - waitEnded < graceMs) {
			timer = setInterval(tick, intervalMs);
		}
	});

	return () => {
		stop();
		unsubscribe();
	};
}

/**
 * Run something once per round, on the turnover.
 *
 * `epochInfo` re-emits on every tick of the clock, so the trigger is the
 * CHANGE and not the value; without that, anything hung off it runs once a
 * second forever. The first emission is deliberately not a change either:
 * `start()` has just done the initial reads, and treating "the epoch became
 * known" as a turnover would double every one of them on load.
 *
 * Its own function, like the two below, because it is wiring that acts
 * unprompted - it spends RPC calls with nobody asking - and a test of it
 * should not need an app context.
 */
export function onEachNewRound(params: {
	epochInfo: Readable<{currentEpoch: number}>;
	run: () => void;
}): () => void {
	const {epochInfo, run} = params;
	let lastEpoch: number | undefined;
	return epochInfo.subscribe(($epoch) => {
		if (lastEpoch !== undefined && $epoch.currentEpoch !== lastEpoch) run();
		lastEpoch = $epoch.currentEpoch;
	});
}

/**
 * Bring the board up to date when a new round begins, and say so while it does.
 *
 * THE MOMENT IS THE COMMIT PHASE STARTING. Every reveal that will ever land has
 * landed by then, so one fetch captures the settled board - and one fetch at
 * that point is what a second browser is owed, because it has nothing of its
 * own to tell it an epoch ended: the round, the secrets and the reveal all
 * belong to whichever window holds them.
 *
 * THE FETCH MUST RETRY RATHER THAN GIVE UP, which is the actual bug being fixed.
 * The client's clock interpolates from the wall clock between blocks, so it
 * crosses the epoch boundary before the chain has necessarily mined a block
 * past it. The poller asks for the new epoch, the contract answers with the old
 * one (it computes epochs from the latest block's timestamp), the read reports
 * "not yet" - and the poller's own catchup budget expires and turns into
 * exponential backoff. The board then shows last epoch's positions for as long
 * as it takes for someone's first move to mine the block that unblocks the
 * fetch: the new round visibly underway while the board denies anything
 * happened. bomber-world never hits this because its equivalent retries every
 * 200ms UNTIL IT SUCCEEDS; this retries at a short cadence until the board's
 * own epoch catches up with the clock's, then stops.
 *
 * ONE ATTEMPT PER EPOCH. If the chain is so far behind that the budget expires,
 * the settle gives up and the background poller keeps trying. Nothing promises
 * a catch-up that is not happening: the four-phase model reads the GAP ITSELF
 * (`boardBehindClock` below) rather than this loop's activity, so the phase
 * stays honest whether the settle is running, finished or gave up.
 *
 * `watch()` rather than a subscription at construction, because subscribing to
 * the phase here would start the chain clock at construction time and ADR-0002
 * forbids IO before `start()`.
 */
export function settleBoardWhenRoundStarts(params: {
	phase: Readable<{phase: 'play' | 'wait'}>;
	/** The clock's epoch: which round the client believes is current. */
	epoch: Readable<number>;
	/** The board's own state, whose `epoch` says which round it has reached. */
	state: Readable<{step: 'Unloaded'} | {step: 'Loaded'; epoch: number}>;
	refresh: () => Promise<unknown> | unknown;
	/** How often to retry while the chain is behind the clock. Default 400ms. */
	retryMs?: number;
	/** How long to keep trying before leaving it to the poller. Default 10s. */
	budgetMs?: number;
}): {
	/** Open the phase subscription. Call from `start()`; returns the teardown. */
	watch(): () => void;
} {
	const {phase, epoch, state, refresh} = params;
	const retryMs = params.retryMs ?? 400;
	const budgetMs = params.budgetMs ?? 10_000;

	let running = false;

	async function settle() {
		running = true;
		try {
			const deadline = Date.now() + budgetMs;
			for (;;) {
				// The budget is checked BEFORE the fetch, not after: a retry that
				// is already past it is a call to the RPC that cannot be used.
				if (Date.now() >= deadline) break;
				await refresh();
				const $state = get(state);
				// `refresh` resolves when the fetch it triggered has landed, so a
				// state that is still not Loaded afterwards means the gate is
				// closed or the read failed: retrying cannot help this epoch, and
				// the poller owns the recovery.
				if ($state.step !== 'Loaded') break;
				if ($state.epoch >= get(epoch)) break;
				await new Promise((resolve) => setTimeout(resolve, retryMs));
			}
		} finally {
			running = false;
		}
	}

	// STARTED AS PLAY, so a page opened mid-commit-phase gets no settle: the
	// poller is already fetching for the first time, and the transition this
	// waits for is the one into the NEXT round. `twoPhase` re-emits on every
	// clock tick, so the trigger has to be the transition and not the value.
	let wasPlay = true;
	function watch(): () => void {
		const unsubscribe = phase.subscribe(($phase) => {
			const play = $phase.phase === 'play';
			const starting = play && !wasPlay;
			wasPlay = play;
			// Only the TRANSITION: `twoPhase` re-emits on every clock tick, and a
			// settle per tick would be a fetch per tick.
			if (!starting) return;
			if (!running) void settle();
		});
		return () => {
			unsubscribe();
		};
	}

	return {watch};
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
		// A turn's worth of travel beyond the camera, because the same zones scope
		// the reveal logs and an avatar's log is filed under the zone it ended in.
		zonesForCamera: createZonesForCamera({reach: config.numMoves}),
		read: createWorldReader({publicClient: core.publicClient, deployments}),
		emptyState: emptyWorld,
		fetchGate: core.chainFetchGate,
	});

	/**
	 * The settle that runs when a round begins. Constructed here - which is
	 * inert, since `watch()` is what opens the subscription, and opening it
	 * here would start the chain clock at construction time against ADR-0002 -
	 * and `start()` is what watches.
	 *
	 * What the player SEES is not this loop but the four-phase model: the
	 * catch-up is a phase on the clock, read off the gap itself, so it stays
	 * honest whether this settle is running, finished or gave up.
	 */
	const settle = settleBoardWhenRoundStarts({
		phase: twoPhase,
		epoch: currentEpoch,
		// One cast, at the one place the mismatch is: the store's value is the
		// full `OnchainStateValue<WorldState>`, and svelte's store typing is
		// contravariant in the subscriber, so a store of a WIDER value does not
		// satisfy `Readable` of the narrower one even though every value it emits
		// has the `epoch` this reads. The Loaded branch always carries it.
		state: onchainState as unknown as Readable<
			{step: 'Unloaded'} | {step: 'Loaded'; epoch: number}
		>,
		refresh: () => onchainState.update(),
	});

	/**
	 * Whether the board is behind the clock, which is the fourth phase.
	 *
	 * THE STATE'S EPOCH IS THE FETCH'S REQUEST, so this reads "no fetch has
	 * landed since the round changed" - which ends within one fetch, because
	 * nothing the board reads can change between the clock crossing the
	 * boundary and the chain mining past it (a reveal mined after the boundary
	 * is refused with `InCommitmentPhase`, and commits move no avatar). The
	 * first version of this compared against the CHAIN's epoch instead, which
	 * made the catch-up last until the next block was mined - on a node that
	 * mines only on transactions, the next commit, some twenty seconds in - all
	 * of it a wait for a counter while the data had already arrived.
	 *
	 * NOT THE SETTLE'S TIMER, for the same reason as before: a settle can still
	 * be running once a fetch has landed, and the board can be unfetched without
	 * any settle having been triggered. What the player experiences is the gap,
	 * so the gap is what this reads.
	 *
	 * NOT LOADED IS NOT BEHIND. An unloaded board is the setup gate's business
	 * (no wallet, no fetch), not a catch-up.
	 */
	const boardBehindClock = derived(
		[currentEpoch, onchainState],
		([$epoch, $state]) =>
			($state as {step?: string; epoch?: number}).step === 'Loaded' &&
			($state as {epoch?: number}).epoch !== undefined &&
			($state as {epoch?: number}).epoch! < $epoch,
	);

	/** The four-phase model the HUD and the move gate read. See {@link RoundPhase}. */
	const phase = derived([threePhase, boardBehindClock], ([$three, $behind]) =>
		roundPhaseOf($three, $behind),
	);

	const deposited = createDeposited({deps: core, owner: gameIdentity});

	const purchase = createPurchase({
		deps: core,
		config,
		owner: gameIdentity,
		// The same grant the top-up flow shows, from the one place this app
		// declares it, so the two cannot describe two different keys.
		grant: SIGNER_GRANT,
		// The avatar is in the contract's custody the moment the purchase lands, so
		// re-reading is what takes the player past the setup gate and onto the board.
		onPurchased: () => void deposited.update(),
	});

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
		/**
		 * KEEP THE LOOP TURNING EVEN WITH NOTHING PLANNED.
		 *
		 * `_getResolvedAvatar` says it in as many words: "we force character to
		 * continuously commit+reveal". With `numMissesAllowed = 3`, an avatar whose
		 * `lastEpoch` falls more than four epochs behind is set to `life = 0`.
		 * `lastEpoch` only advances on a REVEAL, so a player who watches a few
		 * rounds without moving loses the avatar they paid for, having done nothing
		 * wrong and been warned by nothing.
		 *
		 * Only while the avatar has something to LOSE by going quiet, which is
		 * `isAtRisk` and not "is it standing somewhere". One waiting to enter has no
		 * clock running against it (`_getResolvedAvatar` forces `life = 1` for an
		 * avatar that is not `inGame`), and one that is already DEAD has nothing
		 * left to protect: it keeps a position, so a check on that alone kept the
		 * loop running for a corpse, and `_makeCommitment` reverts with
		 * `AvatarIsDead` - a transaction the signer pays for and the contract
		 * refuses, once a round, for as long as the tab is open.
		 */
		commitWhenIdle: () => isAtRisk(get(deposited), get(activeAvatarID)),
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

	/**
	 * THE HELD BOARD, not the poller's raw answer.
	 *
	 * Reveals arrive one transaction at a time and in whatever order the mempool
	 * delivers them, so a board that draws each as it lands shows a simultaneous
	 * round playing out in payment order. What is held back is only what the
	 * RESOLVING round changed, and only until it is over; see `$lib/world/hold`.
	 * Everything about FETCHING - the settle, the catching-up phase, the RPC
	 * health - keeps reading the raw store, because those are about what the
	 * chain says and this is about what the player is shown.
	 */
	const heldBoard = holdBoardUntilRoundEnds({
		state: onchainState,
		phase: twoPhase,
		epoch: currentEpoch,
	});

	const viewState = createViewState({
		onchainState: heldBoard.board,
		/**
		 * THE DISPLAY COPY of the plan, not the round's live one.
		 *
		 * The two halves of a turn - the local overlay before it resolves, the
		 * board's account of it after - have to hand over with nothing in
		 * between, and the round drops its actions the moment it reaches
		 * `Revealed`, seconds before the board releases what they did. See
		 * `$lib/world/display-plan`. It is released by the board's OWN signal, so
		 * the two cannot disagree about when the round ended.
		 *
		 * ONLY WHAT IS DRAWN. `planning.plan` itself is untouched, and everything
		 * that acts on a turn keeps reading it and the round: a held display copy
		 * must not make the HUD offer an Undo for a turn that is already on chain.
		 */
		localState: holdPlanUntilBoardReleases({
			round,
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
	 * the turn did where the round's own memory only knows what was revealed.
	 * Undefined whenever the avatar is not in the fetched zones - out of the
	 * world, or panned away from - which is why it is a fallback and not the
	 * only input.
	 */
	const myAvatarOnBoard = derived(
		[viewState, activeAvatarID],
		([$view, $avatarID]) =>
			$view.step === 'Loaded' && $avatarID !== undefined
				? $view.avatars.get($avatarID)
				: undefined,
	);

	const revealOutcome = createRevealOutcome(round, myAvatarOnBoard);

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

	/**
	 * Whether the player can actually take a turn right now.
	 *
	 * Three things used to stand between a player and their first move - an
	 * identity, permission for this browser, an avatar the contract is holding -
	 * and a fourth is added here: THE PLAY WINDOW. Nothing can be planned
	 * outside it, because everything the plan would be built from is stale
	 * there. During the reveal the avatar's next position is exactly the thing
	 * being decided; during the catch-up the board has not caught up with the
	 * round that just resolved. Planning from either is planning from a guess,
	 * and a plan the contract then refuses costs the turn to `stopProcessing`
	 * silently.
	 *
	 * Letting someone plan a turn they cannot commit is worse than not letting
	 * them start, and this is the same principle one epoch in: the moves look
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
		round,
		missedReveal,
		readyToPlay,
	});

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

		// THE BOARD REFRESHES WHEN IT CAN CHANGE, and only then. During the reveal
		// window that is every second and a half, because another player's move
		// is invisible from here; at the commit phase's start it is a settle that
		// retries until the board has actually caught up, because the client's
		// clock crosses the epoch boundary ahead of the chain and a fetch that
		// gives up into backoff leaves the new round playing on last epoch's
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
		const unsubscribePurchase = refreshWhenPendingPurchaseSettles({
			purchase,
			onSettled: () => void deposited.update(),
		});

		// Ask the chain about this ACCOUNT again whenever the round turns over.
		//
		// Both of these are questions about the CURRENT EPOCH rather than fixed
		// properties, which is what makes a per-round re-read the right cadence
		// rather than a poll bolted on.
		//
		// Whether a commitment counts as MISSED changes by itself: the very same
		// commitment is live in the epoch it was made and blocking in the next one.
		// Checking only on load and on account change means a tab that was open
		// across the boundary answers "nothing is wrong" once and never revisits
		// it, leaving the player silently blocked with no idea why committing does
		// nothing.
		//
		// And so does whether an avatar is still ALIVE. `_getResolvedAvatar`
		// computes `life` from how far `lastEpoch` has fallen behind the epoch
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
		const unsubscribeEpoch = onEachNewRound({
			epochInfo,
			run: () => {
				void missedReveal.check();
				void deposited.update();
			},
		});

		return () => {
			stopRound();
			eventEmitter.off('clicked', onClicked);
			unsubscribeAccount();
			unsubscribeAvatar();
			unsubscribeRound();
			unsubscribeEpoch();
			unsubscribeGas();
			unsubscribePurchase();
			stopSettleWatch();
			stopRevealRefresh();
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
			revealOutcome,
			controls,
			deposited,
			purchase,
			missedReveal,
			currentPosition,
			phase,
			readyToPlay,
			setup,
		},
		render: {camera, cameraControl, gameRenderer, eventEmitter},
		start,
	};
}
