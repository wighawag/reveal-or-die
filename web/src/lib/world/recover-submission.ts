/**
 * Recovering a turn this browser forgot, by SEARCHING for it.
 *
 * The framework does the judging (`game/core/recovery.ts`): it is handed a
 * candidate turn, recomputes the secret, hashes it and adopts the submission if
 * hash is the one the chain is holding. What it deliberately does not have is
 * an opinion about where a candidate comes from, because only a game knows
 * whether its turns can be enumerated at all.
 *
 * THIS GAME'S CAN, and it is the only one in the tree that can. A turn is a
 * walk of at most `numMoves` orthogonal steps over walkable cells from where
 * the avatar is standing, optionally ending in an Exit if the walk finishes on
 * the exit tile. The maze is what makes that small: most cells have two ways
 * out, so the search is nothing like the four-to-the-tenth the rule allows.
 *
 * MEASURED RATHER THAN ASSUMED, because the plan's estimate was four orders of
 * magnitude out (it said "about 125 candidates", from a three-move turn; the
 * deployments all carry ten). On the generated map, a walk of up to ten steps
 * from a floor cell is **3,000 to 16,000 candidates**, and hashing them costs
 * about **85 microseconds each** - so a recovery is a few tenths of a second to
 * a little over a second, not a minute and not a millisecond.
 *
 * THAT IS WHY THERE IS A BUDGET, and why the budget is here rather than in the
 * framework. Those numbers are this map's, and the rule permits worse: an open
 * chamber with four ways out of every cell is a million candidates and a minute
 * and a half of hashing. A search that cannot finish must stop and say so
 * rather than pin the tab while the reveal window closes, and what it degrades
 * to is the route the reference game uses anyway - ask the player.
 *
 * IT YIELDS, for the same reason. A second of straight-line hashing is a second
 * with no frames, during which nothing on the board moves and no button
 * responds, and this runs at exactly the moment a player is most likely to be
 * doing something about it.
 *
 * THE SECRET IS COMPUTED ONCE, which is not an optimisation. It is derived from
 * a SIGNATURE (`game/core/secret.ts`), so deriving it per candidate would be
 * ten thousand signatures for one turn.
 *
 * WHAT IT CANNOT RECOVER, and it is not a gap to close by searching harder: an
 * ENTRY. An avatar that is not in the world enters at any non-obstacle cell,
 * anywhere, and the map is unbounded - so there is nothing to enumerate over
 * and the fallback is the general route. Stated here because "the action space
 * is small" is true of a turn and false of an entry, and the difference is
 * whether the avatar has a position to start from.
 */
import {
	ActionType,
	bigIntIDToXY,
	isValidMove,
	xyToBigIntID,
	cellTypeAt,
	CellType,
	type Position,
} from 'reveal-or-die-contracts';
import {get, writable, type Readable} from 'svelte/store';
import type {LiveCommitment, RecoveryStore} from '$lib/game/core/recovery';
import type {Action} from './commit-reveal';

/** North, south, east, west. `y` grows DOWNWARDS, as it does on the board. */
const DIRECTIONS: readonly Position[] = [
	{x: 0, y: -1},
	{x: 0, y: 1},
	{x: 1, y: 0},
	{x: -1, y: 0},
];

/**
 * How many candidates to try before giving up.
 *
 * Sized from the measurement above with room to spare: the worst START seen on
 * the generated map is about 16,000, so 60,000 covers a map several times more
 * open than this one while still capping the wait at roughly five seconds. A
 * search that hits it has not failed - it has established that this is not the
 * cheap case, and the player is asked instead.
 */
export const SEARCH_BUDGET = 60_000;

/** How many candidates to hash before letting the browser draw a frame. */
const YIELD_EVERY = 500;

export type SearchOutcome =
	/** Found it. These are the actions that were committed. */
	| {step: 'found'; actions: readonly Action[]}
	/** Every candidate was tried and none matched. */
	| {step: 'exhausted'; tried: number}
	/** The budget ran out first, so the space was bigger than this map's. */
	| {step: 'gave-up'; tried: number}
	/** There is nothing to search: the avatar has no position to walk from. */
	| {step: 'not-searchable'};

