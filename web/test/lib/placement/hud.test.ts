import {describe, it, expect} from 'vitest';
import {get, writable} from 'svelte/store';
import {createHud, describeRound} from '$lib/placement/ui/hud';
import type {Context} from '$lib/context/types';
import {SignerOutOfFundsError} from '$lib/placement/errors';
import type {RoundState} from '$lib/game/core/round';
import type {Placement} from '$lib/placement/commit-reveal';

/**
 * What the player is TOLD, which is the only part of a failure they can act on.
 *
 * These branches were uncovered until the classifier moved upstream, and the
 * gap was invisible: the strings are right there in the source and reading them
 * proves nothing about which one is reached. The distinction being pinned here
 * is between a failure with a remedy (the signer has no gas: top it up and the
 * round carries on by itself) and one without, because sending a player to buy
 * gas they already have is worse than telling them nothing.
 */

type State = RoundState<Placement>;

const failed = (during: 'commit' | 'reveal', error: unknown): State => ({
	step: 'Error',
	during,
	epoch: 3,
	actions: [{cellID: 1n}],
	message: (error as Error).message,
	error,
});

describe('what the HUD says about a failed round', () => {
	it('names the gas problem, not the transaction, when the signer is empty', () => {
		const commit = describeRound(
			failed('commit', new SignerOutOfFundsError(new Error('whatever'))),
		);
		expect(commit.label).toBe(
			'Your moves could not be sent: no gas left to play with.',
		);
		expect(commit.tone).toBe('bad');

		const reveal = describeRound(
			failed('reveal', new SignerOutOfFundsError(new Error('whatever'))),
		);
		expect(reveal.label).toBe(
			'Your reveal could not be sent: no gas left to play with.',
		);
	});

	it("does not use upstream's wording, which names the wrong account", () => {
		// `INSUFFICIENT_FUNDS_SUMMARY` says "this account does not have enough
		// funds". True, and misleading here: the account is a signer the player
		// was never told about, so they read "this account" as their wallet and go
		// and look at a balance that is fine. The game names whose shortfall it is.
		const {label} = describeRound(
			failed('commit', new SignerOutOfFundsError(new Error('whatever'))),
		);
		expect(label).not.toMatch(/this account/i);
		expect(label).toMatch(/gas/i);
	});

	it('reports any other failure as itself, with the message', () => {
		// Including a revert that mentions funds. The remedy on offer must follow
		// what the boundary decided, not what the text happens to say.
		const {label, tone} = describeRound(
			failed('commit', new Error('execution reverted: insufficient funds')),
		);
		expect(label).toBe('Commit failed: execution reverted: insufficient funds');
		expect(label).not.toMatch(/no gas left/);
		expect(tone).toBe('bad');
	});

	it('tells the player to retry a failed reveal before the phase ends', () => {
		// The reveal is the one with a stake on it, and the window closes.
		const {label} = describeRound(failed('reveal', new Error('nonce too low')));
		expect(label).toBe(
			'Reveal failed: nonce too low. Retry before the phase ends.',
		);
	});

	it('says what a missed reveal cost, rather than that something went wrong', () => {
		const {label, tone} = describeRound({
			step: 'Missed',
			epoch: 7,
			actions: [{cellID: 1n}],
		} as unknown as State);
		expect(label).toBe('Missed the reveal for epoch 7. The bond is forfeit.');
		expect(tone).toBe('bad');
	});
});

/** A context with only the parts `createHud` reads. */
function fakeContext(round: State, hasLocalSigner = true) {
	return {
		hasLocalSigner,
		game: {
			twoPhase: writable({phase: 'play', timeLeft: 10, duration: 20}),
			round: writable(round),
			planning: {count: writable(1)},
			cost: writable(0n),
			reserve: writable({step: 'Loaded', amount: 100n}),
			epochInfo: writable({currentEpoch: 3}),
			missedReveal: writable({step: 'Clear'}),
			setup: writable(undefined),
		},
	} as unknown as Context;
}

describe('the remedy the HUD offers', () => {
	it('offers the top-up when the signer ran out of gas', () => {
		const model = get(
			createHud(
				fakeContext(
					failed('reveal', new SignerOutOfFundsError(new Error('empty'))),
				),
			),
		);

		expect(model.outOfGas).toBeDefined();
		expect(model.outOfGas?.detail).toMatch(/top it up/i);
	});

	it('offers NOTHING for a failure a top-up cannot fix', () => {
		// The offer is a button that spends money and then retries. Showing it for
		// a revert tells the player their stake is recoverable by paying, and it is
		// not: the move fails again identically. Silence is the honest answer.
		const model = get(
			createHud(
				fakeContext(
					failed(
						'reveal',
						new Error('execution reverted: insufficient funds for transfer'),
					),
				),
			),
		);

		expect(model.outOfGas).toBeUndefined();
	});
});

describe('what the HUD says when there is no local signer', () => {
	/**
	 * `hasLocalSigner` is `TARGET_STEP === 'SignedIn'`, and NOTHING ELSE.
	 *
	 * This notice used to read "No hosted sign-in is configured... Set
	 * PUBLIC_WALLET_HOST to play with a local signing key instead", which was
	 * wrong twice: hosted sign-in is a different axis entirely, and setting a
	 * wallet host does not produce a signer. A signer is derived from a wallet
	 * signature with no service involved, so signing in with no host at all is a
	 * complete configuration - core/connection/mode.ts says exactly that, and
	 * says of this very predicate "Deliberately NOT 'is PUBLIC_WALLET_HOST set'".
	 *
	 * Anyone who followed the old advice would have configured a wallet host and
	 * still had no signer. Pinned because it is a STRING: nothing else would
	 * catch it going wrong again.
	 */
	it('names the knob that actually controls it', () => {
		const model = get(
			createHud(fakeContext({step: 'Idle'} as unknown as State, false)),
		);
		expect(model.walletSigningNotice).toBeDefined();
		expect(model.walletSigningNotice).toContain('TARGET_STEP');
		expect(model.walletSigningNotice).toMatch(/does not sign in/i);
	});

	it('never blames hosted sign-in, which is a different axis', () => {
		const model = get(
			createHud(fakeContext({step: 'Idle'} as unknown as State, false)),
		);
		expect(model.walletSigningNotice).not.toMatch(/PUBLIC_WALLET_HOST/);
		expect(model.walletSigningNotice).not.toMatch(/hosted/i);
	});

	it('says nothing at all when the app does sign in', () => {
		const model = get(
			createHud(fakeContext({step: 'Idle'} as unknown as State)),
		);
		expect(model.walletSigningNotice).toBeUndefined();
	});
});
