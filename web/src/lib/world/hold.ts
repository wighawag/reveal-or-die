/**
 * Showing a round's outcome all at once, when the round is over.
 *
 * A commit-reveal game is SIMULTANEOUS: everyone's turn resolves together, and
 * that is the whole reason to pay for commitments and reveals at all. But the
 * reveals arrive one transaction at a time, in whatever order the mempool
 * delivers them, and a board that applies each one as it lands shows the round
 * playing out in that order - avatar A moves, four seconds pass, avatar B
 * moves. That is not what happened. It is the order they PAID in, drawn as if
 * it were the order they acted in, and it leaks who was quick to reveal.
 *
 * So the effects of the round being resolved are held back until the round is
 * over, and then applied together, where the walk animations play them out
 * side by side. What is held is only what the RESOLVING round changed:
 * anything else - an avatar that has not acted, a zone that came into view
 * when the player panned - passes straight through, because holding it would
 * be showing a stale board rather than a synchronised one.
 *
 * Pure, so the four cases that matter (moved, entered, untouched, newly
 * visible) are node tests rather than a thing to squint at during a ten second
 * reveal window.
 */
import {derived, type Readable} from 'svelte/store';
import {ActionType} from 'reveal-or-die-contracts';
import type {OnchainStateStore, OnchainStateValue} from '$lib/onchain/state';
import type {WorldState} from './state';

/**
 * The board to draw: `latest` with the resolving round's changes held back to
 * whatever `shown` had.
 *
 * @param resolvingEpoch the round whose reveals are landing right now.
 */
export function holdResolvingRound<TState extends WorldState>(params: {
	shown: WorldState;
	latest: TState;
	resolvingEpoch: number;
}): TState {
	const {shown, latest, resolvingEpoch} = params;
	const avatars = new Map(latest.avatars);

	for (const [id, avatar] of latest.avatars) {
		// Not part of this round's outcome: nothing to hold.
		if (avatar.lastTurn?.epoch !== resolvingEpoch) continue;

		const previous = shown.avatars.get(id);
		if (previous) {
			// Held: it is drawn where it was when the round began, and the walk
			// that takes it to `avatar.position` plays when the round ends.
			avatars.set(id, previous);
			continue;
		}

		// Never seen before AND its turn was this round: either it entered (in
		// which case it was genuinely not on the board, and appearing early is
		// exactly the leak this exists to prevent), or the player panned onto an
		// avatar mid-round, where the best available answer is what the chain
		// says. The turn itself tells the two apart.
		if (
			avatar.lastTurn.actions.some(
				(action) => action.actionType === ActionType.Enter,
			)
		) {
			avatars.delete(id);
		}
	}

	return {...latest, avatars};
}

/**
 * The board store the renderer reads: the poller's, with the resolving round
 * held back until the round is over.
 *
 * A WRAPPER rather than something inside the poller, because what is held is a
 * DISPLAY decision and the poller's job is to know what the chain says. The
 * settle, the catch-up phase and the RPC health all keep reading the raw store
 * for exactly that reason: they are about fetching, and this is about drawing.
 *
 * The memory is the last board it handed out, so successive fetches during the
 * window hold against what is on screen rather than drifting.
 */
export function holdBoardUntilRoundEnds(params: {
	state: OnchainStateStore<WorldState & {epoch: number}>;
	/** `twoPhase`: `wait` is the lock and the reveal, when a round is resolving. */
	phase: Readable<{phase: 'play' | 'wait'}>;
	/** The clock's epoch, which during the wait is the round being resolved. */
	epoch: Readable<number>;
}): OnchainStateStore<WorldState & {epoch: number}> {
	const {state, phase, epoch} = params;
	let shown: (WorldState & {epoch: number}) | undefined;

	const value = derived(
		[{subscribe: state.subscribe}, phase, epoch],
		([$state, $phase, $epoch]): OnchainStateValue<
			WorldState & {epoch: number}
		> => {
			const board = $state as OnchainStateValue<WorldState & {epoch: number}>;
			if (board.step === 'Unloaded') {
				// The board is no longer known to be true (an account switch, a chain
				// reset). There is nothing to hold and nothing to synchronise.
				shown = undefined;
				return board;
			}

			const latest: WorldState & {epoch: number} = {
				avatars: board.avatars,
				epoch: board.epoch,
			};

			// Outside the window, or with nothing on screen yet to hold against,
			// the newest answer IS the board.
			if (($phase as {phase: string}).phase !== 'wait' || !shown) {
				shown = latest;
				return {step: 'Loaded', avatars: latest.avatars, epoch: latest.epoch};
			}

			shown = holdResolvingRound({
				shown,
				latest,
				resolvingEpoch: $epoch as number,
			});
			return {step: 'Loaded', avatars: shown.avatars, epoch: shown.epoch};
		},
	);

	return {
		subscribe: value.subscribe,
		status: state.status,
		update: state.update,
	};
}
