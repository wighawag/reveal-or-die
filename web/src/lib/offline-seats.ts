import {bytesToHex} from 'viem';
import {mnemonicToAccount} from 'viem/accounts';

/**
 * HOW MANY SEATS ARE AT THE TABLE, AND WHO IS IN EACH ONE.
 *
 * A SEAT, NOT A PLAYER COUNT, and that is the whole of the design rather than
 * a flourish. A count answers "how many", which is the question a lobby asks
 * today; a seat answers "who is there", which is the question every later
 * question turns out to be. A seat has an OCCUPANT, and today an occupant is
 * either YOU or THE WORLD. That is all it is now, and it is what makes hotseat
 * additive rather than a redesign: a second human is a third kind of occupant,
 * and nothing else here has to move - `tableOf` still lays the seats out, the
 * provisioning still walks the table asking each occupant for an address, and
 * the lobby still chooses how many there are.
 *
 * WHAT A SEAT IS NOT is a setting on a live world. What ENROLS a player is
 * holding this game's stake, which happens once, during provisioning: the
 * contract starts waiting for anyone with a funded reserve (on the identity
 * branches, for anyone whose avatar it has custody of). So the number of seats
 * is baked into a world at the moment it boots, and changing it means a NEW
 * world rather than a setting - see `$lib/offline-lobby`, which is where that
 * is enforced, and `$lib/embedded/chain-id`, which is what makes a new world
 * cheap.
 *
 * NOTHING HERE KNOWS WHAT A SEAT HOLDS. A lobby chooses how many people are at
 * the table; what each of them is given, and how this game spells who they
 * are, is `$lib/offline`'s, which is the one file per branch of this template
 * that is allowed to know. That is why this file is byte-identical on every
 * branch and why it should stay that way.
 */

/**
 * The keys the world plays with, and they are PUBLIC AND FIXED on purpose -
 * the same argument `$lib/offline` already makes for the deployer and the
 * admin.
 *
 * These are hardhat's well-known development accounts, derived from the
 * mnemonic every tool in this ecosystem ships with. There is nothing to
 * protect: the chain exists only in this tab, it has no bridge to anywhere,
 * and its ether is a number a cheat call sets. Generating a key per world
 * would buy no security and would cost the one thing that matters - a world's
 * players would be different addresses between runs, so nothing about a world
 * could be written down or reasoned about.
 *
 * ONE PUBLIC FACT RATHER THAN THIRTY-SIX. Writing the keys out would be
 * eighteen pairs of opaque hex, which is eighteen chances for a cascade to
 * halve the list or transpose a digit; the mnemonic and an index are the same
 * information with one thing to get wrong.
 *
 * AND THE ADDRESSES ARE A WIRE, in exactly `AGENTS.md`'s sense. A world that
 * has booted has these addresses ENROLLED on chain, holding this game's stake;
 * a build that derived different ones would restore that world and find its
 * members unreachable - the cycle would wait forever for players nobody holds
 * a key for, and under the manual policy waiting forever is what it does. So
 * this derivation is not an implementation detail to tidy: `test/lib/offline-seats.test.ts`
 * pins the first addresses against the ones the world has been playing as.
 */
const WELL_KNOWN_MNEMONIC =
	'test test test test test test test test test test test junk';

/**
 * Where the world's own players start in that list.
 *
 * Two, because `$lib/offline` signs the deploy with #0 and administers with
 * #1. An overlap would make the deployer a member of the game it deployed,
 * which is not wrong so much as impossible to reason about the first time a
 * balance looks strange.
 */
const FIRST_PLAYED_ACCOUNT = 2;

/** Who is in a seat. */
export type Occupant =
	/**
	 * The human at this browser. Exactly one seat has this occupant, and it has
	 * no key here: the player plays through the wallet the world announces (see
	 * `lib/embedded/wallet.ts`), whose account is not known until the world has
	 * booted and handed it over.
	 */
	| {kind: 'you'}
	/**
	 * The world itself, playing a key it holds.
	 *
	 * What it DOES with that key is `$lib/offline-players`, and it is
	 * deliberately the smallest thing that gives a cycle somebody to wait for:
	 * no intelligence, no difficulty, no interface. The NPCs the plan's Phase 6
	 * wants are a different job.
	 */
	| {kind: 'the-world'; privateKey: `0x${string}`; address: `0x${string}`};

/** One place at the table. */
export type Seat = {occupant: Occupant};

/** Everyone the cycle will wait for, in seat order. */
export type Table = readonly Seat[];

/**
 * THE FLOOR, and it is three rather than two for a reason the contract can be
 * made to demonstrate.
 *
 * One waited-for member satisfies unanimity by existing: the commit phase
 * hides nothing, and two of the three conditions `advanceCycle` exists to
 * enforce (`StillWaitingToCommit`, `StillWaitingToReveal`) cannot be reached
 * at all. Two is a duel, where "everyone" and "the other one" are the same
 * statement and a contested cell is a special case rather than an instance of
 * the rule. At three the accumulation in `_place` has something to accumulate
 * and the order-independence property has something to say.
 *
 * So a table of three is the smallest thing that is a commit-reveal game
 * rather than a demonstration of one, and it is also the default: what the
 * lobby offers above it is more company, not more correctness.
 */
export const FEWEST_SEATS = 3;

/** What a player gets if they never touch the chooser. See {@link FEWEST_SEATS}. */
export const SEATS_BY_DEFAULT = 3;

