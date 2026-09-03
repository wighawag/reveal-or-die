/**
 * Why an avatar died, in words the player can act on.
 *
 * NOTHING ON CHAIN SAYS WHY, and that is the fact this module exists around.
 * There is no death event and no stored cause: `_getResolvedAvatar` computes
 * `life` from how far `lastEpoch` has fallen behind the epoch being asked
 * about, so a kill is a CONCLUSION drawn from the same data anyone else can
 * read, not a record of something that happened. The client is therefore the
 * only thing that can ever explain a death, and an explanation it invents is
 * the player's only account of losing what they paid for.
 *
 * THIS GAME HAS EXACTLY ONE WAY TO DIE: going quiet. That is not an accident
 * of the demo, it is the template's own requirement showing through - a
 * commit-reveal game needs something at stake or nobody has to reveal, and
 * here the stake is the avatar and the penalty is losing it. So the union
 * below has one real member today.
 *
 * A DESCENDANT WILL ADD MORE, and this is where the cost of that lands. A
 * second cause (killed by another player, starved, burnt) cannot be told from
 * this one by looking at `life`, because every cause produces the same zero.
 * Adding one means giving the CHAIN a way to say which - an event carrying the
 * cause is the obvious answer, and it is what this game would need first -
 * and then adding a member here. Until such a game exists, guessing between
 * two causes would be worse than the `unknown` this already has.
 */

export type DeathCause =
	/**
	 * It stopped committing and revealing, so the contract killed it.
	 *
	 * `rounds` is how many consecutive rounds of silence it took, which is
	 * `numMissesAllowed + 1`: the avatar may miss that many, and dies in the
	 * round after. Absent when the deployment does not state the tolerance, in
	 * which case the sentence says what happened without a number rather than
	 * quoting one this build happens to believe.
	 */
	| {kind: 'silence'; rounds?: number}
	/**
	 * Something this client cannot name.
	 *
	 * Unreachable today and deliberately kept: it is what an honest answer looks
	 * like the moment a game adds a second way to die and the chain has not been
	 * given a way to say which one happened.
	 */
	| {kind: 'unknown'};

/**
 * What killed an avatar, from what the client knows.
 *
 * Takes the config rather than the avatar, because the avatar has nothing to
 * say about it: every death reads as `life === 0`, and only the rule that
 * produced it can be quoted. That asymmetry is the point - see the note above
 * about what a second cause would need.
 */
export function causeOfDeath(config: {numMissesAllowed?: number}): DeathCause {
	const {numMissesAllowed} = config;
	return {
		kind: 'silence',
		// The avatar may miss `numMissesAllowed` rounds and dies in the one after,
		// so the run of silence is one longer than the tolerance. Off by one here
		// would be the client stating the rules of a game nobody is playing.
		rounds:
			numMissesAllowed === undefined || !Number.isFinite(numMissesAllowed)
				? undefined
				: numMissesAllowed + 1,
	};
}

/**
 * The explanation itself.
 *
 * Says WHAT happened and WHY THE RULE EXISTS, in that order, because the second
 * half is what stops it reading as a bug: an avatar that dies for standing
 * still is outrageous unless you know that a game where going quiet is free is
 * a game where nobody has to reveal a turn they have come to dislike.
 */
export function explainDeath(cause: DeathCause): string {
	switch (cause.kind) {
		case 'silence':
			return `${
				cause.rounds === undefined
					? 'It went several rounds in a row without committing and revealing a turn.'
					: `It went ${cause.rounds} rounds in a row without committing and revealing a turn.`
			} That is the only way to die here: a player who could go quiet for free could walk away from a turn they had committed to and did not like, so the game takes the avatar of anyone who stops playing. This browser keeps the round turning for you while it is open, even when you stand still.`;
		case 'unknown':
			return 'The contract reports it as dead, and nothing on chain records what killed it.';
	}
}
