import {describe, it, expect} from 'vitest';
import {setupNeeded} from '$lib/context/game';
import type {DelegationValue} from '$lib/onchain/delegation';
import type {DepositedState} from '$lib/world/deposited';

/**
 * The gate in front of a player's first move.
 *
 * Two opposite failures, both invisible from reading it. Too LOOSE and the
 * board invites a turn that cannot be committed: `commit` resolves the sender
 * against the account's registered delegates and reverts with `NotDelegate`, so
 * an unauthorised browser lets someone plan a whole round and then fails as the
 * phase closes, which is when it is too late to fix. Too STRICT and it hides a
 * perfectly playable board behind a demand the player has already met - and
 * since both answers arrive from chain reads, the obvious way to get that wrong
 * is to treat "not read yet" as "no".
 *
 * The delegation answer is a FIELD, not an address comparison. The read is
 * scoped to the (account, this browser's signer) pair, so it says whether THIS
 * browser may play; an account may authorise several, and no single address the
 * chain could return would have been an answer about this one.
 *
 * The step order is the other decision here, and it inverted once buying an
 * avatar started carrying the authorisation with it: `purchase` funds the
 * signer in the same call and the signer registers itself out of that stipend,
 * so asking to authorise FIRST would demand a transaction the next step
 * includes. `authorise` is still reachable for the player who already has an
 * avatar and is opening a second browser.
 */

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;

const authorised: DelegationValue = {
	step: 'Loaded',
	allowed: true,
	withdrawn: false,
};

const withAvatar: DepositedState = {
	step: 'Loaded',
	avatars: [
		{avatarID: 1n, inGame: false, position: 0n, lastEpoch: 0n, life: 3},
	],
};

const noAvatar: DepositedState = {step: 'Loaded', avatars: []};

describe('what stands between a player and their first move', () => {
	it('asks to sign in before anything else', () => {
		expect(
			setupNeeded({
				identity: undefined,
				delegation: {step: 'Unloaded'} as DelegationValue,
				deposited: {step: 'Unloaded'},
			}),
		).toEqual({step: 'sign-in'});
	});

	it('asks to authorise a browser the account has not authorised', () => {
		// Only once there is an avatar: with one already owned there is no purchase
		// left to fold the authorisation into, so it has to be asked for on its
		// own. This is the second-browser case.
		expect(
			setupNeeded({
				identity: ACCOUNT,
				delegation: {step: 'Loaded', allowed: false, withdrawn: false},
				deposited: withAvatar,
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
				delegation: {step: 'Unloaded'} as DelegationValue,
				deposited: withAvatar,
			}),
		).toBeUndefined();
	});

	it('does NOT ask for an avatar while the avatars are still being read', () => {
		// Same mistake on the other read, and it is the more tempting one because
		// "no avatars yet" and "an empty list" look alike from the call site.
		expect(
			setupNeeded({
				identity: ACCOUNT,
				delegation: authorised,
				deposited: {step: 'Loading'},
			}),
		).toBeUndefined();
	});

	it('asks a brand new player for an avatar, NOT to authorise first', () => {
		// The inversion, pinned. A new player is unauthorised AND has no avatar,
		// and buying one does both: the purchase forwards a stipend to the signer
		// and the signer registers itself out of it. Asking to authorise here
		// would be asking for a transaction the very next step includes, which is
		// the two-transaction onboarding this replaced.
		expect(
			setupNeeded({
				identity: ACCOUNT,
				delegation: {step: 'Loaded', allowed: false, withdrawn: false},
				deposited: noAvatar,
			}),
		).toEqual({step: 'deposit'});
	});

	it('asks for an avatar when the browser is already authorised too', () => {
		expect(
			setupNeeded({
				identity: ACCOUNT,
				delegation: authorised,
				deposited: noAvatar,
			}),
		).toEqual({step: 'deposit'});
	});

	it('gets out of the way once both are done', () => {
		expect(
			setupNeeded({
				identity: ACCOUNT,
				delegation: authorised,
				deposited: withAvatar,
			}),
		).toBeUndefined();
	});

	it('asks again once the authorisation is withdrawn', () => {
		// Withdrawn with an avatar still in the game, which is the only shape this
		// can take now that buying covers authorisation.
		// Revoking is offered in the account panel, and it can happen in another
		// tab. The gate is derived from the live read rather than decided once at
		// startup, so the board goes back to asking instead of failing later.
		//
		// Withdrawn is per delegate, so this is THIS browser being withdrawn, not
		// the account giving up on delegation: the remedy is still to authorise,
		// and the route it takes (a transaction from the owner rather than a
		// signature) is decided further in. See ui/delegation/registration.
		expect(
			setupNeeded({
				identity: ACCOUNT,
				delegation: {step: 'Loaded', allowed: false, withdrawn: true},
				deposited: withAvatar,
			}),
		).toEqual({step: 'authorise'});
	});
});
