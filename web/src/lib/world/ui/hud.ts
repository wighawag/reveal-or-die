/**
 * Everything the HUD renders, as one derived store.
 *
 * The components that show this are deliberately logic-less: they take a
 * finished model and lay it out. All the deciding - which phase label to show,
 * whether committing is still possible, what a failure means - happens here, in
 * plain TypeScript that can be read and tested without a browser.
 *
 * Ported from the template's `placement/ui/hud.ts`, and the differences are all
 * the same difference: what is at stake here is an AVATAR the contract holds,
 * not a token reserve bonded per round. So there is no cost and no reserve
 * line, the setup gate ends in "deposit" rather than "stake", and a missed
 * reveal is reported as something that BLOCKS play rather than as a forfeit,
 * because `_acknowledgeMissedReveal` currently burns nothing.
 */
import {derived, type Readable} from 'svelte/store';
import type {Context} from '$lib/context/types';
import type {RoundState} from '$lib/game/core/round';

import type {Action} from '../commit-reveal';
import type {DepositedState} from '../deposited';
import {blocksCommitting, type MissedRevealState} from '../missed-reveal';
import {SignerOutOfFundsError} from '../errors';
import type {SetupAction, SetupNeeded} from '$lib/context/game';
import type {PurchaseState} from '../purchase';
import {purchaseValue} from 'reveal-or-die-contracts';
import {formatBalance} from '$lib/core/utils/format/balance';

/** One avatar the player could switch to. */
export type AvatarChoice = {
	avatarID: bigint;
	/** Short enough to fit on a button: an avatar id is an address plus 96 bits. */
	label: string;
	inGame: boolean;
	life: number;
	active: boolean;
};

export type HudModel = {
	phaseLabel: string;
	/**
	 * Two phases, not three.
	 *
	 * The contract has a commit phase and a reveal phase, and the client adds a
	 * third slice at the end of the commit phase where moves are locked so the
	 * commitment has time to land. Three states is one more than the player has
	 * a decision about: what they need to know is whether this round is still
	 * theirs to change.
	 */
	phase: 'play' | 'wait';
	/** Seconds left in the phase, already rounded for display. */
	secondsLeft: number;
	/** How far through the phase, 0..1, for a progress dial. */
	progress: number;
	epoch: number;
	/**
	 * Clicking now plans for the NEXT round, because this one has closed. Worth
	 * saying: the moves still appear on the board, and without this the player
	 * would reasonably think they were part of the round being resolved.
	 */
	planningForNextRound: boolean;
	/**
	 * Set when this build has NO LOCAL SIGNER, so every move has to be signed in
	 * the wallet. Said once, up front, rather than discovered one prompt at a
	 * time.
	 */
	walletSigningNotice?: string;
	/**
	 * Set while the player cannot take a turn yet. The HUD shows THIS instead of
	 * the planning controls: offering "plan your moves" to someone with no avatar
	 * invites them to lay out a whole turn that cannot be committed, and the
	 * failure only arrives when the round is already closing.
	 */
	setup?: {
		headline: string;
		detail: string;
		action?: SetupAction;
		/** The words on the button, which for a purchase carry the price. */
		actionLabel?: string;
		/** The purchase is in flight, so the button says so and does nothing. */
		busy?: boolean;
		/**
		 * What it is doing, while it is busy.
		 *
		 * The step matters to the player because they are different KINDS of wait:
		 * a signature they have to answer, a transaction they have paid for and
		 * are waiting on, and a third one being sent on their behalf that they
		 * were never prompted for. One spinner reading "Buying..." across all
		 * three makes the last look like a hang.
		 */
		busyLabel?: string;
		/** Set when the last attempt failed, in words the player can act on. */
		error?: string;
	};

	/** Which avatar this client is playing, and which others it could play. */
	avatarLabel?: string;
	avatarChoices: readonly AvatarChoice[];
	/** In the world already, so a click is a step rather than a spawn. */
	inWorld: boolean;
	/**
	 * One of this account's avatars has been killed and is still standing in the
	 * world.
	 *
	 * NOT "the active avatar died", which is what the pre-port UI asked. It cannot
	 * be: `chooseActiveAvatar` refuses a dead avatar, so by the time the death is
	 * readable the active one has already moved on and the question answers itself
	 * negatively forever. Asked about the ACCOUNT instead, which is the fact that
	 * is actually true and stays true until the body is withdrawn.
	 *
	 * Read from the account's own avatars rather than off the board, which is
	 * camera-scoped: a player who panned away would not be told.
	 */
	died?: {label: string};

	/** How many actions are planned, and how many moves the turn has left. */
	plannedCount: number;
	movesLeft: number;
	/** What a click will do right now, in one line. */
	instruction: string;

	roundLabel: string;
	roundTone: 'idle' | 'busy' | 'good' | 'bad';
	canCommit: boolean;
	canReveal: boolean;
	canClear: boolean;
	/**
	 * Set when the move failed because the key that signs moves has no gas.
	 * The one failure the player can fix, so it is named and given a button
	 * rather than left as a transaction error.
	 */
	outOfGas?: {detail: string};

	/**
	 * Set when an unrevealed commitment is blocking play, with what has to be
	 * done about it.
	 */
	missedReveal?: {
		headline: string;
		detail: string;
		busy: boolean;
		canAcknowledge: boolean;
	};
};

