/**
 * THIS GAME'S HALF OF THE CYCLE MOVING: where it is, who it waits for, and
 * pushing it on.
 *
 * The framework owns WHEN an advance is worth sending and what the conditions
 * are (`$lib/game/core/advance`, `$lib/game/core/cycle`); what it cannot own is
 * which contract to ask and which contract to call. So this is the game's half,
 * and it is one file rather than the template's two (`placement/cycle.ts` plus
 * `placement/advance.ts`) because under the only policy that needs either, they
 * are one question: a manual cycle is read and pushed by the same pair of
 * calls, and splitting them here would make two files with one caller between
 * them.
 *
 * NOTHING HERE IS A MOVE. An advance is permissionless: anyone may send it, it
 * is nobody's turn, and it takes nothing from anybody. That is what makes it
 * safe to send from the local signer without asking the player - the framework
 * may spend gas on their behalf to keep the cycle turning, and may never spend
 * the STAKE without being asked, which is what `missed-reveal.ts` is careful
 * about and this file has no equivalent of.
 *
 * ## Three things this game spells differently from the template, and the third
 * ## one matters
 *
 * **1. The cycle read is `getCycleNumber`, not `getCycle`.** Same function, older
 * word, and `AGENTS.md` says to expect exactly that in a game repo: the
 * framework renamed the interval to `cycle`, contracts are not inherited here,
 * and this game has not been ported. It answers under BOTH policies, because
 * `_cycleNumber()` returns the manual cycle when there is no clock - which is why the
 * comment that used to sit in `context/game.ts` saying "there is no `getCycle`
 * to ask" was reading a grep rather than the contract.
 *
 * **2. The advance is `moveToNextPhase`, not `advanceCycle`.** One call covers
 * both of the framework's outcomes: from the commit phase it opens the reveal
 * phase at the same cycle number, and from the reveal phase it opens the next
 * cycle. That is exactly `AdvanceVerdict.opens`, so nothing has to be told
 * which one it is doing.
 *
 * There used to be a second entry point, `moveToNextEpoch`, and it was the
 * trap in this contract's surface: it jumped straight to the next cycle's
 * commit phase, so called during a commit phase it skipped the reveal phase and
 * stranded every commitment made in it. It was removed from the contract
 * (2026-09-26), so one phase at a time is now the only advance there is.
 *
 * **3. THERE IS NO `getAttendance`, AND THERE IS NO MEMBERSHIP SET AT ALL.**
 * This is the one place this game is behind the framework rather than merely
 * spelling it differently, and it changes what the client's guard IS.
 *
 * The framework's `advancePermitted` is documented as a PREDICTION whose only
 * cost when wrong is a reverted transaction, because the contract checks the
 * same conditions and is the judge. Here the contract checks NOTHING:
 * `_moveToNextPhase` refuses only when the policy is not manual, and its own
 * source says the unanimity guard is still missing. So in a manual
 * deployment of THIS game the mirrored guard is not a prediction, it is the
 * only guard there is, and being wrong in the lax direction does not cost a
 * transaction - it opens the reveal phase on somebody who had not committed
 * yet, or closes a cycle on somebody who had not revealed, and in this game the
 * penalty for missing reveals is the avatar.
 *
 * WHAT BOUNDS THAT TODAY is that a manual deployment of this game is an OFFLINE
 * world and nothing else: every deployment on a real chain is timed (see
 * `contracts/rocketh/config.ts`), under which the framework never pushes and
 * `_moveToNextPhase` reverts anyway. So the only caller is the tab that also
 * holds every key at the table. That is a real bound and not a safe one to
 * forget: the moment this game has a manual deployment with a player it does
 * not control, the guard has to move into the contract. See the note of that
 * name on the `work` branch.
 *
 * So `waitedFor` is an ARGUMENT here. Whoever built the world says who is in
 * it; an ordinary deployment says nobody, which the framework reads as
 * `NoOneToWaitFor` and refuses to push - the same answer the contract would
 * have given.
 */
import {get} from 'svelte/store';
import type {Context} from '$lib/context/types';
import type {Attendance} from '$lib/game/core/advance';
import type {CycleReading} from '$lib/game/core/cycle';
import {sendWorldTransaction} from './commit-reveal';