/**
 * Every turn the avatar could have committed to, in the order a search should
 * try them.
 *
 * SHORTEST FIRST, which is not arbitrary: a turn of nothing at all is what the
 * client commits by itself to keep an idle avatar alive (`commitWhenIdle`), so
 * it is by far the most likely single candidate and it is the first one tried.
 * After that, short walks before long ones, so the common case of a player who
 * took one or two steps costs a fraction of the budget.
 *
 * A generator, so a caller can stop at the first match without building the
 * whole list: at ten thousand turns of up to ten actions each, materialising
 * them all is megabytes to throw away.
 */
export function* candidateTurns(params: {
	from: Position;
	numMoves: number;
}): Generator<readonly Action[]> {
	const {from, numMoves} = params;

	/** Walks of EXACTLY `length`, depth-first from `from`. */
	function* walksOfLength(
		at: Position,
		soFar: Action[],
		remaining: number,
	): Generator<readonly Action[]> {
		if (remaining === 0) {
			yield [...soFar];
			return;
		}
		for (const d of DIRECTIONS) {
			const to = {x: at.x + d.x, y: at.y + d.y};
			if (!isValidMove(at, to)) continue;
			soFar.push({
				actionType: ActionType.Move,
				data: xyToBigIntID(to.x, to.y),
			});
			yield* walksOfLength(to, soFar, remaining - 1);
			soFar.pop();
		}
	}

	for (let length = 0; length <= numMoves; length++) {
		for (const walk of walksOfLength(from, [], length)) {
			yield walk;

			// AND THE SAME WALK, LEFT FROM. `_exit` refuses unless the avatar is
			// standing on the exit tile when the action resolves, so this is only a
			// candidate where the walk ENDS on one - which is what keeps exits from
			// doubling the search everywhere.
			const end = walk.length === 0 ? from : endOf(walk);
			if (cellTypeAt(end.x, end.y) !== CellType.Exit) continue;
			yield [
				...walk,
				{actionType: ActionType.Exit, data: xyToBigIntID(end.x, end.y)},
			];
		}
	}
}

/**
 * Where a walk ends, decoded with the CONTRACTS package's own function.
 *
 * Not hand-inlined for the hot loop, which was the first version of this and
 * was wrong twice over: it is called once per walk rather than once per hash,
 * so it is not hot, and a second copy of the position encoding is the failure
 * this tree has now paid for twice. The one implementation lives next to the
 * Solidity and is pinned from both sides.
 */
function endOf(walk: readonly Action[]): Position {
	// The data of a Move is where it lands, which is what the contract stores.
	return bigIntIDToXY(walk[walk.length - 1].data);
}

/**
 * Search for the turn behind a commitment hash.
 *
 * Pure apart from the yielding, and the yield is injected so a test can run it
 * to completion synchronously rather than waiting on real timers.
 */
export async function searchForTurn(params: {
	/** Where the avatar stands NOW, which is where the committed turn began. */
	from: Position | undefined;
	numMoves: number;
	/** The commitment the chain is holding. */
	hash: `0x${string}`;
	/** The secret for this cycle, already derived. Computed ONCE by the caller. */
	secret: `0x${string}`;
	buildCommitment: (params: {
		actions: readonly Action[];
		secret: `0x${string}`;
	}) => {hash: `0x${string}`};
	budget?: number;
	/** Called every {@link YIELD_EVERY} candidates. Defaults to a macrotask. */
	yieldToBrowser?: () => Promise<void>;
}): Promise<SearchOutcome> {
	const {from, numMoves, hash, secret, buildCommitment} = params;
	// An avatar out of the world entered somewhere, and "somewhere" is the whole
	// map. See the file comment: not a gap, a different question.
	if (!from) return {step: 'not-searchable'};

	const budget = params.budget ?? SEARCH_BUDGET;
	const breathe =
		params.yieldToBrowser ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
	const target = hash.toLowerCase();

	let tried = 0;
	for (const actions of candidateTurns({from, numMoves})) {
		if (tried >= budget) return {step: 'gave-up', tried};
		tried++;
		if (buildCommitment({actions, secret}).hash.toLowerCase() === target) {
			return {step: 'found', actions};
		}
		if (tried % YIELD_EVERY === 0) await breathe();
	}
	return {step: 'exhausted', tried};
}

/**
 * Where the automatic search has got to, for the UI.
 *
 * It exists so that the player is not asked to re-enter a turn the app is a
 * quarter of a second away from finding on its own. Asking and then answering
 * the question yourself is worse than either.
 */
