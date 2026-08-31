import {describe, it, expect} from 'vitest';
import {readable} from 'svelte/store';
import {
	ContractFunctionExecutionError,
	ContractFunctionRevertedError,
	ExecutionRevertedError,
	encodeErrorResult,
} from 'viem';
import {
	sendPlacementTransaction,
	type CommitRevealDeps,
} from '$lib/placement/commit-reveal';
import {SignerOutOfFundsError} from '$lib/placement/errors';

/**
 * The boundary, tested as a boundary.
 *
 * `send` is the ONE place in this game that sees a raw node error, and the only
 * place that turns one into {@link SignerOutOfFundsError}. Everything
 * downstream (the HUD's message, the offer of a top-up, the automatic resume
 * when gas arrives) keys off that type, so a wrong answer here is not a wrong
 * message: it offers a player a remedy that cannot work, or withholds the one
 * that can while a reveal window closes on their stake.
 *
 * Classification itself belongs to `isInsufficientFundsFailure` upstream and is
 * tested there against many node shapes. What is tested here is that this game
 * asks it, believes it, and wraps only what it says - in particular that a
 * CONTRACT REVERT does not become an out-of-gas offer, because that is the
 * failure mode a naive message match reintroduces and it is invisible from the
 * outside: the player is sent to buy gas they already have.
 */

/**
 * A signer with gas, which is the precondition for these tests being ABOUT
 * anything: `send` now refuses before it reaches the node when this reads a
 * loaded zero (see `refuseWhenTheSignerHoldsNothing`), so a fake that left it
 * out would make every case below pass for the wrong reason.
 */
const FUNDED = readable({step: 'Loaded', value: 10n ** 18n}) as never;

const doItAbi = [
	{
		type: 'function',
		name: 'doIt',
		inputs: [],
		outputs: [],
		stateMutability: 'nonpayable',
	},
] as const;

/** A `send` whose write throws `error`, with inclusion never reached. */
function sendThrowing(error: unknown) {
	const deps = {
		publicClient: {
			waitForTransactionReceipt: async () => {
				throw new Error('should not have got as far as waiting');
			},
		},
		signerBalance: FUNDED,
	} as unknown as CommitRevealDeps;
	const executor = {
		client: {
			writeContract: async () => {
				throw error;
			},
		},
	};
	return sendPlacementTransaction(deps, executor, {}, 'The commitment');
}

describe('the game move boundary', () => {
	it('names a signer that cannot pay, keeping what the node said', async () => {
		const cause = new Error(
			'insufficient funds for gas * price + value: address 0x1 have 0 want 21000',
		);

		const thrown = await sendThrowing(cause).catch((e: unknown) => e);

		expect(thrown).toBeInstanceOf(SignerOutOfFundsError);
		// The original is kept rather than replaced: the details view shows it, and
		// a summary that has thrown away the node's own words cannot be debugged.
		expect((thrown as SignerOutOfFundsError).cause).toBe(cause);
	});

	it("recognises hardhat's wording too, not just geth's", async () => {
		// The local node is the one a developer meets first, and it words this
		// differently from every hosted node. Pinned here as well as upstream
		// because it is the chain this template is actually played on.
		const thrown = await sendThrowing(
			new Error("Sender doesn't have enough funds to send tx"),
		).catch((e: unknown) => e);

		expect(thrown).toBeInstanceOf(SignerOutOfFundsError);
	});

	it('does NOT offer a top-up for a contract that reverted', async () => {
		// The expensive mistake this boundary exists to avoid. A revert reason is
		// arbitrary text a contract author chose, "insufficient funds" is among the
		// most common things it says, and no amount of gas fixes it. Offering the
		// remedy here is worse than offering nothing, because it looks like it
		// should work.
		const flattened = new Error(
			'execution reverted: ERC20: insufficient funds for transfer',
		);

		await expect(sendThrowing(flattened)).rejects.toBe(flattened);

		const structured = new ContractFunctionExecutionError(
			new ExecutionRevertedError({
				message: 'insufficient funds for this purchase',
			}),
			{abi: doItAbi, functionName: 'doIt'},
		);

		await expect(sendThrowing(structured)).rejects.toBe(structured);
	});

	it('does NOT offer a top-up for a custom error that mentions funds', async () => {
		// Worse than the above, because viem renders a custom error without the
		// word "reverted" anywhere near the reason: only the error TYPE separates
		// this from a node refusing to pay. The template's own contract raises
		// custom errors (`NotEnoughTokens`, `BondTooLow`), so this is its normal
		// failure shape and not an exotic one.
		const abi = [
			...doItAbi,
			{
				type: 'error',
				name: 'PaymentFailed',
				inputs: [{type: 'string', name: 'reason'}],
			},
		] as const;
		const reverted = new ContractFunctionRevertedError({
			abi,
			functionName: 'doIt',
			data: encodeErrorResult({
				abi,
				errorName: 'PaymentFailed',
				args: ['insufficient funds for transfer'],
			}),
		});

		await expect(sendThrowing(reverted)).rejects.toBe(reverted);
	});

	it('passes an unrelated failure through untouched', async () => {
		// The round shows `message` for anything it cannot name, so an error that
		// arrives rewrapped would be reported as the wrong problem.
		const other = new Error('nonce too low');

		await expect(sendThrowing(other)).rejects.toBe(other);
	});

	it('throws on a reverted receipt rather than reporting success', async () => {
		// `writeContract` resolves on BROADCAST. Without this the round would call
		// itself Committed on a commitment that never landed, and the only symptom
		// would be `NothingToReveal` a phase later. Not an out-of-gas failure: the
		// transaction was paid for and mined.
		const deps = {
			publicClient: {
				waitForTransactionReceipt: async () => ({status: 'reverted'}),
			},
			signerBalance: FUNDED,
		} as unknown as CommitRevealDeps;
		const executor = {
			client: {writeContract: async () => '0xdead' as `0x${string}`},
		};

		const thrown = await sendPlacementTransaction(
			deps,
			executor,
			{},
			'The commitment',
		).catch((e: unknown) => e);

		expect(thrown).toBeInstanceOf(Error);
		expect(thrown).not.toBeInstanceOf(SignerOutOfFundsError);
		expect((thrown as Error).message).toBe(
			'The commitment was rejected by the contract',
		);
	});

	it('returns the hash once it is included', async () => {
		const deps = {
			publicClient: {
				waitForTransactionReceipt: async () => ({status: 'success'}),
			},
			signerBalance: FUNDED,
		} as unknown as CommitRevealDeps;
		const executor = {
			client: {writeContract: async () => '0xbeef' as `0x${string}`},
		};

		await expect(
			sendPlacementTransaction(deps, executor, {}, 'The reveal'),
		).resolves.toBe('0xbeef');
	});
});

