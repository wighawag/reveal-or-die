/**
 * The template game's `CommitRevealAdapter`.
 *
 * The framework's round decides WHEN these are called and keeps the secret
 * between the two; this file is only the translation into the Game contract's
 * own calls. That split is the seam: a game with a different identity model, or
 * a contract that names things differently, replaces this file and nothing
 * else.
 */
import {get} from 'svelte/store';
import {encodeAbiParameters, keccak256, zeroAddress, type Account} from 'viem';
import type {Context} from '$lib/context/types';
import type {CommitRevealAdapter} from '$lib/game/core/seams';
import {costOfPlacements, type PlacementConfig} from './config';

/** One placement, matching the contract's `Placement` struct. */
export type Placement = {cellID: bigint};

/**
 * The ABI encoding the commitment hash is taken over.
 *
 * It must match `UsingGameInternal._checkHash` exactly - same types, same
 * order. A mismatch is not a compile error and not a failed read: the commit
 * succeeds, and the reveal reverts with `CommitmentHashNotMatching` once the
 * player's stake is already bonded. `contracts/test/Game.test.ts` computes the
 * hash the same way from the other side.
 */
const COMMITMENT_ABI = [
	{type: 'bytes32'},
	{type: 'tuple[]', components: [{name: 'cellID', type: 'uint64'}]},
] as const;

/**
 * `bytes24(keccak256(...))`: the contract stores 24 bytes, so the client must
 * truncate the same way. 2 characters for `0x` plus 48 hex digits.
 */
const BYTES24_HEX_LENGTH = 50;

export function buildPlacementCommitment(params: {
	actions: readonly Placement[];
	secret: `0x${string}`;
}): {hash: `0x${string}`; encoded: `0x${string}`} {
	const encoded = encodeAbiParameters(COMMITMENT_ABI, [
		params.secret,
		params.actions as {cellID: bigint}[],
	]);
	return {
		encoded,
		hash: keccak256(encoded).slice(0, BYTES24_HEX_LENGTH) as `0x${string}`,
	};
}

/**
 * What the adapter needs.
 *
 * `gameExecutor`, NOT `executor`: commit and reveal are signed by the local
 * signer so the player is never prompted mid-round, and so an account with no
 * wallet provider (email/social sign-in) can play at all. See where the game
 * executor is built in `context/core.ts`.
 */
export type CommitRevealDeps = Pick<
	Context,
	'connection' | 'gameExecutor' | 'deployments' | 'publicClient'
>;

/**
 * Send a game move and wait for it to be included.
 *
 * Deliberately does NOT go through `balanceCheck.ensureCanAfford`.
 *
 * That helper is the app's user-facing spending check: it opens a modal for the
 * whole call ("Preparing Transaction" while it estimates, then an
 * insufficient-funds prompt), and it checks the balance of the WALLET. Neither
 * is right for a move. A move is signed by the local signer with no prompt, so
 * a modal appearing over the board on every commit and every reveal is exactly
 * the interruption the signer exists to remove - and the balance it was
 * checking belonged to a different address from the one actually paying.
 *
 * The signer needs gas of its own; that is surfaced up front as a balance the
 * player can top up, not discovered mid-round. See `signerBalance` in the
 * context.
 *
 * Waiting for inclusion matters more than it looks. `writeContract` resolves as soon as
 * the transaction is BROADCAST, so without this a commitment that reverts (an
 * empty reserve, a bond the reserve cannot cover) would still resolve happily,
 * the round would call itself Committed, and the only symptom would be a
 * baffling `NothingToReveal` a phase later. The round's states are what the
 * player is told about something they have money on, so they have to mean what
 * they say.
 *
 * The cast is doing one specific job: viem types `value` differently for a
 * PAYABLE function than the tracked client's `writeContract` generic expects.
 * Nothing about the VALUE is wrong - commit and reveal are payable in the ABI
 * and neither sends ether.
 */
async function send(
	deps: CommitRevealDeps,
	executor: {
		client: {writeContract: (request: never) => Promise<`0x${string}`>};
	},
	request: unknown,
	what: string,
): Promise<`0x${string}`> {
	const hash = await executor.client.writeContract(request as never);
	const receipt = await deps.publicClient.waitForTransactionReceipt({hash});
	if (receipt.status === 'reverted') {
		throw new Error(`${what} was rejected by the contract`);
	}
	return hash;
}

export function createPlacementCommitReveal(params: {
	deps: CommitRevealDeps;
	config: PlacementConfig;
	/**
	 * Run before a commitment is built or sent, to refuse one that cannot
	 * succeed. Throwing here surfaces as the round's Error state, so whatever is
	 * thrown is read by the player: it should say what to do about it.
	 *
	 * Used for the unrevealed-commitment case, which the contract would otherwise
	 * reject with a bare `PreviousCommitmentNotRevealed` after the player had
	 * already paid gas.
	 */
	beforeCommit?: () => Promise<void>;
}): CommitRevealAdapter<`0x${string}`, Placement> {
	const {deps, config} = params;

	async function ready() {
		const {connection, gameExecutor, deployments} = deps;
		await connection.ensureConnected();
		const $executor = get(gameExecutor);
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
		buildCommitment: buildPlacementCommitment,

		async commit({hash, actions}) {
			await params.beforeCommit?.();
			const {executor, deployments} = await ready();

			// The bond is the exact cost of what was planned. The contract only
			// requires it to COVER the reveal, but bonding more would leave the
			// surplus locked out of the reserve until the round settles, and
			// bonding less makes the reveal revert with `BondTooLow` after the
			// commitment is already immovable.
			const bond = costOfPlacements(config, actions.length);

			return {
				hash: await send(
					deps,
					executor,
					{
						address: deployments.contracts.Game.address,
						abi: deployments.contracts.Game.abi,
						functionName: 'makeCommitment',
						args: [hash, bond, zeroAddress],
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
						// `player` rather than msg.sender: the contract accepts a reveal
						// submitted by anyone, so that being offline is not automatically
						// a forfeit. Here the player reveals for themselves.
						args: [
							identity,
							actions as {cellID: bigint}[],
							secret,
							zeroAddress,
						],
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
 * Exported so the missed-reveal store can settle a forfeited commitment through
 * exactly the same wait-for-inclusion path, rather than growing its own.
 */
export {send as sendPlacementTransaction};
