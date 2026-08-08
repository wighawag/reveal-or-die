/**
 * Everything the HUD renders, as one derived store.
 *
 * The components that show this are deliberately logic-less: they take a
 * finished model and lay it out. All the deciding - which phase label to show,
 * whether committing is still possible, what the round costs - happens here, in
 * plain TypeScript that can be read and tested without a browser.
 */
import {derived, type Readable} from 'svelte/store';
import {formatBalance} from '$lib/core/utils/format/balance';
import type {Context} from '$lib/context/types';
import type {RoundState} from '$lib/game/core/round';

import type {Placement} from '../commit-reveal';
import type {ReserveState} from '../reserve';
import {blocksCommitting, type MissedRevealState} from '../missed-reveal';
import type {SetupNeeded} from '$lib/context/game';

export type HudModel = {
	phaseLabel: string;
	/**
	 * Two phases, not three.
	 *
	 * The contract has a commit phase and a reveal phase, and the client adds a
	 * third slice at the end of the commit phase where moves are locked so the
	 * commitment has time to land. Three states is one more than the player has
	 * a decision about: what they need to know is whether this round is still
	 * theirs to change. `commit` and `reveal` are both "wait", and bomber-world
	 * shows the same thing this way.
	 */
	phase: 'play' | 'wait';
	/** Seconds left in the phase, already rounded for display. */
	secondsLeft: number;
	/** How far through the phase, 0..1, for a progress bar. */
	progress: number;
	epoch: number;
	/**
	 * Clicking now plans for the NEXT round, because this one has closed. Worth
	 * saying: the moves still appear on the board, and without this the player
	 * would reasonably think they were part of the round being resolved.
	 */
	planningForNextRound: boolean;
	/**
	 * Set when this deployment has no hosted sign-in, so every move has to be
	 * signed in the wallet. Said once, up front, rather than discovered one
	 * prompt at a time.
	 */
	walletSigningNotice?: string;
	/**
	 * Set while the player cannot take a turn yet. The HUD shows THIS instead of
	 * the planning controls: offering "plan your moves" to someone with nothing
	 * staked invites them to lay out a whole turn that cannot be committed, and
	 * the failure only arrives when the round is already closing.
	 */
	setup?: {headline: string; detail: string; action?: 'stake'};

	plannedCount: number;
	costLabel: string;
	reserveLabel: string;
	/** Set when the plan costs more than the reserve can cover. */
	warning?: string;

	roundLabel: string;
	roundTone: 'idle' | 'busy' | 'good' | 'bad';
	canCommit: boolean;
	canReveal: boolean;
	canClear: boolean;

	/**
	 * Set when an unrevealed commitment is blocking play. Holds what was lost and
	 * what the player has to do about it: acknowledging forfeits the bond, so it
	 * is offered rather than done for them.
	 */
	missedReveal?: {
		headline: string;
		detail: string;
		busy: boolean;
		canAcknowledge: boolean;
	};
};

export function describeRound(state: RoundState<Placement>): {
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
			return {
				label: 'Revealed. Your placements are on the board.',
				tone: 'good',
			};
		case 'Missed':
			return {
				// The one message that costs the player money, so it says what
				// happened rather than just that something went wrong.
				label: `Missed the reveal for epoch ${state.epoch}. The bond is forfeit.`,
				tone: 'bad',
			};
		case 'Error':
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
 * Phrased as a statement of what happened and what it cost, not as an error:
 * the stake is already gone by the time this is shown, and the only remaining
 * choice is whether to settle it on chain and carry on playing.
 */
export function describeMissedReveal(
	state: MissedRevealState,
): HudModel['missedReveal'] {
	if (state.step === 'Clear' || state.step === 'Unknown') return undefined;

	const lost = `${formatBalance(state.bond)} TOK`;
	const headline = `You missed the reveal for epoch ${state.epoch}.`;

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
			detail: `Could not acknowledge it: ${state.message}`,
			busy: false,
			canAcknowledge: true,
		};
	}
	return {
		headline,
		detail: `Your bond of ${lost} is forfeit, and you cannot commit again until you acknowledge it.`,
		busy: false,
		canAcknowledge: true,
	};
}

/** What the player has to do before they can take a turn. */
export function describeSetup(
	setup: SetupNeeded | undefined,
): HudModel['setup'] {
	if (!setup) return undefined;
	switch (setup.step) {
		case 'sign-in':
			return {
				headline: 'Sign in to play',
				detail:
					'Signing in gives the game a key of its own, so your moves are sent without a wallet prompt every round.',
			};
		case 'stake':
			return {
				headline: 'Stake before you play',
				detail:
					'A commitment bonds tokens from your reserve, and they are forfeit if you never reveal. That is what makes a commitment worth anything, so there is nothing to play with until you have some.',
				action: 'stake',
			};
	}
}

export function createHud(context: Context): Readable<HudModel> {
	const {game} = context;

	return derived(
		[
			game.twoPhase,
			game.round,
			game.planning.count,
			game.cost,
			game.reserve,
			game.epochInfo,
			game.missedReveal,
			game.setup,
		],
		([
			$phase,
			$round,
			$count,
			$cost,
			$reserve,
			$epoch,
			$missedReveal,
			$setup,
		]): HudModel => {
			const round = describeRound($round);
			const reserve = $reserve as ReserveState;
			const reserveAmount =
				reserve.step === 'Loaded' ? reserve.amount : undefined;
			const blocked = blocksCommitting($missedReveal as MissedRevealState);

			// `twoPhase` on a manually advanced chain has no clock, only a phase.
			const timeLeft = 'timeLeft' in $phase ? $phase.timeLeft : 0;
			const duration = 'duration' in $phase ? $phase.duration : 0;
			const playable = $phase.phase === 'play';

			const needsSetup = describeSetup($setup as SetupNeeded | undefined);

			return {
				// Never invite a move the player cannot make: while they are still
				// being set up the clock is just a clock.
				phaseLabel: needsSetup
					? 'Round in progress'
					: playable
						? 'Plan your moves'
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
				walletSigningNotice: context.hasLocalSigner
					? undefined
					: 'No hosted sign-in is configured, so every commit and reveal needs a wallet signature. Set PUBLIC_WALLET_HOST to play with a local signing key instead.',

				plannedCount: $count,
				costLabel: `${formatBalance($cost)} TOK`,
				reserveLabel:
					reserveAmount === undefined
						? '-'
						: `${formatBalance(reserveAmount)} TOK`,
				warning:
					reserveAmount !== undefined && $cost > reserveAmount
						? 'Not enough in your reserve to cover these placements.'
						: undefined,

				roundLabel: round.label,
				roundTone: round.tone,
				missedReveal: describeMissedReveal($missedReveal as MissedRevealState),
				// Committing early is allowed the whole time the phase is open; the
				// round commits by itself if the player leaves it too late. An
				// unrevealed commitment blocks it entirely: the contract would reject
				// it, so offering the button would only spend gas to be told no.
				canCommit:
					!blocked && $round.step === 'Planning' && $count > 0 && playable,
				// Offered as a fallback only. The round reveals on its own, because a
				// missed reveal forfeits the bond and the window can be seconds long.
				canReveal: $round.step === 'Error' && $round.during === 'reveal',
				canClear: $round.step === 'Planning' && $count > 0,
			};
		},
	);
}
