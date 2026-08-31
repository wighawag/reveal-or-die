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
import {isInsufficientFundsFailure} from '$lib/core/transaction';
import {SignerOutOfFundsError} from './errors';

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
 * `signerExecutor`, NOT `accountExecutor`: commit and reveal are signed by the local
 * signer so the player is never prompted mid-round, and so an account with no
 * wallet provider (email/social sign-in) can play at all. See where the game
 * executor is built in `context/core.ts`.
 */
export type CommitRevealDeps = Pick<
	Context,
	| 'connection'
	| 'signerExecutor'
	| 'deployments'
	| 'publicClient'
	| 'signerBalance'
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
 * WHAT IT DOES DO, since 'after the fact' turned out not to be free: it refuses
 * to put a move on the wire when the app ALREADY knows the signer holds nothing.
 * See {@link refuseWhenTheSignerHoldsNothing}. That is not the modal-opening
 * pre-flight check above, and costs no RPC call: it reads the balance the player
 * is already being shown.
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
/**
 * Refuse a move the signer demonstrably cannot pay for, BEFORE it is sent.
 *
 * A DOOMED SEND IS NOT FREE, which is the whole reason this exists. On the local
 * node this game develops and tests against, a transaction the node REJECTS for
 * want of gas still advances that account's pending nonce, permanently: the
 * account is then wedged, because every later transaction is built at a nonce
 * the chain will never reach, gets a hash, and is never mined. Reproduced in
 * isolation, with no app code involved, in
 * `work/notes/findings/a-rejected-transaction-burns-a-nonce-on-edr.md` (the
 * `work` branch, as ADR-0004 records):
 * drain an account, send, watch the send be refused and `pending` go up anyway.
 * `hardhat_setNonce` will not put it back.
 *
 * The cost of that lands squarely on the feature this file is most careful
 * about: the player tops up, the round retries, and the retry can never mine, so
 * a stake that was recoverable is lost to a stuck `Committing` instead. That is
 * the exact failure `out-of-gas.e2e.ts` exists to prevent, arriving through the
 * remedy rather than the original fault.
 *
 * THE CHECK IS DELIBERATELY NARROW, and reads as an assertion about the app
 * rather than about the chain. It fires only when the balance the player is
 * ALREADY being shown says zero: a store that has loaded, and loaded a nought.
 * So it costs no RPC round trip, it cannot contradict the UI (if it refuses, the
 * screen is already offering the top-up), and an unloaded or stale store simply
 * falls through to the behaviour below, which is what shipped before this.
 *
 * It does NOT try to answer "can this afford THIS move", which would need a gas
 * estimate on a per-move path and would still be a guess. A partially funded
 * signer can still be rejected by the node and still burn a nonce there. That is
 * a smaller window and a node defect rather than this app's, and paying an
 * estimate on every commit and every reveal to narrow it is not a trade worth
 * making silently.
 */
function refuseWhenTheSignerHoldsNothing(deps: CommitRevealDeps): void {
	const balance = get(deps.signerBalance);
	if (balance.step === 'Loaded' && balance.value === 0n) {
		throw new SignerOutOfFundsError(
			new Error('the signer holds no gas, so this move was not sent'),
		);
	}
}

async function send(
	deps: CommitRevealDeps,
	executor: {
		client: {writeContract: (request: never) => Promise<`0x${string}`>};
	},
	request: unknown,
	what: string,
): Promise<`0x${string}`> {
	refuseWhenTheSignerHoldsNothing(deps);
	let hash: `0x${string}`;
	try {
		hash = await executor.client.writeContract(request as never);
	} catch (error) {
		// THE boundary. This is the only place in the game that sees a raw node
		// error, so it is the only place that classifies one: everything
		// downstream asks `instanceof SignerOutOfFundsError` instead of running
		// upstream's classifier again over an error this app already named.
		//
		// Named as its own type so the UI can offer the remedy (topping the
		// SIGNER up) instead of a dead end, and so the round can carry on once
		// the money lands. See ./errors.
		if (isInsufficientFundsFailure(error)) {
			throw new SignerOutOfFundsError(error);
		}
		throw error;
	}
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
		buildCommitment: buildPlacementCommitment,

		async commit({identity, hash, actions}) {
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
						// `identity` is the ACCOUNT; the executor sending this is the
						// signer acting for it. The contract checks the pair, so a
						// signer that has not been authorised (or has been revoked)
						// reverts here rather than quietly bonding its own empty
						// reserve. The commitment, the bond and the cells it wins all
						// belong to the account, so losing this browser costs a key and
						// nothing else.
						args: [identity, hash, bond, zeroAddress],
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
