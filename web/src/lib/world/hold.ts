/**
 * Showing a cycle's outcome all at once, when the cycle is over.
 *
 * A commit-reveal game is SIMULTANEOUS: everyone's turn resolves together, and
 * that is the whole reason to pay for commitments and reveals at all. But the
 * reveals arrive one transaction at a time, in whatever order the mempool
 * delivers them, and a board that applies each one as it lands shows the cycle
 * playing out in that order - avatar A moves, four seconds pass, avatar B
 * moves. That is not what happened. It is the order they PAID in, drawn as if
 * it were the order they acted in, and it leaks who was quick to reveal.
 *
 * So the effects of the cycle being resolved are held back until the cycle is
 * over, and then applied together, where the walk animations play them out
 * side by side. What is held is only what the RESOLVING cycle changed:
 * anything else - an avatar that has not acted, a zone that came into view
 * when the player panned - passes straight through, because holding it would
 * be showing a stale board rather than a synchronised one.
 *
 * THE FRAMEWORK OWNS THE WHEN. `game/core/handover.ts` holds the board back
 * during the wait, releases it when the cycle is over, and publishes the
 * release so that the local overlay hands over in the same propagation. What
 * is here is the one thing it cannot own: which parts of THIS game's board the
 * resolving cycle changed, which needs to know what the board is made of.
 *
 * Pure, so the four cases that matter (moved, entered, untouched, newly
 * visible) are node tests rather than a thing to squint at during a ten second
 * reveal window.
 */
import {ActionType} from 'reveal-or-die-contracts';
import type {WorldState} from './state';

/**
 * The board to draw: `latest` with the resolving cycle's changes held back to
 * whatever `shown` had.
 *
 * WHAT COUNTS AS THIS CYCLE'S OUTCOME is read off `lastCycleNumber`, which is
 * STORAGE: `_resolveActions` ends with `_avatars[avatarID].lastCycleNumber = cycleNumber`
 * for every resolved turn, including the empty ones the client commits to keep
 * an idle avatar alive, so it arrives in the entity read pinned to the same
 * block as the position it explains and it cannot be missing.
 *
 * IT USED TO ASK THE REVEAL LOG (`lastTurn`), and that was a decision taken
 * from data that is explicitly allowed to be absent: `readResolvedTurns`
 * catches its own failures on purpose, because losing the animation is better
 * than losing the board. Absence then read as "this avatar has nothing to do
 * with the cycle", so ONE fetch whose logs did not arrive - a failed
 * `eth_getLogs`, or a reveal that fell outside a block window sized from a
 * block-time estimate measured once at page load - let every avatar's new
 * position through mid-window. Worse, it stuck: the board handed out becomes
 * the memory, so the cycle stayed released for the rest of the window, and the
 * walk at the boundary was then skipped by `AvatarObject.updateWalk`, which
 * refuses a replay whose destination is already drawn. The symptom is the
 * board flashing to its new positions part-way through the reveal and then
 * standing still at the moment it should be animating.
 *
 * The log keeps the ONE question storage cannot answer: whether an avatar that
 * was not on screen ENTERED, or was merely panned onto. See below.
 *
 * @param resolvingCycleNumber the cycle whose reveals are landing right now.
 */
export function holdResolvingCycle<TState extends WorldState>(params: {
	shown: WorldState;
	latest: TState;
	resolvingCycleNumber: number;
}): TState {
	const {shown, latest, resolvingCycleNumber} = params;
	const avatars = new Map(latest.avatars);

	for (const [id, avatar] of latest.avatars) {
		// Not part of this cycle's outcome: nothing to hold. The contract's
		// `lastCycleNumber` (this client's `lastCycleNumber`) only
		// advances on a reveal, so this is exactly "its turn for this cycle has
		// landed", and it is the same read that carries the position.
		if (avatar.lastCycleNumber !== resolvingCycleNumber) continue;

		const previous = shown.avatars.get(id);
		if (previous) {
			// Held: it is drawn where it was when the cycle began, and the walk
			// that takes it to `avatar.position` plays when the cycle ends.
			avatars.set(id, previous);
			continue;
		}

		// Never seen before AND it revealed this cycle: either it entered (in
		// which case it was genuinely not on the board, and appearing early is
		// exactly the leak this exists to prevent), or the player panned onto an
		// avatar mid-cycle, where the best available answer is what the chain
		// says. ONLY THE TURN tells the two apart, which is what the reveal log is
		// still read for here.
		//
		// AND ONLY THIS CYCLE'S TURN. An avatar that entered LAST cycle and moved
		// in this one carries an Enter in `lastTurn` whenever this cycle's log is
		// the one that went missing, and hiding it would remove an avatar that has
		// been standing in the world since before the cycle began.
		//
		// A MISSING LOG THEREFORE SHOWS IT, unchanged from before and still the
		// better default: every avatar now reveals every cycle (the client commits
		// empty turns to keep them alive), so "revealed this cycle" no longer
		// narrows anything down, and hiding on a missing log would blank most of
		// the board the moment a player panned during a reveal window. What is
		// risked instead is one entry appearing a few seconds early, which is the
		// same bound the pan case already accepts.
		if (
			avatar.lastTurn?.cycleNumber === resolvingCycleNumber &&
			avatar.lastTurn.actions.some(
				(action) => action.actionType === ActionType.Enter,
			)
		) {
			avatars.delete(id);
		}
	}

	return {...latest, avatars};
}