/** An avatar id is an address shifted left 96 bits; show the tail of it. */
export function avatarLabel(avatarID: bigint): string {
	return `#${(avatarID & 0xffffffffn).toString(16).padStart(8, '0')}`;
}

export function describeRound(state: RoundState<Action>): {
	label: string;
	tone: HudModel['roundTone'];
} {
	switch (state.step) {
		case 'Idle':
			return {label: 'Nothing planned', tone: 'idle'};
		case 'Planning':
			return {label: 'Planned, not yet committed', tone: 'idle'};
		case 'Committing':
			return {label: 'Sending commitment...', tone: 'busy'};
		case 'Committed':
			return {label: 'Committed. Reveal is owed this epoch.', tone: 'busy'};
		case 'Revealing':
			return {label: 'Revealing...', tone: 'busy'};
		case 'Revealed':
			return {label: 'Revealed. Your avatar has moved.', tone: 'good'};
		case 'Missed':
			return {
				// NOT "the bond is forfeit", which is what the template says here.
				// This game bonds nothing per round, so claiming a loss would be a
				// lie; what it actually costs is the turn AND the next one, until the
				// commitment is acknowledged. That is the part worth stating.
				label: `Missed the reveal for epoch ${state.epoch}. Those moves are lost, and the next round is blocked until you acknowledge it.`,
				tone: 'bad',
			};
		case 'Error':
			// The type, not upstream's classifier: by the time an error reaches the
			// round it has been through `send()` in ../commit-reveal, which is where
			// the node's wording is read. Asking again here would re-derive an
			// answer the app already committed to, and could disagree with it.
			if (state.error instanceof SignerOutOfFundsError) {
				return {
					// NOT `INSUFFICIENT_FUNDS_SUMMARY`, though the barrel exports it and
					// it says the same thing about the same failure. Upstream's sentence
					// is "this account does not have enough funds", which is exactly
					// right for a transaction the player initiated from their wallet and
					// wrong here: the account is a signer they were never told about, so
					// "this account" reads as their wallet, which is probably funded.
					// Upstream names the failure; the game names whose it is.
					label:
						state.during === 'commit'
							? 'Your moves could not be sent: no gas left to play with.'
							: 'Your reveal could not be sent: no gas left to play with.',
					tone: 'bad',
				};
			}
			return {
				label:
					state.during === 'commit'
						? `Commit failed: ${state.message}`
						: `Reveal failed: ${state.message}. Retry before the phase ends.`,
				tone: 'bad',
			};
	}
}

/**
 * What to tell the player about a commitment they never revealed.
 *
 * Phrased as a blockage rather than a loss, which is the honest reading of this
 * contract: `_acknowledgeMissedReveal` carries a `TODO burn / stake` and
 * forfeits nothing, so the only consequence is that `_makeCommitment` keeps
 * rejecting new commitments with `PreviousCommitmentNotRevealed` until it is
 * called. If a forfeit is added, this sentence is where it gets said.
 */
export function describeMissedReveal(
	state: MissedRevealState,
): HudModel['missedReveal'] {
	if (state.step === 'Clear' || state.step === 'Unknown') return undefined;

	const headline = `You never revealed your moves for epoch ${state.epoch}.`;

	if (state.step === 'Acknowledging') {
		return {
			headline,
			detail: 'Acknowledging...',
			busy: true,
			canAcknowledge: false,
		};
	}
	if (state.step === 'Failed') {
		return {
			headline,
			// The commitment is exactly where it was, so this is still a blockage
			// and the button still has something to do.
			detail: 'That could not be acknowledged. Try again.',
			busy: false,
			canAcknowledge: true,
		};
	}
	return {
		headline,
		detail:
			'Those moves are gone, and the contract will refuse every new commitment until the old one is cleared.',
		busy: false,
		canAcknowledge: true,
	};
}