/**
 * What the advance needs.
 *
 * `signerExecutor` for the same reason the commit and the reveal use it: the
 * key that plays sends this, so there is no wallet prompt in the middle of a
 * cycle, and an account with no wallet provider at all can still keep the game
 * moving.
 */
export type AdvanceDeps = Pick<
	Context,
	| 'connection'
	| 'signerExecutor'
	| 'deployments'
	| 'publicClient'
	| 'signerBalance'
>;

/**
 * WHO A WORLD IS WAITING FOR, kept by the client because the chain does not
 * keep it.
 *
 * KEYED BY CHAIN ID, which is how everything else a world owns is keyed here
 * (the operations ledger, this game's submission storage, the deployment
 * records). An app can hold more than one world at a time - the remote chain in
 * the navbar and an in-tab one below it - and a single global would let the
 * embedded world's table answer for the remote one. Under `timed` nothing ever
 * reads this, so that would have been invisible rather than harmless.
 *
 * A MODULE-LEVEL REGISTRY rather than a constructor argument, and that is a
 * consequence of a boundary rather than a preference: `createGameContext` takes
 * only `CoreServices`, and giving it a second parameter means changing
 * `createCoreContext`, which is `lib/core` and therefore jolly-roger's file -
 * a divergence every future cascade would pay for, to carry one value that
 * exactly one caller in this repo ever sets. The lifetime is right either way:
 * a world is app-scoped state, built once, and its membership is fixed at
 * provisioning and cannot change without staking or withdrawing somebody
 * mid-cycle.
 */
const waitedFor = new Map<number, readonly bigint[]>();

/**
 * NO: THIS GAME'S CONTRACT DOES NOT JUDGE AN ADVANCE, so the client's mirrored
 * guard is the only one there is.
 *
 * THE EVIDENCE, and it is one function. `UsingGameInternal._moveToNextPhase`
 * checks `CYCLE_POLICY != CyclePolicy.Manual` and nothing else: no `waitedFor`,
 * no `committed`, no `revealed`. Its own source says the unanimity guard is
 * missing, annotated at the line. The template's contract re-checks
 * all four conditions and reverts with a named error for each, which is what
 * `game/core/advance.ts` asks about and what it must NOT be told here.
 *
 * WHAT IT COSTS TO GET WRONG, in this game specifically: an advance pushed
 * early opens the reveal phase on a player who has not committed, or closes a
 * cycle on one who has not revealed. `lastCycleNumber` falls behind, `numMisses`
 * counts it, and at `numMissesAllowed` the avatar is dead. The game is called
 * reveal-or-die and that is the whole of why this constant is not `true`.
 *
 * IT LIVES HERE, BESIDE THIS GAME'S OWN ADVANCE, and that placement is the
 * point rather than tidiness. The template's `context/game.ts` answers this
 * question inline with `true` and a comment citing its own contract's four
 * guards - and that line merged into this repo CLEANLY on 2026-09-24, leaving
 * every suite green and the type checker satisfied while the repo claimed a
 * property it does not have. A named constant in the game's own module is a
 * line that reads as this repo's answer and is looked at by whoever ports the
 * contract, which is the person who will change it.
 *
 * FLIP IT WHEN THE CONTRACT EARNS IT: add the unanimity guard to
 * `_moveToNextPhase`, then set this to `true` in the same commit, and the hand
 * press goes back to letting the chain answer.
 */
export const THIS_CONTRACT_JUDGES_AN_ADVANCE = false;

/**
 * Say who the cycle in a world must wait for, as avatar ids.
 *
 * Called ONCE, by whoever provisioned the world, before anything plays. There
 * is no removal: an avatar that dies stops being waited for by itself (see
 * {@link createAttendanceReader}), which is the same answer the contract would
 * give and needs nobody to remember to call anything.
 */
export function declareWaitedFor(
	chainId: number,
	avatarIDs: readonly bigint[],
): void {
	waitedFor.set(chainId, [...avatarIDs]);
}

/** Who a world is waiting for. Nobody, unless somebody said otherwise. */
export function waitedForOnChain(chainId: number): readonly bigint[] {
	return waitedFor.get(chainId) ?? [];
}

/** Forget a world's table. For tests, and for a world being thrown away. */
export function forgetWaitedFor(chainId?: number): void {
	if (chainId === undefined) waitedFor.clear();
	else waitedFor.delete(chainId);
}

