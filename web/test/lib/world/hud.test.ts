import {describe, it, expect} from 'vitest';
import {get, writable} from 'svelte/store';
import {
	createHud,
	describeMissedReveal,
	describeRound,
	describeSetup,
	purchaseBusyLabel,
} from '$lib/world/ui/hud';
import type {Context} from '$lib/context/types';
import {SignerOutOfFundsError} from '$lib/world/errors';
import type {RoundState} from '$lib/game/core/round';
import type {Action} from '$lib/world/commit-reveal';
import type {DepositedAvatar} from '$lib/world/deposited';
import type {RevealOutcome} from '$lib/world/reveal-outcome';
import type {RoundPhase} from '$lib/context/game';

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

/**
 * The situation the round is ABOUT, which the round state cannot say for itself.
 * Standing in the world is the ordinary case; the cases where it is not are
 * their own describe block below.
 */
const inTheWorld = {inWorld: true} as const;

describe('what the HUD says about a failed round', () => {
	it('names the gas problem, not the transaction, when the signer is empty', () => {
		const commit = describeRound(
			failed('commit', new SignerOutOfFundsError(new Error('whatever'))),
			inTheWorld,
		);
		expect(commit.label).toBe(
			'Your moves could not be sent: no gas left to play with.',
		);
		expect(commit.tone).toBe('bad');

		const reveal = describeRound(
			failed('reveal', new SignerOutOfFundsError(new Error('whatever'))),
			inTheWorld,
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
			inTheWorld,
		);
		expect(label).not.toMatch(/this account/i);
		expect(label).toMatch(/gas/i);
	});

	it('reports any other failure as itself, with the message', () => {
		// Including a revert that mentions funds. The remedy on offer must follow
		// what the boundary decided, not what the text happens to say.
		const {label, tone} = describeRound(
			failed('commit', new Error('execution reverted: insufficient funds')),
			inTheWorld,
		);
		expect(label).toBe('Commit failed: execution reverted: insufficient funds');
		expect(label).not.toMatch(/no gas left/);
		expect(tone).toBe('bad');
	});

	it('tells the player to retry a failed reveal before the phase ends', () => {
		const {label} = describeRound(
			failed('reveal', new Error('nonce too low')),
			inTheWorld,
		);
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
		const {label, tone} = describeRound(
			{step: 'Missed', epoch: 7} as unknown as State,
			inTheWorld,
		);
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

	it('says the one transaction also funds the play key', () => {
		// The prompt is for more than the price, and the player is entitled to
		// know that before they approve it rather than after.
		const detail = describeSetup({step: 'deposit'})?.detail ?? '';
		expect(detail).toMatch(/one transaction/i);
		expect(detail).toMatch(/funds the key/i);
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
		purchase?: {step: string; message?: string; authorisation?: string};
		canExit?: boolean;
		revealOutcome?: RevealOutcome;
		phase?: RoundPhase;
		twoPhase?: {phase: 'play' | 'wait'; timeLeft: number; duration: number};
		numMissesAllowed?: number;
	} = {},
) {
	return {
		hasLocalSigner: overrides.hasLocalSigner ?? true,
		game: {
			twoPhase: writable(
				overrides.twoPhase ?? {phase: 'play', timeLeft: 10, duration: 20},
			),
			phase: writable(overrides.phase ?? 'play'),
			round: writable(round),
			planning: {
				movesLeft: writable(10),
				plan: writable({planned: []}),
				canExit: writable(overrides.canExit ?? false),
			},
			revealOutcome: writable(overrides.revealOutcome),
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
			config: {
				sale: {price: 10000000000n},
				numMissesAllowed: overrides.numMissesAllowed,
			},
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
		// And says where the way out is. Leaving is the one action with no cell to
		// click on, so without this the exit tile is scenery and the disabled
		// button beside it has no explanation.
		expect(model.instruction).toMatch(/exit tile/i);
		expect(model.canLeave).toBe(false);
	});

	it('tells an avatar standing on the way out that it can leave', () => {
		const model = get(
			createHud(
				fakeContext(
					{step: 'Idle'},
					{currentPosition: {x: 3, y: 5}, canExit: true},
				),
			),
		);
		expect(model.canLeave).toBe(true);
		expect(model.instruction).toMatch(/leave the world/i);
	});
});

describe('an avatar that is not in the world', () => {
	/**
	 * Everything on screen was written for an avatar standing somewhere. Out of
	 * the world it read as a set of small lies: a clock saying "make your move"
	 * to something that cannot take a step, a move allowance for moves it cannot
	 * spend, and a round panel reporting "nothing planned" when what is missing
	 * is the avatar itself.
	 */
	it('asks for a spawn rather than a move, on the clock', () => {
		const out = get(createHud(fakeContext({step: 'Idle'})));
		expect(out.phaseLabel).toBe('Choose where to appear');

		const inWorld = get(
			createHud(fakeContext({step: 'Idle'}, {currentPosition: {x: 1, y: 1}})),
		);
		expect(inWorld.phaseLabel).toBe('Make your move');
	});

	it('does not offer a move allowance to something that cannot move', () => {
		const out = get(createHud(fakeContext({step: 'Idle'})));
		expect(out.avatarLine).toMatch(/not in the world/i);
		expect(out.avatarLine).not.toMatch(/moves? left/i);

		const inWorld = get(
			createHud(fakeContext({step: 'Idle'}, {currentPosition: {x: 1, y: 1}})),
		);
		expect(inWorld.avatarLine).toMatch(/10 moves left/);
	});

	it('says what is missing in the round panel, rather than "nothing planned"', () => {
		expect(
			describeRound({step: 'Idle'} as unknown as State, {inWorld: false}).label,
		).toMatch(/not in the world/i);
		expect(
			describeRound({step: 'Idle'} as unknown as State, inTheWorld).label,
		).toBe('Nothing planned');
	});

	it('calls a planned entry what it is', () => {
		const planning = {
			step: 'Planning',
			epoch: 3,
			actions: [action],
		} as unknown as State;
		expect(describeRound(planning, {inWorld: false}).label).toMatch(
			/where to appear/i,
		);
		expect(describeRound(planning, inTheWorld).label).toBe(
			'Planned, not yet committed',
		);
	});
});

describe('the four parts of a round, on the clock', () => {
	/**
	 * The old model folded the commit lock and the reveal into one "wait" and
	 * had no word at all for the catch-up. Each part now has its own label,
	 * its own instruction, and its own idea of whether a countdown exists.
	 */
	it('names each part, so a debugging player can tell which one they are in', () => {
		const label = (phase: RoundPhase) =>
			get(
				createHud(
					fakeContext({step: 'Idle'}, {currentPosition: {x: 1, y: 1}, phase}),
				),
			).phaseLabel;

		expect(label('play')).toBe('Make your move');
		expect(label('commit')).toBe('Committing this round');
		expect(label('reveal')).toBe('Revealing moves');
		expect(label('catching-up')).toBe('Catching up on last round');
	});

	it('says moves are closed outside the play window, rather than letting clicks look broken', () => {
		const instruction = (phase: RoundPhase) =>
			get(
				createHud(
					fakeContext({step: 'Idle'}, {currentPosition: {x: 1, y: 1}, phase}),
				),
			).instruction;

		expect(instruction('play')).toMatch(/step onto it/);
		for (const phase of ['commit', 'reveal', 'catching-up'] as const) {
			expect(instruction(phase)).toMatch(/nothing can be planned/i);
		}
	});

	it('counts the whole wait as one, from the lock through the reveal', () => {
		// A player does not care which step of the wait they are in, only when
		// they can play again, so the countdown spans both: it does not restart
		// when the lock hands over to the reveal.
		const waiting = get(
			createHud(
				fakeContext(
					{step: 'Idle'},
					{
						currentPosition: {x: 1, y: 1},
						phase: 'reveal',
						twoPhase: {phase: 'wait', timeLeft: 12, duration: 20.2},
					},
				),
			),
		);
		expect(waiting.secondsLeft).toBe(12);
		expect(waiting.progress).toBeCloseTo(1 - 12 / 20.2);
	});

	it('shows the play-window countdown while catching up, and drops the label the moment data lands', () => {
		// Catch-up happens INSIDE the play window - it is why the window is not
		// yet usable - so the countdown it shows is the window's own: "when can
		// I move" keeps ticking the whole time, and only the label changes when
		// the fetch lands.
		const catchingUp = get(
			createHud(
				fakeContext(
					{step: 'Idle'},
					{currentPosition: {x: 1, y: 1}, phase: 'catching-up'},
				),
			),
		);
		expect(catchingUp.secondsLeft).toBe(10);
		expect(catchingUp.phaseLabel).toBe('Catching up on last round');

		const playing = get(
			createHud(fakeContext({step: 'Idle'}, {currentPosition: {x: 1, y: 1}})),
		);
		expect(playing.secondsLeft).toBe(10);
		expect(playing.phaseLabel).toBe('Make your move');
	});

	it('does not invite a move the player cannot make, during setup in the play window', () => {
		// The setup override applies to the window that matters: while they are
		// still being set up, the play window is "a clock is running" rather than
		// an invitation. The other three parts are named as themselves either way.
		const model = get(
			createHud(
				fakeContext({step: 'Idle'}, {setup: {step: 'deposit'}, phase: 'play'}),
			),
		);
		expect(model.phaseLabel).toBe('Round in progress');
		const resolving = get(
			createHud(
				fakeContext(
					{step: 'Idle'},
					{setup: {step: 'deposit'}, phase: 'reveal'},
				),
			),
		);
		expect(resolving.phaseLabel).toBe('Revealing moves');
	});
});

describe('what the reveal actually did', () => {
	/**
	 * It said "Revealed. Your avatar has moved." after EVERY reveal. The round
	 * that commits itself when nothing is planned - which is how an idle avatar
	 * stays alive - therefore told a player standing still that they had moved,
	 * once an epoch, forever. So did the turn that left the world, about an
	 * avatar that is no longer on the board.
	 */
	const revealed = {step: 'Revealed', epoch: 3} as unknown as State;

	it('names each outcome, and claims movement only for a turn that moved', () => {
		const label = (outcome: RevealOutcome) =>
			describeRound(revealed, {inWorld: true, outcome}).label;
		expect(label('moved')).toMatch(/has moved/);
		expect(label('stayed')).toMatch(/stayed where it was/);
		expect(label('stayed')).not.toMatch(/has moved/);
		expect(label('entered')).toMatch(/is in the world/);
		expect(label('left')).toMatch(/left the world/);
		expect(label('left')).not.toMatch(/has moved/);
	});

	it('says only that the turn landed when it did not watch it happen', () => {
		// A page opened after the reveal cannot know what was in it: the round
		// drops the actions when it flips to `Revealed`. Guessing "moved" is how
		// this went wrong in the first place.
		const {label, tone} = describeRound(revealed, {inWorld: true});
		expect(label).toMatch(/on chain/i);
		expect(label).not.toMatch(/has moved/);
		expect(tone).toBe('good');
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

	it('explains WHY, from the rule the deployment configures', () => {
		// A notice that only says "your avatar died" leaves the player to guess
		// between being killed, being cheated, and a bug. The answer here is none
		// of those - they stopped playing - and nothing on chain will ever say so,
		// because `life` is computed and no event is emitted.
		const model = get(
			createHud(
				fakeContext(
					{step: 'Idle'},
					{
						avatars: [avatar({life: 0, inGame: true, lastEpoch: 2n})],
						currentEpoch: 3,
						numMissesAllowed: 3,
					},
				),
			),
		);
		expect(model.died?.cause).toEqual({kind: 'silence', rounds: 4});
		expect(model.died?.explanation).toMatch(/4 rounds in a row/);
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
	it('names each of the three waits differently', () => {
		// They are different kinds of wait: one the player must answer, one they
		// have paid for and are waiting on, and one sent on their behalf with no
		// prompt at all. A single "Buying..." across all three makes the last one
		// look like a hang, after the money has already gone.
		const labels = (['Authorising', 'Purchasing', 'Registering'] as const).map(
			(step) =>
				get(
					createHud(
						fakeContext(
							{step: 'Idle'},
							{
								setup: {step: 'deposit'},
								purchase: {step, authorisation: 'live-signature'},
							},
						),
					),
				).setup?.busyLabel,
		);
		expect(new Set(labels).size).toBe(3);
		for (const label of labels) expect(label).toBeTruthy();
		// The one nobody was prompted for has to explain itself.
		expect(labels[2]).toMatch(/play key/i);
	});

	it('only sends the player to their wallet when a wallet will open', () => {
		// It said "Confirm in your wallet" for every route, under a comment claiming
		// a hosted account never reached this step. It does reach it - its
		// credential is simply handed back without a prompt - so the player was
		// being pointed at a window that was never going to appear, while the thing
		// they were waiting for had already finished.
		expect(
			purchaseBusyLabel({step: 'Authorising', authorisation: 'live-signature'}),
		).toMatch(/in your wallet/i);
		for (const authorisation of ['pre-signed', 'silent-signature'] as const) {
			const label = purchaseBusyLabel({step: 'Authorising', authorisation});
			expect(label).toBeTruthy();
			expect(label).not.toMatch(/wallet/i);
		}
	});

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
