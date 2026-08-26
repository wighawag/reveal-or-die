import {describe, it, expect} from 'vitest';
import {get, writable} from 'svelte/store';
import {
	createHud,
	describeMissedReveal,
	describeRound,
	describeSetup,
} from '$lib/world/ui/hud';
import type {Context} from '$lib/context/types';
import {SignerOutOfFundsError} from '$lib/world/errors';
import type {RoundState} from '$lib/game/core/round';
import type {Action} from '$lib/world/commit-reveal';
import type {DepositedAvatar} from '$lib/world/deposited';

/**
 * What the player is TOLD, which is the only part of a failure they can act on.
 *
 * Carried over from the template's HUD, whose tests this replaces, plus the
 * three sentences that had to CHANGE in the port. Those are the interesting
 * ones: the template's HUD talks about a bond, and this game bonds nothing, so
 * every message inherited unexamined would have been a confident lie about the
 * player's money.
 */

type State = RoundState<Action>;

const action: Action = {actionType: 1, data: 1n};

const failed = (during: 'commit' | 'reveal', error: unknown): State => ({
	step: 'Error',
	during,
	epoch: 3,
	actions: [action],
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
		const {label} = describeRound(failed('reveal', new Error('nonce too low')));
		expect(label).toBe(
			'Reveal failed: nonce too low. Retry before the phase ends.',
		);
	});
});

describe('what a missed reveal actually costs, in this game', () => {
	/**
	 * The template says "The bond is forfeit", because its
	 * `acknowledgeMissedReveal` burns one. This contract's carries a
	 * `TODO burn / stake` and forfeits NOTHING, so the same sentence here would
	 * tell a player they had lost money they still have. What it really costs is
	 * the turn plus every following one until the stale commitment is cleared,
	 * which is a thing they can act on.
	 */
	it('reports being blocked, not a forfeit', () => {
		const {label, tone} = describeRound({
			step: 'Missed',
			epoch: 7,
		} as unknown as State);
		expect(label).toMatch(/epoch 7/);
		expect(label).not.toMatch(/bond|forfeit/i);
		expect(label).toMatch(/blocked until you acknowledge it/);
		expect(tone).toBe('bad');
	});

	it('says the same about the commitment the chain is still holding', () => {
		const blocked = describeMissedReveal({step: 'Blocked', epoch: 4});
		expect(blocked?.headline).toMatch(/epoch 4/);
		expect(blocked?.detail).not.toMatch(/bond|forfeit/i);
		expect(blocked?.detail).toMatch(/refuse every new commitment/);
		expect(blocked?.canAcknowledge).toBe(true);
	});

	it('still offers the button after a failed acknowledgement', () => {
		// The commitment is exactly where it was, so treating the failure as
		// "clear" would let the round commit and be refused on chain, which costs
		// gas to learn nothing.
		const state = describeMissedReveal({
			step: 'Failed',
			epoch: 4,
			error: new Error('nope'),
		});
		expect(state?.canAcknowledge).toBe(true);
		expect(state?.busy).toBe(false);
	});

	it('says nothing when there is nothing outstanding', () => {
		expect(describeMissedReveal({step: 'Clear'})).toBeUndefined();
		expect(describeMissedReveal({step: 'Unknown'})).toBeUndefined();
	});
});

