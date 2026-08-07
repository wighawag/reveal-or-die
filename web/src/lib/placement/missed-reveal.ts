/**
 * A commitment the player never revealed.
 *
 * The contract keeps one open commitment per player. If a reveal phase passes
 * without one, that commitment stays on the books and every later
 * `makeCommitment` reverts with `PreviousCommitmentNotRevealed`. Nothing
 * resolves it on its own, so a player who misses a single reveal - closes the
 * tab at the wrong moment, loses their connection - is locked out of the game
 * until someone calls `acknowledgeMissedReveal`.
 *
 * That call FORFEITS THE BOND, so it is the player's to make.
 *
 * This was briefly done automatically, as a quiet fix-up at the start of the
 * next commit. That was wrong in two ways at once: it spent the player's money
 * inside a transaction they thought was about something else, and it meant they
 * were never told they had missed a reveal or what it had cost them. Losing a
 * stake is the single most important thing this app can have to say to someone.
 * So it is surfaced, explained, and waits for a deliberate press.
 *
 * The chain is the authority here, not the local round: clearing site data or
 * playing from another browser loses the local memory of the round, while the
 * contract still holds the commitment.
 */
import {derived, get, writable, type Readable} from 'svelte/store';
import type {Context} from '$lib/context/types';
import type {PlacementConfig} from './config';
import {sendPlacementTransaction} from './commit-reveal';

export type MissedRevealState =
	/** Not checked yet, or nobody connected. */
	| {step: 'Unknown'}
	/** No open commitment from a past epoch: the player is free to commit. */
	| {step: 'Clear'}
	/**
	 * An unrevealed commitment is blocking play. The bond is already lost; what
	 * is left is to say so on chain, which is what frees the player to commit
	 * again.
	 */
	| {step: 'Blocked'; epoch: number; bond: bigint}
	| {step: 'Acknowledging'; epoch: number; bond: bigint}
	| {step: 'Failed'; epoch: number; bond: bigint; message: string};

export type MissedRevealStore = Readable<MissedRevealState> & {
	readonly value: MissedRevealState;
	/** Re-read the chain. Cheap: one call, plus one more only if blocked. */
	check(): Promise<void>;
	/** Forfeit the bond and free the player to commit again. */
	acknowledge(): Promise<void>;
};

export type MissedRevealDeps = Pick<
	Context,
	| 'connection'
	| 'gameExecutor'
	| 'deployments'
	| 'publicClient'
	| 'gameIdentity'
>;

export function createMissedReveal(params: {
	deps: MissedRevealDeps;
	config: PlacementConfig;
	/** Called once a forfeit settles, so the reserve can be re-read. */
	onSettled?: () => void;
}): MissedRevealStore {
	const {deps} = params;

	let $state: MissedRevealState = {step: 'Unknown'};
	const store = writable<MissedRevealState>($state);

	function set(next: MissedRevealState) {
		$state = next;
		store.set(next);
	}

	async function check() {
		const player = get(deps.gameIdentity);
		if (!player) {
			set({step: 'Unknown'});
			return;
		}
		const deployments = deps.deployments.get();

		try {
			const commitment = (await deps.publicClient.readContract({
				address: deployments.contracts.Game.address,
				abi: deployments.contracts.Game.abi,
				functionName: 'getCommitment',
				args: [player],
			})) as {epoch: bigint; bond: bigint};

			if (commitment.epoch === 0n) {
				set({step: 'Clear'});
				return;
			}

			const [currentEpoch] = (await deps.publicClient.readContract({
				address: deployments.contracts.Game.address,
				abi: deployments.contracts.Game.abi,
				functionName: 'getEpoch',
			})) as [bigint, boolean];

			// A commitment for the CURRENT epoch is live, not missed: it can still
			// be revealed, the contract lets it be replaced, and acknowledging it
			// would revert with `CanStillReveal`.
			if (commitment.epoch === currentEpoch) {
				set({step: 'Clear'});
				return;
			}

			set({
				step: 'Blocked',
				epoch: Number(commitment.epoch),
				bond: commitment.bond,
			});
		} catch {
			// A failed read is not evidence of anything. Leaving the last known
			// state alone is better than telling someone they have lost a stake
			// because one RPC call did not come back.
		}
	}

	async function acknowledge() {
		if ($state.step !== 'Blocked' && $state.step !== 'Failed') return;
		const {epoch, bond} = $state;

		const player = get(deps.gameIdentity);
		if (!player) return;

		await deps.connection.ensureConnected();
		const executor = get(deps.gameExecutor);
		if (executor.status !== 'ready') return;

		set({step: 'Acknowledging', epoch, bond});
		try {
			// Sent by the signer, like every other move, so no spending modal.
			await sendPlacementTransaction(
				deps,
				executor,
				{
					address: deps.deployments.get().contracts.Game.address,
					abi: deps.deployments.get().contracts.Game.abi,
					// Takes the player rather than using msg.sender: anyone may settle
					// anyone's missed reveal. Here the player settles their own.
					functionName: 'acknowledgeMissedReveal',
					args: [player],
					account: executor.account,
					chain: null,
				},
				'Acknowledging the missed reveal',
			);
			set({step: 'Clear'});
			params.onSettled?.();
		} catch (error) {
			set({
				step: 'Failed',
				epoch,
				bond,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return {
		get value() {
			return $state;
		},
		subscribe: store.subscribe,
		check,
		acknowledge,
	};
}

/** Whether an unrevealed commitment is currently preventing a new one. */
export function blocksCommitting(state: MissedRevealState): boolean {
	return (
		state.step === 'Blocked' ||
		state.step === 'Acknowledging' ||
		state.step === 'Failed'
	);
}
