/**
 * WHAT THIS GAME PUTS AT STAKE, in the words a player reads.
 *
 * `./reserve.ts` is what the stake IS; this is what it is CALLED. On this
 * branch the stake is CUSTODY of an avatar rather than a bonded reserve of
 * tokens, so every sentence here differs from `main`'s and nothing else in the
 * HUD or the play route does. That is exactly what this module exists for: see
 * the note upstream for why six strings in `placement/ui/hud.ts` and
 * `routes/play/+page.svelte` would otherwise put both of those on this
 * branch's shared-file list forever.
 *
 * A THING RATHER THAN A QUANTITY, and it shows in `amount`. Upstream a stake
 * has a size and a unit; here you have an avatar or you do not, so the number
 * the HUD is handed is a count and the sentence has to read as one.
 */

export const STAKE = {
	/**
	 * What the player has at stake, as they read it.
	 *
	 * The argument is a COUNT (see `reserve.ts`), so the plural is the whole
	 * job. Formatting it as a balance, which is what upstream does, would print
	 * "0.000000000000000001" for one avatar.
	 */
	amount(value: bigint): string {
		if (value === 0n) return 'none';
		return value === 1n ? '1 avatar' : `${value} avatars`;
	},

	/**
	 * A plan this stake cannot cover.
	 *
	 * UNREACHABLE ON THIS BRANCH and deliberately still true if it were
	 * reached: a placement costs nothing here, so the HUD's comparison never
	 * fires. It is worded for the case that would produce it - an avatar that
	 * has stopped being playable mid-plan - rather than deleted, because the
	 * HUD is shared and asks for this string unconditionally.
	 */
	notEnough: 'You need an avatar in the game to place anything.',

	/**
	 * The setup gate's stake step.
	 *
	 * Says what the ONE transaction covers, because the player is about to
	 * approve something that does three things: it mints an avatar into the
	 * game, where it is at stake from that moment; it sends this browser's key
	 * enough gas to play with; and it is what lets that key be authorised
	 * without a second transaction.
	 *
	 * It says what NOT REVEALING costs, in the sentence before the price. That
	 * is the invariant the whole template rests on, and a player who is not told
	 * it has been sold a thing rather than told a rule.
	 */
	setup: {
		headline: 'Get an avatar to play',
		detail:
			'You play as an avatar, and it lives in the game while you do. Miss a reveal after committing and it is gone for good - that is what makes a commitment worth anything. One transaction sets you up: it mints your avatar into the game and funds the key this browser plays with.',
		/** The button, with the total the wallet is about to ask for. */
		action(priceLabel?: string): string {
			return priceLabel ? `Buy an avatar for ${priceLabel}` : 'Buy an avatar';
		},
	},

	/**
	 * What a missed reveal cost, and what to do next.
	 *
	 * THE ARGUMENT IS IGNORED HERE, and that is the clearest single statement of
	 * what this branch changes. Upstream the bond is the loss and the number is
	 * the news; here the bond is always zero and the loss is the avatar itself,
	 * seized by the same call that settles the commitment. A sentence built from
	 * `bond` would tell the player they had lost nothing.
	 *
	 * The second clause is the framework's rule showing through - an unrevealed
	 * commitment blocks the next one until it is settled - and every game has
	 * it.
	 */
	forfeited(_bond: bigint): string {
		// "is forfeit" is kept from upstream's wording deliberately: it is the
		// word the app uses everywhere for a stake that has been lost, and the
		// e2e asserts the player was TOLD rather than asserting a sentence. A
		// synonym here would have cost that suite an edit for nothing.
		return 'Your avatar is forfeit, and you cannot play again until you acknowledge it and get another one.';
	},

	/**
	 * What the acquisition dialog says is being bought.
	 *
	 * The rail (`$lib/game/acquire`) is shared and has no opinion about what
	 * arrives; this sentence is this game's.
	 */
	acquireExplanation:
		'One transaction mints an avatar into the game and funds the key this browser plays with. Whoever pays, the avatar is yours: only your account can play it or take it back out.',
};