type ReadDeps = {
	/**
	 * Anything that can make a call.
	 *
	 * THE CONTEXT'S CLIENT IS ONE, AND NOT THE ONLY ONE, which is why this is the
	 * narrow shape rather than `Context['publicClient']`. The played seats build
	 * their own client (they are different keys acting for different identities,
	 * so they cannot use the app's), and that client is a viem client from a
	 * different copy of viem than the app's typed one - pnpm installs two here,
	 * same version, different zod peer. The reader calls `readContract` and
	 * nothing else, so asking for exactly that is both true and enough.
	 */
	publicClient: {
		readContract: Context['publicClient']['readContract'];
	};
	deployments: Context['deployments'];
};

/**
 * Where the cycle actually is.
 *
 * ONLY THE MANUAL POLICY CALLS THIS. Under `timed` the cycle is pure arithmetic
 * over the chain clock and `createCycleTrackers` never asks, which is what
 * keeps an ordinary deployment's RPC traffic exactly what it was.
 *
 * `phaseStart` and `phaseEnd` are ZERO and that is honest rather than lazy: a
 * manual cycle has no clock, so there is no time at which the phase began and
 * none at which it ends. `ManualCycleInfo` carries no timings for the same
 * reason, and `createManualCycleTrackers` reads only the two fields above them.
 */
export function createCycleReader(deps: ReadDeps): () => Promise<CycleReading> {
	return async () => {
		const Game = deps.deployments.get().contracts.Game;
		// TWO UNNAMED-IN-TYPESCRIPT RETURNS: solidity names them `cycleNumber` and
		// `commiting`, and viem hands back a positional tuple for a function with
		// more than one output whether or not they are named.
		const [cycleNumber, commiting] = (await deps.publicClient.readContract({
			address: Game.address,
			abi: Game.abi,
			functionName: 'getCycleNumber',
		})) as readonly [bigint, boolean];
		return {
			cycleNumber: Number(cycleNumber),
			isCommitPhase: commiting,
			phaseStart: 0,
			phaseEnd: 0,
		};
	};
}

/** What `getCommitment` hands back. `cycleNumber` is the ABI's own component name. */
type OnChainCommitment = {hash: `0x${string}`; cycleNumber: bigint};

/** What `getAvatar` hands back, of which three fields are read here. */
type PublicAvatar = {
	inGame: boolean;
	lastCycleNumber: bigint;
	life: number;
};

/**
 * WHO THE CYCLE IS WAITING FOR AND HOW MANY OF THEM HAVE ACTED, assembled from
 * per-avatar reads because this contract keeps no tally.
 *
 * THE THREE NUMBERS, and each one is read off a different thing:
 *
 * - **`waitedFor` is the LIVING members.** An avatar with no life left cannot
 *   commit - `_makeCommitment` reverts `AvatarIsDead` - so a dead member the
 *   cycle still waited for would block it forever, which under the manual
 *   policy means the world never moves again. Death is not an event and is
 *   never written down: `_getResolvedAvatar` computes it from how far
 *   `lastCycleNumber` has fallen behind the cycle, so the only way to know is to ask,
 *   every time. That is also why nothing has to deregister a member.
 *
 *   An avatar that has never ENTERED is alive by that rule (`life` is forced to
 *   1 while `inGame` is false) and is waited for, which is right: its first
 *   submission is the Enter, and a cycle that did not wait for it would open
 *   the reveal phase before it could make one.
 *
 * - **`revealed` is `lastCycleNumber == cycleNumber`.** The only thing that writes
 *   `lastCycleNumber` is `_resolveActions`, and the only thing that calls
 *   `_resolveActions` is `_reveal`. So that equality means exactly "this member
 *   opened its commitment in this cycle", which is the number the framework
 *   wants and one this contract does not otherwise expose.
 *
 * - **`committed` is that, OR a commitment stamped with this cycle.** Both
 *   halves are needed and the first is the one that is easy to miss: `_reveal`
 *   sets `commitment.cycleNumber = 0` when it is done, so a member that has already
 *   revealed looks exactly like a member that never committed. Counting only
 *   the second half would make `committed` FALL as the reveal phase progressed,
 *   and `advancePermitted` would then refuse to close a cycle everybody had
 *   finished.
 *
 * WHAT IT COSTS, said out loud because the template's version is one call. This
 * is one read per member, plus a second for each member that has not revealed
 * yet, on every poll - so a table of ten is up to twenty reads a second against
 * a chain that is also executing the world's transactions. It is affordable on
 * a chain in a tab (webevm 0.6.0 serialises the node, and a read there is
 * milliseconds) and it is the kind of thing that stops being affordable
 * quietly. The poll is a BACKSTOP - what makes a round quick is being poked at
 * the moment somebody acts - so the first thing to reach for, if this ever
 * shows up in a measurement, is a tally on chain rather than a shorter interval
 * here.
 */
