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
 * Deliberately NOT read off the board. What the avatar looks like afterwards
 * cannot tell a turn that moved from one that was refused, and the chain does
 * not report per-action outcomes at all (a rejected move sets `stopProcessing`
 * and says nothing). So this describes what the player REVEALED, which is what
 * they chose and the only thing that can be stated honestly.
 */
import {derived, type Readable} from 'svelte/store';
import type {RoundState} from '$lib/game/core/round';
import {ActionType} from 'reveal-or-die-contracts';
import type {Action} from './commit-reveal';

export type RevealOutcome =
	/** The avatar appeared in the world. */
	| 'entered'
	/** It left the world, from the exit tile. */
	| 'left'
	/** It walked. */
	| 'moved'
	/**
	 * Nothing was planned.
	 *
	 * Not a dull case: it is what an idle avatar does every single epoch,
	 * because `commitWhenIdle` keeps committing empty turns so the contract does
	 * not kill it for going quiet.
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
 * The outcome of the last reveal, while the round is reporting one.
 *
 * Undefined at every other step, and also for a reveal this store did not
 * watch happen - a page opened after the fact has no way to know, and saying
 * so is better than guessing at "moved".
 */
export function createRevealOutcome(
	round: Readable<RoundState<Action>>,
): Readable<RevealOutcome | undefined> {
	let latest: readonly Action[] | undefined;
	return derived(round, ($round): RevealOutcome | undefined => {
		// Every step up to and including `Revealing` carries the actions; the
		// `Revealed` that follows does not.
		if ('actions' in $round) latest = $round.actions;
		if ($round.step !== 'Revealed') return undefined;
		return latest ? outcomeOf(latest) : undefined;
	});
}
