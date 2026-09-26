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
 * **1. The cycle read is `getCycleNumber`, not `getCycle`.** The template's
 * contract has both; `getCycleNumber` is the one of the same shape, and this
 * game's contract has only it. It answers under BOTH policies, because
 * `_cycleNumber()` returns the manual cycle when there is no clock.
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
 * **3. The contract judges the advance, as the template's does (since
 * 2026-09-26).** `_moveToNextPhase` refuses with the template's errors
 * (`NoOneToWaitFor`, `StillWaitingToCommit`, `StillWaitingToReveal`) unless
 * every living member has committed, or every commitment has been revealed. It
 * used to check the policy and nothing else, which made the client's mirrored
 * guard the only guard there was; see {@link THIS_CONTRACT_JUDGES_AN_ADVANCE}.
 *
 * WHO IS A MEMBER IS DECIDED AT SETUP: under the manual policy an avatar is
 * waited for from the moment it enters custody, which is when a lobby or an
 * offline world provisions its seats, until it leaves. A dead member is not
 * waited for, and nothing has to say so: the contract counts attendance when
 * it is asked, and death is computed the same way.
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
 * YES: THIS GAME'S CONTRACT JUDGES AN ADVANCE, so the framework may send a hand
 * press and let the chain answer.
 *
 * THE EVIDENCE, and it is one function. `UsingGameInternal._moveToNextPhase`
 * reads `_attendance` and refuses with a named error unless the push is
 * unanimous: `NoOneToWaitFor`, `StillWaitingToCommit`, `StillWaitingToReveal`,
 * the template's own conditions. `contracts/test/js/ManualCycle.test.ts` pins
 * each one, and removing either check fails it.
 *
 * IT WAS `false` UNTIL 2026-09-26, and that history is why this is a named
 * constant beside the evidence rather than a literal in `context/game.ts`. The
 * template answers the same question inline with `true`, and that line merged
 * into this repo CLEANLY on 2026-09-24, leaving every suite green while the
 * repo claimed a property it did not have. A constant here is read by whoever
 * changes the contract, which is the person who must change it back if the
 * guard ever goes.
 */
export const THIS_CONTRACT_JUDGES_AN_ADVANCE = true;

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

/**
 * Who the cycle waits for and how many of them have acted: `getAttendance`, the
 * contract's own count, which is also what `_moveToNextPhase` judges by.
 *
 * ONE READ, where it used to be one or two per member assembled here, because
 * the contract kept no membership. The rules it counts by (the LIVING members;
 * `revealed` from `lastCycleNumber`; `committed` from either half) are written
 * at `UsingGameInternal._attendance` now, beside the code that enforces them.
 */
export function createAttendanceReader(
	deps: ReadDeps,
): () => Promise<Attendance> {
	return async () => {
		const Game = deps.deployments.get().contracts.Game;
		const attendance = (await deps.publicClient.readContract({
			address: Game.address,
			abi: Game.abi,
			functionName: 'getAttendance',
		})) as {waitedFor: bigint; committed: bigint; revealed: bigint};
		return {
			waitedFor: Number(attendance.waitedFor),
			committed: Number(attendance.committed),
			revealed: Number(attendance.revealed),
		};
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
