import {describe, expect, it} from 'vitest';
import {zeroAddress} from 'viem';
import {createStakeAcquisition} from '$lib/placement/acquisition';
import type {PlacementConfig} from '$lib/placement/config';
import type {TypedDeployments} from '$lib/core/connection/types';

/**
 * Three arguments, two of which are addresses that mean opposite things.
 *
 * `GameAvatarSale.purchase(owner, stipendTo, stipend)` mints the avatar for
 * `owner` and forwards gas to `stipendTo`. Swapping them does not revert: it
 * buys the avatar for the local signing key, which is exactly the address that
 * must never own anything (it lives in one browser's storage, and clearing site
 * data would take the stake with it). That failure is why this list is a pure
 * function with a test rather than an inline array.
 *
 * THE SUITE IS UPSTREAM'S WITH THE CONTRACT'S NAME CHANGED, which is the point
 * being measured: what the rail needs from a sale is the same three arguments
 * and the same value split whether it sells a bond or mints a token.
 */

const SALE = '0x00000000000000000000000000000000000000fe' as const;
const PLAYER = '0x1111111111111111111111111111111111111111' as const;
const SIGNER = '0x2222222222222222222222222222222222222222' as const;

const config = {
	sale: {address: SALE, price: 7n, amount: 100n, stipend: 500n},
} as unknown as PlacementConfig;

const deployments = {
	contracts: {GameAvatarSale: {address: SALE, abi: []}},
} as unknown as TypedDeployments;

const acquisition = createStakeAcquisition({config, deployments});

describe('the arguments to GameAvatarSale.purchase', () => {
	it('credits the PLAYER and funds the signer, not the other way round', () => {
		const {args} = acquisition.request({
			owner: PLAYER,
			stipendTo: SIGNER,
			stipend: 500n,
		});
		expect(args[0]).toBe(PLAYER);
		expect(args[1]).toBe(SIGNER);
		expect(args[2]).toBe(500n);
	});

	it('sends the price PLUS the stipend, because the call carries both', () => {
		// The sale subtracts the stipend from `msg.value` and then requires the
		// remainder to equal the price exactly, so sizing the value from the price
		// alone reverts with `WrongPaymentAmount` on every attempt.
		const {value} = acquisition.request({
			owner: PLAYER,
			stipendTo: SIGNER,
			stipend: 500n,
		});
		expect(value).toBe(507n);
	});

	it('names nobody and forwards nothing when there is no signer', () => {
		// The contract refuses a stipend with nowhere to go rather than keeping
		// it, so these two have to move together. A build with no sign-in reaches
		// this, and so does a browser that is already a delegate.
		const {args, value} = acquisition.request({
			owner: PLAYER,
			stipendTo: undefined,
			stipend: 0n,
		});
		expect(args[1]).toBe(zeroAddress);
		expect(args[2]).toBe(0n);
		expect(value).toBe(7n);
	});

	it('is recognised in the ledger by the pair it is actually sent to', () => {
		// The rail builds the call from these two and matches the ledger with the
		// same two, so a recovered purchase after a reload cannot look for
		// something other than what was sent.
		expect(acquisition.address).toBe(SALE);
		expect(acquisition.functionName).toBe('purchase');
	});
});
