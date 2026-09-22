/**
 * PUSHING THE CYCLE ON, which under two of the three policies is something a
 * TRANSACTION has to do and which nothing in this tree did until now.
 *
 * This is framework, not a seam, and the reason it is framework is the whole
 * point of the file: `grep -rn advanceCycle web/src` used to find the ABI and
 * no caller, so a MANUAL deployment could not complete a round - on a chain in
 * the tab, on a local node, or on an ordinary remote chain. The round is
 * commit, advance, reveal, advance, and a reveal sent before the advance is
 * refused with `InCommitmentPhase`. The embedded world is only where that gap
 * was first walked into.
 *
 * ADVANCING IS ITS OWN TRANSACTION AND NEVER A RIDER ON THE LAST REVEAL (C5 in
 * the plan on the `work` branch, and the same three reasons are written at
 * `UsingGameInternal._advanceCycle`). It is PERMISSIONLESS AND STRICTLY
 * CONDITIONAL: anyone may call it, and it may only ever do what the rules
 * already permit, so it is nobody's move. That is why this file sends it from
 * the same key that sends the player's moves and never asks them about it - it
 * spends gas on the player's behalf to keep the cycle turning, and it can never
 * spend the STAKE. (The rule it is on the right side of:
 * `acknowledgeMissedReveal` forfeits a bond and is therefore the player's to
 * press; an advance takes nothing from anyone.)
 *
 * THE CONDITIONS ARE MIRRORED HERE AND THE CONTRACT IS STILL THE JUDGE.
 * {@link advancePermitted} is a copy of the contract's own guards, and copies
 * drift. What makes this one safe is what it is FOR: it exists so the client
 * does not broadcast a transaction every second that it already knows will
 * revert. Being wrong in the strict direction costs one reverted transaction;
 * being wrong in the lax direction costs nothing at all, because the contract
 * refuses. No stake is ever on this prediction, which is the property that
 * makes a mirrored guard acceptable here and would not make it acceptable in
 * the reveal path.
 */
import {writable, type Readable} from 'svelte/store';
import type {CycleInfoStore, CyclePolicy} from './cycle';

/**
 * WHO THE CYCLE IS WAITING FOR, and how many of them have acted.
 *
 * The client's half of the contract's `Attendance`. `waitedFor` is the
 * denominator unanimity is measured against and is deliberately NOT "how many
 * players exist": a game may keep a silent player in the world while no longer
 * blocking on them.
 */
export type Attendance = {
	waitedFor: number;
	/** How many waited-for members have committed IN THE CURRENT CYCLE. */
	committed: number;
	/** How many of those commitments have been opened. */
	revealed: number;
};

/** Why an advance would be refused, in the contract's own terms. */
export type AdvanceRefusal =
	/** `Timed`: the cycle simply IS what the clock says. `NextPhaseNotAllowed`. */
	| 'the-clock-decides'
	/** No closed set, so no denominator. `NoOneToWaitFor`. */
	| 'nobody-is-waited-for'
	/** `StillWaitingToCommit`. */
	| 'still-waiting-to-commit'
	/** `StillWaitingToReveal`. */
	| 'still-waiting-to-reveal';

export type AdvanceVerdict =
	| {permitted: true; opens: 'the-reveal-phase' | 'the-next-cycle'}
	| {permitted: false; because: AdvanceRefusal};

/**
 * Would the contract accept an advance right now?
 *
 * A PREDICTION AND NOT AN AUTHORITY - see the file comment for why a mirrored
 * guard is admissible here. It answers in the same order the contract checks,
 * so a disagreement is one line to find rather than a whole path to re-derive.
 *
 * UNANIMITY, NEVER A MAJORITY: `committed < waitedFor` refuses. A subset that
 * could close a phase would time slow players out and turn the cycle into a
 * race, which is the order-independence failure one level up - whoever is
 * quickest would decide the outcome and committing would have bought nothing.
 */
export function advancePermitted(params: {
	policy: CyclePolicy;
	isCommitPhase: boolean;
	attendance: Attendance;
}): AdvanceVerdict {
	const {policy, isCommitPhase, attendance} = params;

	if (policy === 'timed') {
		return {permitted: false, because: 'the-clock-decides'};
	}
	if (attendance.waitedFor === 0) {
		// Without this one caller could push an empty game forward as fast as
		// they liked, which is the contract's reason and is equally this one's.
		return {permitted: false, because: 'nobody-is-waited-for'};
	}
	if (isCommitPhase) {
		return attendance.committed < attendance.waitedFor
			? {permitted: false, because: 'still-waiting-to-commit'}
			: {permitted: true, opens: 'the-reveal-phase'};
	}
	// Everything committed in this cycle has to have been opened. The contract
	// evaluates this at execution time, which is what makes it airtight there: a
	// reveal still in the mempool has not been counted, so an advance mined
	// before it REVERTS rather than stranding it. Here the same comparison is
	// made against a reading that may already be out of date, and that is the
	// benign direction - the worst case is a reverted transaction.
	return attendance.revealed < attendance.committed
		? {permitted: false, because: 'still-waiting-to-reveal'}
		: {permitted: true, opens: 'the-next-cycle'};
}

