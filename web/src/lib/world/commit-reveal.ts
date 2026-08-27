/**
 * This game's `CommitRevealAdapter`.
 *
 * The framework's round decides WHEN these are called and keeps the secret
 * between the two; this file is only the translation into the Game contract's
 * own calls. That split is the seam: a game with a different identity model, or
 * a contract that names things differently, replaces this file and nothing
 * else.
 */
import {get} from 'svelte/store';
import {logs} from 'named-logs';
import {zeroAddress} from 'viem';
import type {Context} from '$lib/context/types';
import type {CommitRevealAdapter} from '$lib/game/core/seams';
import {isInsufficientFundsFailure} from '$lib/core/transaction';
import {SignerOutOfFundsError} from './errors';
import {
	commitmentHash,
	encodeCommitment,
	type Action,
} from 'reveal-or-die-contracts';

export type {Action};

/**
 * The silent path, traced.
 *
 * Every move the player never sees a prompt for goes through `send` below, and
 * the two interesting moments have no store to watch them: the gap before the
 * hash comes back (which is what arms the unload guard and the sending
 * indicator) and the gap before the receipt does. Both are logged so a
 * recording can be lined up against them. Inert unless the namespace is enabled;
 * see the inline switch in `src/app.html` and $lib/debug/diagnostics.ts.
 */
const logger = logs('world:send');

/**
 * The commitment hash comes from the CONTRACTS package, not from a copy here.
 *
 * It has to match `UsingGameInternal._checkHash` exactly, and a mismatch is
 * neither a compile error nor a failed read: the commit succeeds and the reveal
 * reverts with `CommitmentHashNotMatching` an entire phase later, by which time
 * the commitment is immovable. Keeping the one implementation next to the
 * Solidity means `contracts/test/js/Game.test.ts` exercises this exact function
 * against a real chain on every run.
 */
export function buildWorldCommitment(params: {
	actions: readonly Action[];
	secret: `0x${string}`;
}): {hash: `0x${string}`; encoded: `0x${string}`} {
	return {
		encoded: encodeCommitment(params.secret, params.actions),
		hash: commitmentHash(params.secret, params.actions),
	};
}

/**
 * What the adapter needs.
 *
 * `signerExecutor`, NOT `accountExecutor`: commit and reveal are signed by the
 * local signer so the player is never prompted mid-round, and so an account
 * with no wallet provider (email or social sign-in) can play at all.
 */
export type CommitRevealDeps = Pick<
	Context,
	'connection' | 'signerExecutor' | 'deployments' | 'publicClient'
>;

/**
 * Send a game move and wait for it to be included.
 *
 * Deliberately does NOT go through `balanceCheck.ensureCanAfford`. That helper
 * opens a modal for the duration of the call and checks the WALLET's balance,
 * and neither is right for a move: a move is signed by the local signer with no
 * prompt, so a modal over the board on every commit and every reveal is exactly
 * the interruption the signer exists to remove, and the balance it checks
 * belongs to a different address from the one actually paying.
 *
 * Waiting for inclusion matters more than it looks. `writeContract` resolves as
 * soon as the transaction is BROADCAST, so without this a commitment that
 * reverts would still resolve happily, the round would call itself Committed,
 * and the only symptom would be a baffling `NothingToReveal` a phase later.
 */
async function send(
	deps: CommitRevealDeps,
	executor: {
		client: {writeContract: (request: never) => Promise<`0x${string}`>};
	},
	request: unknown,
	what: string,
): Promise<`0x${string}`> {
	let hash: `0x${string}`;
	const startedAt = Date.now();
	logger.debug(`${what}: dispatching (signer, no prompt)`);
	try {
		hash = await executor.client.writeContract(request as never);
	} catch (error) {
		logger.debug(`${what}: dispatch failed after ${Date.now() - startedAt}ms`);
		// THE boundary. The only place in this game that sees a raw node error, so
		// the only place that classifies one. Everything downstream asks
		// `instanceof SignerOutOfFundsError` rather than running the classifier
		// again over an error this app already named.
		if (isInsufficientFundsFailure(error)) {
			throw new SignerOutOfFundsError(error);
		}
		throw error;
	}
	const dispatchedAt = Date.now();
	logger.debug(
		`${what}: broadcast in ${dispatchedAt - startedAt}ms, hash ${hash}`,
	);
	const receipt = await deps.publicClient.waitForTransactionReceipt({hash});
	logger.debug(
		`${what}: ${receipt.status} after a further ${Date.now() - dispatchedAt}ms`,
	);
	if (receipt.status === 'reverted') {
		throw new Error(`${what} was rejected by the contract`);
	}
	return hash;
}

export function createWorldCommitReveal(params: {
	deps: CommitRevealDeps;
	/**
	 * Run before a commitment is built or sent, to refuse one that cannot
	 * succeed. Throwing here surfaces as the round's Error state, so whatever is
	 * thrown is read by the player and should say what to do about it.
	 *
	 * This game needs it for the unrevealed-commitment case. `_makeCommitment`
	 * rejects a commitment left over from an earlier epoch with
	 * `PreviousCommitmentNotRevealed`, and the remedy is to call
	 * `acknowledgeMissedReveal` first, which the player has to be told about
	 * rather than left to discover through a bare revert after paying gas.
	 */
	beforeCommit?: () => Promise<void>;
}): CommitRevealAdapter<bigint, Action> {
	const {deps} = params;

	async function ready() {
		const {connection, signerExecutor, deployments} = deps;
		await connection.ensureConnected();
		const $executor = get(signerExecutor);
		if ($executor.status === 'cannot-send') {
			throw new Error('This account cannot send transactions in this mode.');
		}
		if ($executor.status !== 'ready') {
			throw new Error(
				'No signing key yet. Sign in so the game can play your moves without prompting you for each one.',
			);
		}
		return {executor: $executor, deployments: get(deployments)};
	}

	return {
		buildCommitment: buildWorldCommitment,

		async commit({identity, hash}) {
			await params.beforeCommit?.();
			const {executor, deployments} = await ready();

			// No bond. This game's stake is the AVATAR, already in the contract's
			// custody from the deposit, so there is nothing to bond per round the
			// way a token reserve would be. What a player loses by going quiet is
			// liveness on that avatar, not a sum named here.
			return {
				hash: await send(
					deps,
					executor,
					{
						address: deployments.contracts.Game.address,
						abi: deployments.contracts.Game.abi,
						functionName: 'commit',
						// `identity` is the AVATAR, and the executor sending this is the
						// signer acting for its owner. The contract resolves the avatar's
						// owner and checks the sender may act for that ACCOUNT, so a
						// signer that was never authorised (or has been revoked) reverts
						// here rather than quietly committing.
						args: [identity, hash, zeroAddress],
						account: executor.account,
						chain: null,
					},
					'The commitment',
				),
			};
		},

		async reveal({identity, actions, secret}) {
			const {executor, deployments} = await ready();

			return {
				hash: await send(
					deps,
					executor,
					{
						address: deployments.contracts.Game.address,
						abi: deployments.contracts.Game.abi,
						functionName: 'reveal',
						args: [identity, actions as Action[], secret, zeroAddress],
						account: executor.account,
						chain: null,
					},
					'The reveal',
				),
			};
		},
	};
}

/**
 * Send a prepared request, for callers outside the adapter.
 *
 * Exported so anything that has to settle a commitment (acknowledging a missed
 * reveal, for instance) goes through exactly the same wait-for-inclusion and
 * error-classification path rather than growing its own.
 */
export {send as sendWorldTransaction};