describe('a signer with nothing in it never reaches the node', () => {
	/**
	 * WHY THIS REFUSAL EXISTS AT ALL, since "let the node say no" is the simpler
	 * design and is what this file used to do.
	 *
	 * On the local node this game develops and tests against, a transaction the
	 * node REJECTS for want of gas still advances that account's pending nonce,
	 * and nothing puts it back (`hardhat_setNonce` will not lower it). The signer
	 * is then wedged for good: every later move is built at a nonce the chain
	 * will never reach, gets a hash, and is never mined.
	 *
	 * The cost lands on the remedy rather than the fault. The player tops up, the
	 * round retries, and the retry hangs in `Committing` forever, so a stake that
	 * was recoverable is lost. That is precisely what `out-of-gas.e2e.ts` exists
	 * to prevent, and it was reaching it through the fix instead of the failure.
	 */
	function sendWithBalance(balance: {step: string; value?: bigint}) {
		let reachedTheNode = false;
		const deps = {
			publicClient: {
				waitForTransactionReceipt: async () => ({status: 'success'}),
			},
			signerBalance: readable(balance) as never,
		} as unknown as CommitRevealDeps;
		const executor = {
			client: {
				writeContract: async () => {
					reachedTheNode = true;
					return '0xhash' as `0x${string}`;
				},
			},
		};
		return {
			run: () => sendPlacementTransaction(deps, executor, {}, 'The commitment'),
			reachedTheNode: () => reachedTheNode,
		};
	}

	it('refuses, and says the thing the player can act on', async () => {
		const {run, reachedTheNode} = sendWithBalance({step: 'Loaded', value: 0n});
		await expect(run()).rejects.toBeInstanceOf(SignerOutOfFundsError);
		// The whole point: nothing was sent, so no nonce was burned.
		expect(reachedTheNode(), 'a doomed move must not reach the node').toBe(
			false,
		);
	});

	it('sends when the signer has gas', async () => {
		const {run, reachedTheNode} = sendWithBalance({step: 'Loaded', value: 1n});
		await expect(run()).resolves.toBe('0xhash');
		expect(reachedTheNode()).toBe(true);
	});

	it('does NOT refuse on a balance it has not read yet', async () => {
		// The guard asserts about what the app already SHOWS the player, so an
		// unloaded store falls through to the behaviour that shipped before it.
		// Refusing here would block a funded signer's move on a slow first poll,
		// which is a worse failure than the one being prevented and would look
		// exactly like the app being broken at startup.
		const {run, reachedTheNode} = sendWithBalance({step: 'Unloaded'});
		await expect(run()).resolves.toBe('0xhash');
		expect(reachedTheNode()).toBe(true);
	});
});
