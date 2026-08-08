import {describe, expect, it} from 'vitest';
import {
	isInsufficientFunds,
	SignerOutOfFundsError,
} from '$lib/placement/errors';

/**
 * The wording these cases use is copied from what the nodes actually say,
 * because that is the entire contract this module has: there is no structured
 * signal for "the sender could not pay", only the node's prose, wrapped several
 * layers deep by viem.
 */
describe('recognising a sender that cannot pay', () => {
	it('matches hardhat', () => {
		expect(
			isInsufficientFunds(
				new Error(
					"Sender doesn't have enough funds to send tx. The max upfront cost is: 100 and the sender's account only has: 0",
				),
			),
		).toBe(true);
	});

	it('matches geth and the clients that copy it', () => {
		expect(
			isInsufficientFunds(
				new Error('insufficient funds for gas * price + value'),
			),
		).toBe(true);
	});

	it('finds it through viem"s wrapping', () => {
		// viem reports its own summary and keeps the node's wording further down,
		// which is why this walks the chain rather than reading one message.
		const nested = {
			shortMessage: 'An unknown RPC error occurred.',
			cause: {
				shortMessage: 'Invalid parameters were provided to the RPC method.',
				cause: {
					details: "sender doesn't have enough funds to send tx",
				},
			},
		};
		expect(isInsufficientFunds(nested)).toBe(true);
	});

	it('does not match an ordinary revert', () => {
		expect(
			isInsufficientFunds(
				new Error('The commitment was rejected by the contract'),
			),
		).toBe(false);
		expect(
			isInsufficientFunds(
				new Error('execution reverted: PreviousCommitmentNotRevealed'),
			),
		).toBe(false);
	});

	it('does not match a user rejecting the prompt', () => {
		expect(isInsufficientFunds(new Error('User rejected the request.'))).toBe(
			false,
		);
	});

	it('recognises its own error type', () => {
		expect(isInsufficientFunds(new SignerOutOfFundsError(undefined))).toBe(
			true,
		);
	});

	it('survives junk, rather than throwing while reporting a failure', () => {
		// This runs on the error path. Throwing here would replace a message the
		// player could act on with a blank screen.
		for (const value of [undefined, null, '', 0, {}, {cause: {}}]) {
			expect(() => isInsufficientFunds(value)).not.toThrow();
		}
	});

	it('does not loop forever on a cyclic cause chain', () => {
		const a: {cause?: unknown; message: string} = {message: 'nope'};
		a.cause = a;
		expect(isInsufficientFunds(a)).toBe(false);
	});
});