/**
 * THE CEILING, and it is deliberately NOT "however many keys the list holds".
 *
 * The supply is eighteen (hardhat's accounts #2 to #19), so the key list is
 * not the bound and must not be allowed to become the reason. What bounds a
 * table is what a ROUND COSTS, and that turned out not to be the arithmetic
 * anybody would have predicted.
 *
 * THE ARITHMETIC SAYS IT SHOULD BE FREE. The world acts for its players one at
 * a time (`offline-players.ts` says why: they share one chain in one worker,
 * and a burst of commits is a burst of blocks nobody is waiting for), so a
 * table of N costs 2(N-1) transactions in series per round plus two advances -
 * and a transaction on a chain in a tab is 15 to 20 ms. Eighteen of them is a
 * third of a second.
 *
 * THE MEASUREMENT SAYS OTHERWISE, and the step is where this number comes
 * from. Headless chromium, production build, five runs each:
 *
 * | seats | a round |
 * |---|---|
 * | 3 | 114-237 ms |
 * | 4 | first 1.33 s, then 224-230 ms |
 * | 5 | first 1.32 s, then 210-273 ms |
 * | 6 | 3.8-4.4 s, every round |
 * | 8 | 3.8-4.4 s, every round |
 *
 * It is a staircase in whole poll intervals rather than a slope, because the
 * cost is not the transactions: from four seats up, the advance that opens the
 * reveal phase SUCCEEDS on chain, emits `CycleAdvanced`, and leaves `getCycle`
 * still reporting the commit phase - so the round waits out the advance
 * client's one-second backstop and is pushed again. At six the second advance
 * also reverts with its condition met, which costs the framework's two-second
 * backoff on top. The same contract, driven the same way under node, refuses a
 * second advance exactly as it should, so this is the chain in the TAB rather
 * than the rules. It is written up on the `work` branch
 * (`a-second-advance-succeeds-in-the-tab-and-the-first-one-did-not-take`) and
 * it is not this file's to fix.
 *
 * So FIVE, because that is the largest table at which a steady round is still
 * a fifth of a second, and because the number has to be one the world can
 * honour rather than one the key list happens to allow. It is a MEASUREMENT
 * and not a principle: when the tab's chain stops losing that write, re-measure
 * and raise it.
 */
export const MOST_SEATS = 5;

/** Every table size the lobby offers, for whatever renders the choice. */
export const SEAT_CHOICES: readonly number[] = Array.from(
	{length: MOST_SEATS - FEWEST_SEATS + 1},
	(_, i) => FEWEST_SEATS + i,
);

/**
 * Bring any number into range.
 *
 * TOTAL, because the inputs are not trustworthy: one comes out of
 * `localStorage`, where a previous build (or a person with a console) may have
 * left anything, and the other comes from a control. A stored count that is
 * out of range is not repaired into something meaningful, it is clamped, which
 * is the same answer the chain-id store gives to a stored id it could not have
 * minted: carry on with something this code can reason about.
 */
export function clampSeats(seats: unknown): number {
	const parsed =
		typeof seats === 'number'
			? seats
			: typeof seats === 'string'
				? Number(seats)
				: Number.NaN;
	if (!Number.isFinite(parsed)) return SEATS_BY_DEFAULT;
	const whole = Math.floor(parsed);
	if (whole < FEWEST_SEATS) return FEWEST_SEATS;
	if (whole > MOST_SEATS) return MOST_SEATS;
	return whole;
}

/** Cached, because deriving an HD account is elliptic-curve work. */
const played: {privateKey: `0x${string}`; address: `0x${string}`}[] = [];

function playedKey(index: number): {
	privateKey: `0x${string}`;
	address: `0x${string}`;
} {
	const existing = played[index];
	if (existing) return existing;
	const account = mnemonicToAccount(WELL_KNOWN_MNEMONIC, {
		addressIndex: FIRST_PLAYED_ACCOUNT + index,
	});
	const key = account.getHdKey().privateKey;
	// Cannot happen for an account derived from a mnemonic, and worth saying so
	// rather than casting: a player with no key is a member the cycle waits for
	// and nobody can act for, which under the manual policy is a frozen world.
	if (!key) {
		throw new Error(
			`the world could not derive a key for the player in seat ${index + 1}`,
		);
	}
	const derived = {privateKey: bytesToHex(key), address: account.address};
	played[index] = derived;
	return derived;
}

/**
 * Lay out a table of `seats`.
 *
 * SEAT ONE IS YOURS, always, and the rest are the world's. That is a fact
 * about today's two occupants rather than a rule: when a seat can hold a
 * second human, this is the one function that changes, and it changes by
 * taking what each seat holds as an argument instead of assuming it.
 */
export function tableOf(seats: number): Table {
	const count = clampSeats(seats);
	const table: Seat[] = [{occupant: {kind: 'you'}}];
	for (let index = 0; index < count - 1; index++) {
		table.push({occupant: {kind: 'the-world', ...playedKey(index)}});
	}
	return table;
}

/**
 * The seats the world plays, in seat order.
 *
 * A walk of the TABLE rather than a slice of the key list, which is the whole
 * reason the seat model earns its keep: every caller that has to do something
 * per member (fund it, stake for it, play it) asks the table who is there
 * instead of assuming that everyone except seat one is the world's.
 */
export function seatsPlayedByTheWorld(
	table: Table,
): readonly {privateKey: `0x${string}`; address: `0x${string}`}[] {
	const world: {privateKey: `0x${string}`; address: `0x${string}`}[] = [];
	for (const seat of table) {
		if (seat.occupant.kind === 'the-world') {
			world.push({
				privateKey: seat.occupant.privateKey,
				address: seat.occupant.address,
			});
		}
	}
	return world;
}
