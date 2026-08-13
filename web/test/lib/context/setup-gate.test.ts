import {describe, it, expect} from 'vitest';
import {setupNeeded} from '$lib/context/game';
import type {DelegationValue} from '$lib/onchain/delegation';

/**
 * The gate in front of a player's first move.
 *
 * Two opposite failures, both invisible from reading it. Too LOOSE and the
 * board invites a turn that cannot be committed: `makeCommitment` resolves the
 * sender against the account's registered delegate and reverts with
 * `NotDelegate`, so an unauthorised browser lets someone plan a whole round and
 * then fails as the phase closes, which is when it is too late to fix. Too
 * STRICT and it hides a perfectly playable board behind a demand the player has
 * already met - and since the delegation answer arrives from a chain read, the
 * obvious way to get that wrong is to treat "not read yet" as "not allowed".
 */

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;
const SIGNER = '0x2222222222222222222222222222222222222222' as const;
const OTHER = '0x3333333333333333333333333333333333333333' as const;

const registered = (delegate: `0x${string}` = SIGNER): DelegationValue => ({
	step: 'Loaded',
	delegate,
	withdrawn: false,
});

const staked = {step: 'Loaded', amount: 100n};

describe('what stands between a player and their first move', () => {
	it('asks to sign in before anything else', () => {
		expect(
			setupNeeded({
				identity: undefined,
				signer: undefined,
				delegation: {step: 'Unloaded'} as DelegationValue,
				reserve: {step: 'Unloaded'},
			}),
		).toEqual({step: 'sign-in'});
	});

	it('asks to authorise a browser the account has not authorised', () => {
		expect(
			setupNeeded({
				identity: ACCOUNT,
				signer: SIGNER,
				delegation: registered(OTHER),
				reserve: staked,
			}),
		).toEqual({step: 'authorise'});
	});

	it('asks to authorise when nothing is registered at all', () => {
		expect(
			setupNeeded({
				identity: ACCOUNT,
				signer: SIGNER,
				delegation: {
					step: 'Loaded',
					delegate: '0x0000000000000000000000000000000000000000',
					withdrawn: false,
				},
				reserve: staked,
			}),
		).toEqual({step: 'authorise'});
	});

	it('does NOT ask while the answer is still being read', () => {
		// The strict-direction mistake, and the one that would ship: every load
		// starts Unloaded, so treating it as "not authorised" puts the gate over
		// the board of an authorised player, every single time, until the read
		// lands. It looks like a flicker and it is a lie.
		expect(
			setupNeeded({
				identity: ACCOUNT,
				signer: SIGNER,
				delegation: {step: 'Unloaded'} as DelegationValue,
				reserve: staked,
			}),
		).toBeUndefined();
	});

	it('asks to authorise BEFORE asking for a stake', () => {
		// Order is a real decision, not a tie-break. Both are wallet
		// transactions, and a player who abandons setup half way through should
		// have spent as little as possible: authorising costs gas, staking moves
		// tokens into a reserve. So the cheap one goes first.
		expect(
			setupNeeded({
				identity: ACCOUNT,
				signer: SIGNER,
				delegation: registered(OTHER),
				reserve: {step: 'Loaded', amount: 0n},
			}),
		).toEqual({step: 'authorise'});
	});

	it('asks for a stake once the browser may play', () => {
		expect(
			setupNeeded({
				identity: ACCOUNT,
				signer: SIGNER,
				delegation: registered(),
				reserve: {step: 'Loaded', amount: 0n},
			}),
		).toEqual({step: 'stake'});
	});

	it('gets out of the way once both are done', () => {
		expect(
			setupNeeded({
				identity: ACCOUNT,
				signer: SIGNER,
				delegation: registered(),
				reserve: staked,
			}),
		).toBeUndefined();
	});

	it('asks again if the authorisation is withdrawn and the delegate changes', () => {
		// Revoking is offered in the account panel, and it can happen in another
		// tab. The gate is derived from the live read rather than decided once at
		// startup, so the board goes back to asking instead of failing later.
		expect(
			setupNeeded({
				identity: ACCOUNT,
				signer: SIGNER,
				delegation: {step: 'Loaded', delegate: OTHER, withdrawn: true},
				reserve: staked,
			}),
		).toEqual({step: 'authorise'});
	});
});