/**
 * WHEN THIS BROWSER PUSHES THE CYCLE, which is not the same question as whether
 * it may.
 *
 * - `when-nothing-else-will` (the default) pushes only under a policy with NO
 *   CLOCK. Under `manual` the cycle moves for no other reason, so a client that
 *   does not push leaves the game frozen with no error anywhere; under `timed`
 *   and `hybrid` the clock moves it on its own, so pushing spends the player's
 *   gas to buy a few seconds nobody asked for.
 * - `eagerly` also brings a `hybrid` cycle forward the moment unanimity permits
 *   it. That is the mode a short-cycle game on the hybrid policy wants, and it
 *   is opt-in because it is a spending decision rather than a correctness one.
 * - `never` leaves it entirely to {@link CycleAdvanceStore.advance} and to
 *   whoever else is playing.
 *
 * Note what none of these is: a choice about whether the advance is ALLOWED.
 * Anyone may call it in any of them, and a game where every client sets `never`
 * simply waits for somebody to press a button.
 */
export type AutoAdvance = 'when-nothing-else-will' | 'eagerly' | 'never';

export type CycleAdvanceState =
	/** Nothing to push, or nothing has been read yet. */
	| {step: 'Idle'}
	| {
			step: 'Advancing';
			cycleNumber: number;
			opens: 'the-reveal-phase' | 'the-next-cycle';
	  }
	/**
	 * An advance was sent and did not land.
	 *
	 * USUALLY BENIGN, and worth saying so wherever this is shown: the commonest
	 * cause is that somebody else advanced first, or that a reveal was still in
	 * the mempool when this one was mined. Both are the contract refusing to do
	 * something that is no longer true, and the next reading will say so.
	 */
	| {step: 'Failed'; cycleNumber: number; message: string; error: unknown};

export type CycleAdvanceStore = Readable<CycleAdvanceState> & {
	readonly value: CycleAdvanceState;
	/**
	 * Read the attendance and push if the rules already permit it.
	 *
	 * Called on a timer by {@link CycleAdvanceStore.start}, and worth calling
	 * directly at the moment this browser's own action may have completed
	 * unanimity - a commit that lands is exactly when the reveal phase becomes
	 * pushable, and waiting a whole poll interval to notice is the difference
	 * between a round that feels instant and one that does not.
	 */
	check(): Promise<void>;
	/**
	 * Push now, without asking whether it is permitted.
	 *
	 * For a button. The local reading is only a prediction, so a hand press lets
	 * the CONTRACT answer rather than this file's copy of its rules.
	 */
	advance(): Promise<void>;
	/** Begin watching. Returns the teardown. */
	start(): () => void;
};

/** The default retry floor and ceiling, in milliseconds. See below. */
const RETRY_BASE_MS = 2000;
const RETRY_CAP_MS = 30000;