describe('what the setup gate asks for', () => {
	it('offers a button only for the step that has one', () => {
		// `authorise` goes through the top-up flow, which registers the delegate
		// and funds it in one transaction.
		expect(describeSetup({step: 'authorise'})?.action).toBe('authorise');
		expect(describeSetup({step: 'sign-in'})?.action).toBeUndefined();
	});

	it('offers the purchase for the avatar step, with the price on it', () => {
		// The price is EXACT, not a minimum: `SaleViaNativePayment.purchase`
		// reverts with `WrongPaymentAmount` on anything else, including too much.
		// Worth putting on the button rather than leaving to the wallet.
		const setup = describeSetup({step: 'deposit'}, {priceLabel: '0.00001 ETH'});
		expect(setup?.action).toBe('buy');
		expect(setup?.actionLabel).toBe('Buy an avatar for 0.00001 ETH');
	});

	it('says the avatar will NOT arrive in the wallet', () => {
		// "Buy" suggests an NFT lands in your wallet. It does not: purchase mints
		// straight into the Game, which is what having it at stake means. Someone
		// expecting to see it in their wallet should be told beforehand rather
		// than go looking for it.
		const detail = describeSetup({step: 'deposit'})?.detail ?? '';
		expect(detail).toMatch(/straight into the game/i);
		expect(detail).toMatch(/not appear in your wallet/i);
	});

	it('never promises the avatar can be taken away', () => {
		// "Authorise" is the word every drainer uses, so the sentence has to say
		// what the permission does NOT cover. The contract enforces it: withdraw
		// resolves the owner, not the delegate.
		expect(describeSetup({step: 'authorise'})?.detail).toMatch(
			/never withdraw your avatars/,
		);
	});
});

const avatar = (o: Partial<DepositedAvatar> = {}): DepositedAvatar => ({
	avatarID: 1n,
	inGame: false,
	position: 0n,
	lastEpoch: 0n,
	life: 3,
	...o,
});