/**
 * What the purchase is doing right now, in the player's terms.
 *
 * Three waits that feel different: one they must answer, one they have paid for,
 * and one sent on their behalf without a prompt.
 */
export function purchaseBusyLabel(state: PurchaseState): string | undefined {
	switch (state.step) {
		case 'Authorising':
			// A hosted account never sees this: its credential was minted at
			// sign-in, so `fetchDelegation` returns without prompting.
			return 'Confirm in your wallet to authorise this browser...';
		case 'Purchasing':
			return 'Buying your avatar...';
		case 'ChoosingPayer':
			return 'Choose how to pay...';
		case 'Consent':
			return 'Confirm to continue...';
		case 'Registering':
			// No prompt for this one: the signer sends it itself, out of the stipend
			// the purchase just gave it. Unexplained it looks like a hang after the
			// money has already gone.
			return 'Setting up your play key...';
		default:
			return undefined;
	}
}

/** What the player has to do before they can take a turn. */
export function describeSetup(
	setup: SetupNeeded | undefined,
	options?: {priceLabel?: string; busyLabel?: string},
): HudModel['setup'] {
	if (!setup) return undefined;
	switch (setup.step) {
		case 'sign-in':
			return {
				headline: 'Sign in to play',
				detail:
					'Signing in gives the game a key of its own, so your moves are sent without a wallet prompt every round.',
			};
		case 'authorise':
			return {
				headline: 'Let this browser play for you',
				// Says what it does AND what it does not do, because "authorise" is
				// the word every drainer uses. What is granted is narrow and the
				// contract enforces it: the key can commit and reveal for avatars this
				// account owns, and it cannot withdraw them.
				detail:
					'Your moves are signed here by a key this browser made, so no round needs a wallet prompt. Authorising lets it play as you and pays it some gas. It can never withdraw your avatars, and you can take the permission back at any time.',
				action: 'authorise',
			};
		case 'deposit':
			return {
				headline: 'Get an avatar and start playing',
				// Says where the avatar GOES, because "buy" suggests it lands in the
				// player's wallet and it does not: `AvatarsSale.purchase` mints it
				// straight into the Game, which is what having something at stake
				// means here. Somebody expecting to see an NFT appear in their wallet
				// should be told beforehand rather than go looking.
				// Says what the ONE transaction covers, because the player is about to
				// approve something that does three things: it buys the avatar into
				// the game's custody, it sends this browser's key enough gas to play
				// with, and it is what lets that key be authorised without a second
				// transaction. Saying only "buy" would make the wallet prompt look
				// bigger than the price.
				detail:
					'One transaction sets you up: it puts an avatar straight into the game, ready to move, and funds the key this browser plays with. The avatar will not appear in your wallet, and you can withdraw it whenever it is not in the world.',
				action: 'buy',
				actionLabel: options?.priceLabel
					? `Buy an avatar for ${options.priceLabel}`
					: 'Buy an avatar',
				busyLabel: options?.busyLabel,
			};
	}
}

