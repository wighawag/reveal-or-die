/**
 * A commitment from a past epoch that was never revealed.
 *
 * This exists because of a guard this repo re-enabled. `_makeCommitment`
 * rejects a commitment left over from an EARLIER epoch with
 * `PreviousCommitmentNotRevealed`, so an avatar that went quiet cannot play
 * again until the player acknowledges it. Without something watching for that,
 * the only symptom is every commit failing with a bare revert.
 *
 * Note what this is NOT. The template's equivalent reports a FORFEIT: its
 * `acknowledgeMissedReveal` burns the bond, so the store is telling the player
 * what it cost them. Here it costs nothing today (`_acknowledgeMissedReveal`
 * carries `TODO burn / stake` and forfeits nothing), so this is about
 * UNBLOCKING play rather than reporting a loss. If a forfeit is added later,
 * this is where it gets surfaced.
 */
import {get, writable, type Readable} from 'svelte/store';
import type {Context} from '$lib/context/types';
import {sendWorldTransaction} from './commit-reveal';
import type {CommitRevealDeps} from './commit-reveal';

export type MissedRevealState =
	| {step: 'Unknown'}
	| {step: 'Clear'}
	/** An unrevealed commitment from `epoch` is blocking every new commitment. */
	| {step: 'Blocked'; epoch: number}
	| {step: 'Acknowledging'; epoch: number}
	| {step: 'Failed'; epoch: number; error: unknown};

export type MissedRevealStore = Readable<MissedRevealState> & {
	readonly value: MissedRevealState;
	/** Re-read the chain. One call. */
	check(): Promise<void>;
	/** Clear the stale commitment so the player can commit again. */
	acknowledge(): Promise<void>;
};

/**
 * Whether the player is currently barred from committing.
 *
 * `Failed` counts. An acknowledgement that did not go through leaves the
 * commitment exactly where it was, so treating the failure as "clear" would
 * let the round try to commit and fail again on chain, which costs gas to
 * learn nothing.
 */
export function blocksCommitting(state: MissedRevealState): boolean {
	return (
		state.step === 'Blocked' ||
		state.step === 'Acknowledging' ||
		state.step === 'Failed'
	);
}

export type MissedRevealDeps = CommitRevealDeps &
	Pick<Context, 'deployments' | 'publicClient'>;

export function createMissedReveal(params: {
	deps: MissedRevealDeps;
	/** The avatar being played; undefined when none is chosen. */
	avatarID: Readable<bigint | undefined>;
	/** The epoch the game is in now. */
	currentEpoch: Readable<number>;
	onSettled?: () => void;
}): MissedRevealStore {
	const {deps, avatarID, currentEpoch} = params;

	const state = writable<MissedRevealState>({step: 'Unknown'});
	let value: MissedRevealState = {step: 'Unknown'};
	state.subscribe((v) => (value = v));

	async function check() {
		const id = get(avatarID);
		if (id === undefined) {
			state.set({step: 'Unknown'});
			return;
		}
		// Do not stomp an acknowledgement that is in flight.
		if (value.step === 'Acknowledging') return;

		try {
			const Game = get(deps.deployments).contracts.Game;
			const commitment = (await deps.publicClient.readContract({
				address: Game.address,
				abi: Game.abi,
				functionName: 'getCommitment',
				args: [id],
			})) as {hash: `0x${string}`; epoch: bigint};

			const epoch = Number(commitment.epoch);
			// epoch 0 means no commitment; one for the CURRENT epoch is the round in
			// progress and blocks nothing. Only an older one bars the way, which is
			// exactly the condition `_makeCommitment` tests.
			if (epoch === 0 || epoch === get(currentEpoch)) {
				state.set({step: 'Clear'});
				return;
			}
			state.set({step: 'Blocked', epoch});
		} catch {
			// A failed read is not evidence of being blocked, and claiming it was
			// would bar the player from playing because their node hiccuped.
			state.set({step: 'Unknown'});
		}
	}

	async function acknowledge() {
		const id = get(avatarID);
		const current = value;
		if (id === undefined) return;
		if (current.step !== 'Blocked' && current.step !== 'Failed') return;

		const epoch = current.epoch;
		state.set({step: 'Acknowledging', epoch});
		try {
			const {connection, signerExecutor, deployments} = deps;
			await connection.ensureConnected();
			const $executor = get(signerExecutor);
			if ($executor.status !== 'ready') {
				throw new Error(
					'No signing key yet. Sign in so the game can play your moves without prompting you for each one.',
				);
			}
			const Game = get(deployments).contracts.Game;

			// Through the same funnel as a move, so it waits for inclusion and gets
			// the same out-of-gas classification. A settle that resolved on
			// BROADCAST would report the player unblocked while the chain still
			// says otherwise, and the next commit would fail.
			await sendWorldTransaction(
				deps,
				$executor,
				{
					address: Game.address,
					abi: Game.abi,
					functionName: 'acknowledgeMissedReveal',
					args: [id],
					account: $executor.account,
					chain: null,
				},
				'The acknowledgement',
			);

			state.set({step: 'Clear'});
			params.onSettled?.();
		} catch (error) {
			state.set({step: 'Failed', epoch, error});
		}
	}

	return {
		subscribe: state.subscribe,
		get value() {
			return value;
		},
		check,
		acknowledge,
	};
}
