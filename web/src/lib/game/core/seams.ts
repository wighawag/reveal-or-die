/**
 * The seams a game fills in.
 *
 * This file is the contract between the commit-reveal framework and the game
 * built on it. Everything here is a type: no implementation, no imports from
 * any particular game. If you are writing a game on this template, these are
 * the things you supply; everything else the framework provides.
 *
 * The shapes were derived from four games that already exist, so they are
 * descriptive rather than speculative:
 *
 * - reveal-or-die and bomber-world identify a player by an ERC721 token id
 * - conquest identifies a player by an owner-derived empire id
 * - stratagems identifies a player by their account address, and builds its
 *   state by replaying events through an indexer rather than reading contracts
 *
 * Anything those four disagree about is a seam. Anything they agree about
 * (notably the epoch maths) belongs to the framework.
 */
import type {Readable} from 'svelte/store';

// ----------------------------------------------------------------------------
// Player identity
// ----------------------------------------------------------------------------

/**
 * What identifies a player to the game contract.
 *
 * Deliberately open: a game picks its own. An ERC721 token id and an
 * owner-derived id are both `bigint`; an account-keyed game uses the address
 * itself. The framework never inspects this, it only carries it from the
 * player's local state to the contract calls the game supplies.
 */
export type PlayerIdentity = bigint | `0x${string}`;

// ----------------------------------------------------------------------------
// Onchain state
// ----------------------------------------------------------------------------

/** Not-yet-loaded, or loaded with the game's own state shape. */
export type OnchainStateValue<TState> =
	{step: 'Unloaded'} | ({step: 'Loaded'} & TState);

/**
 * How current the state is, and why it might not be.
 *
 * `loading` covers both a poller's in-flight fetch and an indexer's catch-up,
 * so a UI can show one spinner either way. An error is kept while retrying so
 * consumers do not flicker between error and loading.
 */
export type OnchainStateStatus = {
	loading: boolean;
	error?: {message: string; cause?: unknown};
	/** Timestamp (ms) of the last time the state was known current. */
	lastSuccessfulFetch?: number;
};

/**
 * The state seam.
 *
 * Deliberately small, because the two ways of producing it have almost nothing
 * else in common:
 *
 * - reading contracts on an interval, scoped to what the camera can see
 * - replaying events through a client-side indexer, driven by new blocks
 *
 * Both end at "a store of game state that can be asked to become current", so
 * that is all this promises. A game supplies one; the framework, the view layer
 * and the RPC-health banner only ever see this.
 */
export type OnchainStateStore<TState> = {
	subscribe: Readable<OnchainStateValue<TState>>['subscribe'];
	status: Readable<OnchainStateStatus>;
	/** Bring the state up to date now; resolves once it is. */
	update(): Promise<void>;
};

// ----------------------------------------------------------------------------
// View state
// ----------------------------------------------------------------------------

/**
 * What the renderer draws: onchain state with the player's local, not-yet-onchain
 * intent layered on top. Games define the entity shape; the framework only needs
 * to know which epoch the view belongs to, so it can tell stale from current.
 */
export type ViewStateValue<TView> =
	{step: 'Unloaded'} | ({step: 'Loaded'; epoch: number} & TView);

export type ViewStateStore<TView> = {
	subscribe: Readable<ViewStateValue<TView>>['subscribe'];
	status: Readable<OnchainStateStatus>;
};

// ----------------------------------------------------------------------------
// Commit / reveal
// ----------------------------------------------------------------------------

/**
 * The two contract calls that make a commit-reveal round, as the game exposes
 * them.
 *
 * The framework owns the ROUND: it decides when committing is still allowed,
 * keeps the secret until the reveal phase, and drives the reveal. It does not
 * know the contract's function names or argument order, because those differ
 * per game (some commit as msg.sender and take a player argument only on
 * reveal, so that a third party can reveal on the player's behalf).
 */
export type CommitRevealAdapter<TIdentity extends PlayerIdentity, TAction> = {
	/**
	 * Pack the player's actions into the bytes the contract will hash, and the
	 * commitment hash itself. Kept together because a game's hash must match its
	 * own packing exactly.
	 */
	buildCommitment(params: {
		actions: readonly TAction[];
		secret: `0x${string}`;
	}): {hash: `0x${string}`; encoded: `0x${string}`};

	/**
	 * Submit the commitment for this epoch.
	 *
	 * This deliberately receives everything the round knows, not just the hash.
	 * Two reasons, both taken from games that already exist:
	 *
	 * `actions`, because what a game puts at stake AT COMMIT TIME is usually a
	 * function of what was planned: the template bonds the exact cost of its
	 * placements, and a bond that is too small makes the reveal revert once the
	 * commitment is already immovable. It cannot be recovered from the hash,
	 * which is the one thing a commitment hash is for.
	 *
	 * `secret` and `revealDueAt`, because a game may want the reveal to happen
	 * WITHOUT this browser. Stratagems and catacombs hand a timelock-encrypted
	 * reveal transaction to a scheduling service (fuzd, encrypted to a drand
	 * round) at commit time, so that a player who closes the tab still reveals
	 * and keeps their stake. Both run a 23h/1h commit/reveal split, where nobody
	 * can be expected at the keyboard for the reveal hour. Building that payload
	 * needs the secret and the time the reveal falls due, and commit is the only
	 * moment it can be done.
	 *
	 * Scheduling is an ADDITION, never a replacement: the player can always
	 * reveal themselves, and a game with a short round (or a hot-seat setup where
	 * turns are simply waited out) needs no scheduler at all. See `autoReveal` on
	 * the round for how the two combine.
	 *
	 * Handing over the secret is not a leak: this runs in the player's own
	 * client, and the adapter is the code that will disclose it a phase later
	 * regardless.
	 */
	commit(params: {
		identity: TIdentity;
		hash: `0x${string}`;
		actions: readonly TAction[];
		secret: `0x${string}`;
		epoch: number;
		/**
		 * Chain time, in seconds, at which the reveal phase for this epoch opens.
		 * Undefined on a manually advanced chain, which has no clock to predict.
		 */
		revealDueAt?: number;
	}): Promise<{hash: `0x${string}`}>;

	/** Submit the matching reveal. */
	reveal(params: {
		identity: TIdentity;
		actions: readonly TAction[];
		secret: `0x${string}`;
	}): Promise<{hash: `0x${string}`}>;
};

// ----------------------------------------------------------------------------
// Rendering
// ----------------------------------------------------------------------------

/**
 * The render seam.
 *
 * Not tied to a rendering library: the pixi games and the WebGL one both fit,
 * because all the framework does is start it, stop it, and let it tick. What a
 * "surface" is (a pixi Container, a WebGL context) is the renderer's business,
 * so it is the renderer's own type parameter.
 */
export type GameRenderer<TSurface> = {
	onAppStarted(surface: TSurface): void;
	onAppStopped(): void;
	/** Per-frame hook, for animation that does not come from state changes. */
	tick(): void;
};