export function createHud(context: Context): Readable<HudModel> {
	const {game} = context;

	return derived(
		[
			game.twoPhase,
			game.round,
			game.planning.movesLeft,
			game.planning.plan,
			game.deposited,
			game.activeAvatarID,
			game.currentPosition,
			game.epochInfo,
			game.missedReveal,
			game.setup,
			game.purchase,
		],
		([
			$phase,
			$round,
			$movesLeft,
			$plan,
			$deposited,
			$avatarID,
			$position,
			$epoch,
			$missedReveal,
			$setup,
			$purchase,
		]): HudModel => {
			const round = describeRound($round);
			const deposited = $deposited as DepositedState;
			const blocked = blocksCommitting($missedReveal as MissedRevealState);

			// `twoPhase` on a manually advanced chain has no clock, only a phase.
			const timeLeft = 'timeLeft' in $phase ? $phase.timeLeft : 0;
			const duration = 'duration' in $phase ? $phase.duration : 0;
			const playable = $phase.phase === 'play';

			const purchase = $purchase as PurchaseState;
			const needsSetup = describeSetup($setup as SetupNeeded | undefined, {
				busyLabel: purchaseBusyLabel(purchase),
				// THE TOTAL, not the price. The wallet is about to ask for
				// `price + stipend`, and the two differ by four orders of magnitude
				// here: the button read "Buy an avatar for >0 ETH" (the price rounds
				// to nothing) while MetaMask asked for 0.51. A button that
				// understates what is about to be charged is worse than one with no
				// number on it.
				priceLabel: `${formatBalance(
					purchaseValue({
						price: game.config.sale.price,
						stipend: game.config.sale.stipend,
					}),
				)} ${context.deployments.get().chain.nativeCurrency.symbol}`,
			});
			if (needsSetup?.action === 'buy') {
				needsSetup.busy = purchaseBusyLabel(purchase) !== undefined;
				needsSetup.error =
					purchase.step === 'Error' ? purchase.message : undefined;
			}

			const avatars =
				deposited.step === 'Loaded' ? deposited.avatars : ([] as const);
			const inWorld = $position !== undefined;
			// `lastEpoch` is when the avatar last acted, so a kill in the epoch just
			// resolved only becomes readable once the next one has begun.
			const casualty = avatars.find(
				(a) =>
					a.life === 0 &&
					a.inGame &&
					$epoch.currentEpoch >= Number(a.lastEpoch) + 1,
			);
			const plannedCount = $plan.planned.length;

			return {
				// Never invite a move the player cannot make: while they are still
				// being set up the clock is just a clock.
				phaseLabel: needsSetup
					? 'Round in progress'
					: playable
						? 'Make your move'
						: 'Resolving the round',
				phase: $phase.phase,
				secondsLeft: Math.max(0, Math.ceil(timeLeft)),
				progress:
					duration > 0 ? Math.min(1, Math.max(0, 1 - timeLeft / duration)) : 0,
				epoch: $epoch.currentEpoch,
				// Outside the play window the current round is closed, so a click now
				// is a plan for the next one. The round stamps it that way. Not worth
				// saying to someone who cannot play at all yet.
				planningForNextRound: !playable && !needsSetup,
				setup: needsSetup,
				// `hasLocalSigner` is `TARGET_STEP === 'SignedIn'`, and NOTHING ELSE.
				// It is not about hosted sign-in: a wallet-only sign-in has no host
				// and still derives a signer, so testing the host would get it wrong.
				// See core/connection/mode.ts, where the predicate is defined.
				walletSigningNotice: context.hasLocalSigner
					? undefined
					: "This build does not sign in, so there is no local signing key and every commit and reveal needs a wallet signature. Set TARGET_STEP to 'SignedIn' in core/connection/mode.ts to play with one.",

				avatarLabel:
					$avatarID === undefined ? undefined : avatarLabel($avatarID),
				avatarChoices: avatars.map((a) => ({
					avatarID: a.avatarID,
					label: avatarLabel(a.avatarID),
					inGame: a.inGame,
					life: a.life,
					active: a.avatarID === $avatarID,
				})),
				inWorld,
				died: casualty && {label: avatarLabel(casualty.avatarID)},

				plannedCount,
				movesLeft: $movesLeft,
				instruction: needsSetup
					? ''
					: inWorld
						? // Says the arrow keys exist, because nothing else on screen
							// does: the d-pad shows what can be pressed but not what can be
							// typed, and a player who never discovers the keyboard plays a
							// slower game than the one that was built.
							'Click a neighbouring cell to step onto it, or use the arrow keys. Only a legal step is accepted: the contract stops processing at the first move it refuses, which would silently drop the rest of your turn.'
						: 'Click anywhere to choose where to appear. Entering is the whole turn, so nothing can follow it.',

				roundLabel: round.label,
				roundTone: round.tone,
				missedReveal: describeMissedReveal($missedReveal as MissedRevealState),
				// Committing early is allowed the whole time the phase is open; the
				// round commits by itself if the player leaves it too late. An
				// unrevealed commitment blocks it entirely: the contract would reject
				// it, so offering the button would only spend gas to be told no.
				// A failed commit can be tried again while the phase is open: the
				// plan is still here and nothing was spent.
				canCommit:
					!blocked &&
					($round.step === 'Planning' ||
						($round.step === 'Error' && $round.during === 'commit')) &&
					plannedCount > 0 &&
					playable,
				// Offered as a fallback only. The round reveals on its own, because a
				// missed reveal loses the turn and blocks the next one, and the
				// window can be seconds long.
				canReveal: $round.step === 'Error' && $round.during === 'reveal',
				canClear: $round.step === 'Planning' && plannedCount > 0,
				outOfGas:
					$round.step === 'Error' &&
					$round.error instanceof SignerOutOfFundsError
						? {
								detail:
									'Moves are signed by a key held for you, and it has run out of gas. Top it up and this round carries on by itself.',
							}
						: undefined,
			};
		},
	);
}