export function createCycleAdvance(params: {
	cycleInfo: CycleInfoStore;
	/** Reads `getAttendance` off the game contract. */
	readAttendance: () => Promise<Attendance>;
	/** Sends the game's `advanceCycle`, and resolves once it has been mined. */
	advance: () => Promise<unknown>;
	/**
	 * Re-read the cycle from the chain, if this policy has anything to re-read.
	 *
	 * Called after every ATTEMPT, successful or not, and both halves are the
	 * reason. After a success the phase has moved and nothing else would notice
	 * until the next poll; after a failure the likeliest explanation is that this
	 * browser's picture of the phase was already stale, which is exactly when
	 * asking again is worth a round trip.
	 */
	refreshCycle?: () => Promise<void>;
	auto?: AutoAdvance;
	/** How often to look. Defaults to one second. */
	pollInterval?: number;
	/** Injectable clock, for the tests of the backoff below. */
	now?: () => number;
}): CycleAdvanceStore {
	const {cycleInfo, readAttendance} = params;
	const auto = params.auto ?? 'when-nothing-else-will';
	const pollInterval = params.pollInterval ?? 1000;
	const now = params.now ?? (() => Date.now());

	let $state: CycleAdvanceState = {step: 'Idle'};
	const store = writable<CycleAdvanceState>($state);

	function set(next: CycleAdvanceState) {
		$state = next;
		store.set(next);
	}

	let inFlight = false;

	/**
	 * BACKOFF THAT RESETS ON NEW INFORMATION, which is the shape this needs
	 * rather than a retry count.
	 *
	 * A failing advance must not be retried every second forever: each attempt
	 * spends gas, and the one failure that is NOT benign (a signer with nothing
	 * in it, a node refusing the send) would otherwise drain the key that plays.
	 * But a failure must not be sticky either: under `manual` nothing else moves
	 * the cycle, so a client that gave up permanently would leave the game frozen
	 * for everyone.
	 *
	 * So attempts back off exponentially while the situation is UNCHANGED, and
	 * the backoff resets the moment the chain says something new - a different
	 * phase, a different cycle, or a different tally. That is the honest reading
	 * of "is there any reason to think this will go differently now".
	 */
	let situation: string | undefined;
	let failures = 0;
	let retryAfter = 0;

	function situationOf(
		cycleNumber: number,
		isCommitPhase: boolean,
		attendance: Attendance,
	): string {
		return [
			cycleNumber,
			isCommitPhase ? 'commit' : 'reveal',
			attendance.waitedFor,
			attendance.committed,
			attendance.revealed,
		].join(':');
	}

	/**
	 * Is this browser one of the clients that should be pushing at all?
	 *
	 * Asked once per check rather than once at startup, so that it stays a
	 * statement about the DEPLOYMENT's policy: the policy is fixed for the life
	 * of a deployment, and reading it from the cycle rather than from a captured
	 * flag means there is no second copy to keep in step.
	 */
	function pushes(policy: CyclePolicy): boolean {
		if (auto === 'never') return false;
		// The contract refuses outright, so a poll here would be an RPC call per
		// second on every ordinary deployment in exchange for nothing. This is the
		// branch that keeps a timed game's traffic exactly what it was.
		if (policy === 'timed') return false;
		if (policy === 'manual') return true;
		return auto === 'eagerly';
	}

	async function push(
		cycleNumber: number,
		opens: 'the-reveal-phase' | 'the-next-cycle',
	): Promise<void> {
		inFlight = true;
		set({step: 'Advancing', cycleNumber, opens});
		try {
			await params.advance();
			failures = 0;
			retryAfter = 0;
			set({step: 'Idle'});
		} catch (error) {
			failures += 1;
			retryAfter =
				now() +
				Math.min(RETRY_CAP_MS, RETRY_BASE_MS * Math.pow(2, failures - 1));
			set({
				step: 'Failed',
				cycleNumber,
				message: error instanceof Error ? error.message : String(error),
				error,
			});
		} finally {
			inFlight = false;
			// See `refreshCycle`: an attempt is exactly when the local picture of
			// the phase is most likely to have moved on.
			try {
				await params.refreshCycle?.();
			} catch {
				// A failed re-read is not a failed advance, and the poller that
				// owns the cycle will try again on its own interval.
			}
		}
	}

	async function check(): Promise<void> {
		if (inFlight) return;
		const info = cycleInfo.now();
		if (!pushes(info.config.policy)) return;

		let attendance: Attendance;
		try {
			attendance = await readAttendance();
		} catch {
			// A failed read is not evidence that the cycle needs pushing, and it is
			// not evidence that it does not. Nothing changes.
			return;
		}

		const next = situationOf(
			info.currentCycleNumber,
			info.isCommitPhase,
			attendance,
		);
		if (next !== situation) {
			situation = next;
			failures = 0;
			retryAfter = 0;
		}
		if (now() < retryAfter) return;

		const verdict = advancePermitted({
			policy: info.config.policy,
			isCommitPhase: info.isCommitPhase,
			attendance,
		});
		if (!verdict.permitted) return;

		await push(info.currentCycleNumber, verdict.opens);
	}

	async function advance(): Promise<void> {
		if (inFlight) return;
		const info = cycleInfo.now();
		await push(
			info.currentCycleNumber,
			info.isCommitPhase ? 'the-reveal-phase' : 'the-next-cycle',
		);
	}

	function start(): () => void {
		// Off-browser (SSR / prerender) nothing polls and nothing sends: a server
		// render must not perform IO or leave a timer behind. See ADR-0002.
		if (typeof window === 'undefined') return () => {};
		if (!pushes(cycleInfo.now().config.policy)) return () => {};

		void check();
		const timer = setInterval(() => void check(), pollInterval);
		return () => clearInterval(timer);
	}

	return {
		get value() {
			return $state;
		},
		subscribe: store.subscribe,
		check,
		advance,
		start,
	};
}