export type AutoRecoveryState =
	/** Nothing to recover, or the submission already has it. */
	| {step: 'Idle'}
	| {step: 'Searching'; cycleNumber: number}
	/**
	 * The search is over and did not produce the turn, so the general route is
	 * what is left. The reason is carried because the three are worth different
	 * sentences: an ENTRY was never searchable, an exhausted search means the
	 * commitment is not a turn from where this avatar stands, and giving up
	 * means the map was more open than the budget.
	 */
	| {
			step: 'AskThePlayer';
			cycleNumber: number;
			reason: 'not-searchable' | 'exhausted' | 'gave-up';
	  };

/**
 * Run the search whenever the chain turns out to hold a turn this browser lost.
 *
 * Wiring that acts unprompted, so it is a function of its stores with a
 * teardown, the same shape as the board's own refreshers - and testable without
 * an app context, which matters because the thing it must not do is subtle.
 *
 * ONCE PER CYCLE, and that is the whole of the bookkeeping. The recovery state
 * re-emits on every change of the submission and of the chain read, and a search
 * costs a second; without this it would restart continuously and never finish,
 * which is the worst of both outcomes - the tab busy and the turn still lost.
 *
 * IT DOES NOT RETRY A SUBMISSION IT FAILED ON. If the commitment is not a turn
 * where this avatar stands, searching again will not change that, and the
 * player is being shown the question in the meantime.
 */
export function recoverByEnumeration(params: {
	recovery: RecoveryStore<Action>;
	/** Where the avatar stands on chain: where the committed turn began. */
	currentPosition: Readable<Position | undefined>;
	identity: Readable<bigint | undefined>;
	numMoves: number;
	makeSecret: (params: {
		cycleNumber: number;
		identity: bigint;
	}) => `0x${string}` | Promise<`0x${string}`>;
	buildCommitment: (params: {
		actions: readonly Action[];
		secret: `0x${string}`;
	}) => {hash: `0x${string}`};
	/** The commitment being recovered, for its hash. */
	commitment: Readable<LiveCommitment | undefined>;
	/** Injected for tests. */
	run?: typeof searchForTurn;
}): {state: Readable<AutoRecoveryState>; stop: () => void} {
	const {recovery, currentPosition, identity, commitment} = params;
	const run = params.run ?? searchForTurn;

	const state = writable<AutoRecoveryState>({step: 'Idle'});
	/** Cycles already searched, successfully or not. */
	const attempted = new Set<number>();

	const stop = recovery.subscribe(($recovery) => {
		if ($recovery.step === 'Idle') {
			state.set({step: 'Idle'});
			return;
		}
		// `Checking`, `Refused` and `Failed` all mean a candidate is being judged
		// or has just been, which is the player's own attempt. Not ours to
		// interrupt.
		if ($recovery.step !== 'Found') return;
		if (attempted.has($recovery.cycleNumber)) return;

		const live = get(commitment);
		const player = get(identity);
		if (!live || player === undefined) return;
		attempted.add($recovery.cycleNumber);

		const from = get(currentPosition);
		state.set({step: 'Searching', cycleNumber: $recovery.cycleNumber});

		void (async () => {
			try {
				// ONCE. The secret is a signature, so deriving it per candidate would
				// be ten thousand signatures for one turn.
				const secret = await params.makeSecret({
					cycleNumber: live.cycleNumber,
					identity: player,
				});
				const outcome = await run({
					from,
					numMoves: params.numMoves,
					hash: live.hash,
					secret,
					buildCommitment: params.buildCommitment,
				});
				if (outcome.step === 'found') {
					// Back through the framework rather than adopting here, so the one
					// place that checks a candidate against the chain's hash is still
					// the only place that adopts. The search is an oracle, not an
					// authority: a bug in it must not be able to adopt a wrong turn.
					await recovery.offer(outcome.actions);
					state.set({step: 'Idle'});
					return;
				}
				state.set({
					step: 'AskThePlayer',
					cycleNumber: live.cycleNumber,
					reason: outcome.step,
				});
			} catch {
				// Deriving the secret needs the signer. Not a failed search, and the
				// player can still re-enter the turn by hand.
				state.set({
					step: 'AskThePlayer',
					cycleNumber: live.cycleNumber,
					reason: 'not-searchable',
				});
			}
		})();
	});

	return {state: {subscribe: state.subscribe}, stop};
}
