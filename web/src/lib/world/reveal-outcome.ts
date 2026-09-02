/**
 * What the turn that just resolved actually DID.
 *
 * The round reports `{step: 'Revealed', epoch}` and nothing else, so the HUD
 * used to say "Revealed. Your avatar has moved." after every reveal - after a
 * turn that entered the world, after one that left it, and after the empty
 * turns the round commits by itself to keep an idle avatar alive
 * (`commitWhenIdle`). A player standing still watched their avatar be told it
 * had moved, once an epoch, forever.
 *
 * The actions are on the round state right up to the reveal (`Revealing`
 * carries them) and gone the moment it succeeds, which is why this remembers
 * rather than derives. It is the smallest amount of memory that can answer the
 * question: the last actions seen, read only while the round says Revealed.
 *
 * WHAT THE HUD SAYS ABOUT IT now prefers what the chain ACCEPTED, when it is
 * on the board. `lib/world/state.ts` fetches `CommitmentRevealed` for the
 * camera's zones, which carries `actions[0:numActionsResolved]` - the prefix
 * the contract carried out, a step it refused being simply absent - so a turn
 * that walked into a wall is two moves, not three. The remembered actions
 * remain the fallback for the one player whose avatar may not be in the
 * fetched zones at all, and they are the same thing whenever the contract
 * accepted everything.
 */
import {derived, type Readable} from 'svelte/store';
import type {RoundState} from '$lib/game/core/round';
import {ActionType} from 'reveal-or-die-contracts';
import type {Action} from './commit-reveal';
import type {PlannedAction, ResolvedTurnView} from './view';

export type RevealOutcome =
	/** The avatar appeared in the world. */
	| 'entered'
	/** It left the world, from the exit tile. */
	| 'left'
	/** It walked. */
	| 'moved'
	/**
	 * It did nothing, which is different from not having acted:
	 *
	 * - NOTHING WAS REVEALED. Not a dull case: it is what an idle avatar does
	 *   every single epoch, because `commitWhenIdle` keeps committing empty turns
	 *   so the contract does not kill it for going quiet.
	 * - SOMETHING WAS REVEALED and none of it was accepted - a turn of steps into
	 *   walls. Only the chain's own account of the turn can say that, which is
	 *   why the two inputs below exist.
	 */
	| 'stayed';

/** What a revealed list of actions amounts to, in one word. */
export function outcomeOf(actions: readonly Action[]): RevealOutcome {
	// ORDER MATTERS, and it is the contract's: an Enter or an Exit sets
	// `stopProcessing`, so a turn containing either is ABOUT that, whatever else
	// was planned alongside it. Exit first because moves may precede it and an
	// Enter can be followed by nothing at all.
	if (actions.some((a) => a.actionType === ActionType.Exit)) return 'left';
	if (actions.some((a) => a.actionType === ActionType.Enter)) return 'entered';
	if (actions.some((a) => a.actionType === ActionType.Move)) return 'moved';
	return 'stayed';
}

/**
 * The same vocabulary, for what the chain says it accepted.
 *
 * The actions arrive in the renderer's shape (`toPlannedActions`) rather than
 * the contract's, because that is what the board carries them as. `to: {x, y}`
 * is all either reading of `outcomeOf` needs.
 */
export function outcomeOfResolved(
	actions: readonly PlannedAction[],
): RevealOutcome {
	return outcomeOf(
		actions.map((a) => ({
			actionType:
				a.type === 'enter'
					? ActionType.Enter
					: a.type === 'exit'
						? ActionType.Exit
						: ActionType.Move,
			data: 0n,
		})),
	);
}

/**
 * The outcome of the last reveal, while the round is reporting one.
 *
 * Undefined at every other step, and also for a reveal this store did not
 * watch happen - a page opened after the fact has no way to know, and saying
 * so is better than guessing at "moved".
 *
 * THE CHAIN'S OWN ACCOUNT WINS when it has one. `lastTurn` is the accepted
 * prefix straight out of `CommitmentRevealed`, so it is the truth even for a
 * turn the contract refused half of; the remembered actions are the fallback
 * for the one player whose avatar is not in the camera's zones - out of the
 * world, or panned away from - because the outcome sentence is about THEIR
 * turn and nobody else's.
 */
export function createRevealOutcome(
	round: Readable<RoundState<Action>>,
	/** The player's own avatar as the board holds it, accepted actions included. */
	mine: Readable<{lastTurn?: ResolvedTurnView} | undefined>,
): Readable<RevealOutcome | undefined> {
	let latest: readonly Action[] | undefined;
	return derived(
		[round, mine],
		([$round, $mine]): RevealOutcome | undefined => {
			// Every step up to and including `Revealing` carries the actions; the
			// `Revealed` that follows does not.
			if ('actions' in $round) latest = $round.actions;
			if ($round.step !== 'Revealed') return undefined;
			if ($mine?.lastTurn) return outcomeOfResolved($mine.lastTurn.actions);
			return latest ? outcomeOf(latest) : undefined;
		},
	);
}