export function createAttendanceReader(
	deps: ReadDeps & {
		/** The cycle to measure attendance IN. */
		cycleNumber: () => number;
		/** Who this world waits for. See {@link declareWaitedFor}. */
		waitedFor: () => readonly bigint[];
	},
): () => Promise<Attendance> {
	return async () => {
		const members = deps.waitedFor();
		const attendance: Attendance = {waitedFor: 0, committed: 0, revealed: 0};
		if (members.length === 0) return attendance;

		const Game = deps.deployments.get().contracts.Game;
		const cycleNumber = deps.cycleNumber();

		// IN SEQUENCE rather than in parallel. These share one node, and on the
		// chain this actually runs against that node is single threaded: a burst
		// of twenty reads is twenty things the world's own transactions queue
		// behind. The same argument `offline-players.ts` makes for its writes,
		// one level down and for reads.
		for (const avatarID of members) {
			const avatar = (await deps.publicClient.readContract({
				address: Game.address,
				abi: Game.abi,
				functionName: 'getAvatar',
				args: [avatarID],
			})) as PublicAvatar;

			// Dead, so it can no longer commit and the cycle must stop waiting for
			// it. See the note above: this is why nothing deregisters a member.
			if (avatar.life === 0) continue;
			attendance.waitedFor += 1;

			if (Number(avatar.lastCycleNumber) === cycleNumber) {
				attendance.committed += 1;
				attendance.revealed += 1;
				continue;
			}

			const commitment = (await deps.publicClient.readContract({
				address: Game.address,
				abi: Game.abi,
				functionName: 'getCommitment',
				args: [avatarID],
			})) as OnChainCommitment;
			if (Number(commitment.cycleNumber) === cycleNumber)
				attendance.committed += 1;
		}
		return attendance;
	};
}

/**
 * Push the cycle on, and resolve once it has been mined.
 *
 * NO DECLARED GAS LIMIT, which is a deliberate exception to what commit and
 * reveal do here rather than an omission. Those two carry measured figures
 * because a reveal cannot afford an `eth_estimateGas` round trip inside its
 * window; neither argument reaches this call. An advance is one small write, it
 * is not racing a phase boundary because it IS the phase boundary, and a figure
 * measured for it would be a third number to keep in step for no benefit.
 *
 * Estimating is also safe on the chain this matters most on. An estimate
 * executes at the last mined block's timestamp, which on an automined tab-local
 * chain is frozen between transactions - and a manual cycle reads no timestamp
 * at all, so there is nothing for a stale one to get wrong. That is not true
 * under `timed`, where this function is never reached because the contract
 * refuses.
 */
export function createCycleAdvancer(
	deps: AdvanceDeps,
): () => Promise<`0x${string}`> {
	return async () => {
		await deps.connection.ensureConnected();
		const executor = get(deps.signerExecutor);
		if (executor.status !== 'ready') {
			// Thrown rather than returned quietly: the framework backs off on a
			// failure and resets the moment the chain says something new, so a
			// silent success here would report a cycle as pushed when nothing was
			// sent.
			throw new Error(
				'No signing key yet, so the cycle cannot be advanced from this browser.',
			);
		}
		const Game = deps.deployments.get().contracts.Game;
		return sendWorldTransaction(
			deps,
			executor,
			{
				address: Game.address,
				abi: Game.abi,
				// ONE PHASE, NEVER A WHOLE CYCLE: the only advance the contract has.
				// See the head of this file for the one it used to have as well.
				functionName: 'moveToNextPhase',
				args: [],
				account: executor.account,
				chain: null,
			},
			'The cycle advance',
		);
	};
}