/** A context with only the parts `createHud` reads. */
function fakeContext(
	round: State,
	overrides: {
		hasLocalSigner?: boolean;
		avatars?: DepositedAvatar[];
		activeAvatarID?: bigint;
		currentPosition?: {x: number; y: number};
		currentEpoch?: number;
		setup?: {step: 'sign-in' | 'authorise' | 'deposit'};
		purchase?: {step: string; message?: string};
	} = {},
) {
	return {
		hasLocalSigner: overrides.hasLocalSigner ?? true,
		game: {
			twoPhase: writable({phase: 'play', timeLeft: 10, duration: 20}),
			round: writable(round),
			planning: {
				movesLeft: writable(10),
				plan: writable({planned: []}),
			},
			deposited: writable({
				step: 'Loaded',
				avatars: overrides.avatars ?? [avatar()],
			}),
			activeAvatarID: writable(overrides.activeAvatarID ?? 1n),
			currentPosition: writable(overrides.currentPosition),
			epochInfo: writable({currentEpoch: overrides.currentEpoch ?? 3}),
			missedReveal: writable({step: 'Clear'}),
			setup: writable(overrides.setup),
			purchase: writable(overrides.purchase ?? {step: 'Idle'}),
			config: {sale: {price: 10000000000n}},
		},
		deployments: {get: () => ({chain: {nativeCurrency: {symbol: 'ETH'}}})},
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
		// a revert tells the player their turn is recoverable by paying, and it is
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

describe('what a click will do', () => {
	it('tells an avatar that is out of the world to pick a spawn, and says it ends the turn', () => {
		// `_enter` sets `stopProcessing`, so anything planned after an Enter is
		// silently dropped by the reveal. The player has no way to discover that
		// except by being told.
		const model = get(createHud(fakeContext({step: 'Idle'})));
		expect(model.inWorld).toBe(false);
		expect(model.instruction).toMatch(/where to appear/);
		expect(model.instruction).toMatch(/whole turn/);
	});

	it('tells an avatar in the world that only a legal step is accepted', () => {
		const model = get(
			createHud(fakeContext({step: 'Idle'}, {currentPosition: {x: 1, y: 1}})),
		);
		expect(model.inWorld).toBe(true);
		expect(model.instruction).toMatch(
			/stops processing at the first move it refuses/,
		);
	});
});

describe('a killed avatar', () => {
	/**
	 * Asked about the ACCOUNT, not about the active avatar, and that is the whole
	 * point. `chooseActiveAvatar` will not select a dead avatar, so "did the
	 * avatar I am playing die" is false from the instant it becomes true, and the
	 * pre-port notice would never have appeared once.
	 */
	it('is reported even though it is no longer the active one', () => {
		const model = get(
			createHud(
				fakeContext(
					{step: 'Idle'},
					{
						avatars: [
							avatar({avatarID: 1n, life: 0, inGame: true, lastEpoch: 2n}),
							avatar({avatarID: 2n}),
						],
						activeAvatarID: 2n,
						currentEpoch: 3,
					},
				),
			),
		);
		expect(model.died).toBeDefined();
	});

	it('is not reported until the epoch it died in has passed', () => {
		// `lastEpoch` is when it last acted, so the kill is only readable from the
		// next epoch onwards; reporting sooner would announce a death mid-round.
		const model = get(
			createHud(
				fakeContext(
					{step: 'Idle'},
					{
						avatars: [avatar({life: 0, inGame: true, lastEpoch: 3n})],
						currentEpoch: 3,
					},
				),
			),
		);
		expect(model.died).toBeUndefined();
	});
});

describe('what the HUD says when there is no local signer', () => {
	/**
	 * `hasLocalSigner` is `TARGET_STEP === 'SignedIn'`, and NOTHING ELSE.
	 *
	 * This notice used to read "No hosted sign-in is configured... Set
	 * PUBLIC_WALLET_HOST to play with a local signing key instead", which was
	 * wrong twice: hosted sign-in is a different axis entirely, and setting a
	 * wallet host does not produce a signer. Anyone who followed the old advice
	 * would have configured a wallet host and still had no signer. Pinned
	 * because it is a STRING: nothing else would catch it going wrong again.
	 */
	it('names the knob that actually controls it', () => {
		const model = get(
			createHud(fakeContext({step: 'Idle'}, {hasLocalSigner: false})),
		);
		expect(model.walletSigningNotice).toBeDefined();
		expect(model.walletSigningNotice).toContain('TARGET_STEP');
		expect(model.walletSigningNotice).toMatch(/does not sign in/i);
	});

	it('never blames hosted sign-in, which is a different axis', () => {
		const model = get(
			createHud(fakeContext({step: 'Idle'}, {hasLocalSigner: false})),
		);
		expect(model.walletSigningNotice).not.toMatch(/PUBLIC_WALLET_HOST/);
		expect(model.walletSigningNotice).not.toMatch(/hosted/i);
	});

	it('says nothing at all when the app does sign in', () => {
		const model = get(createHud(fakeContext({step: 'Idle'})));
		expect(model.walletSigningNotice).toBeUndefined();
	});
});

describe('buying an avatar, through the HUD', () => {
	it('reports the purchase in flight on the button itself', () => {
		// The player is being asked to sign in their wallet, which happens
		// somewhere this page cannot see. Without this the button looks idle and
		// invites a second press, and `subID` is random, so a second press buys a
		// SECOND avatar and charges again.
		const model = get(
			createHud(
				fakeContext(
					{step: 'Idle'},
					{setup: {step: 'deposit'}, purchase: {step: 'Purchasing'}},
				),
			),
		);
		expect(model.setup?.action).toBe('buy');
		expect(model.setup?.busy).toBe(true);
	});

	it('surfaces a failed purchase where the button is', () => {
		const model = get(
			createHud(
				fakeContext(
					{step: 'Idle'},
					{
						setup: {step: 'deposit'},
						purchase: {step: 'Error', message: 'user rejected'},
					},
				),
			),
		);
		expect(model.setup?.busy).toBe(false);
		expect(model.setup?.error).toBe('user rejected');
	});

	it('says nothing about a purchase on a step that is not the avatar one', () => {
		// `busy` and `error` belong to the buy button. Leaking them onto the
		// authorise step would show a purchase error over an unrelated demand.
		const model = get(
			createHud(
				fakeContext(
					{step: 'Idle'},
					{
						setup: {step: 'authorise'},
						purchase: {step: 'Error', message: 'user rejected'},
					},
				),
			),
		);
		expect(model.setup?.action).toBe('authorise');
		expect(model.setup?.error).toBeUndefined();
		expect(model.setup?.busy).toBeUndefined();
	});
});
