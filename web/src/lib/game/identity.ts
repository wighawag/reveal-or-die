/**
 * WHAT THIS GAME KEYS A ROUND BY.
 *
 * The framework never names a concrete identity: `createRound`,
 * `CommitRevealAdapter`, `createDerivedSecret` and `createRoundRecovery` are
 * all generic over `TIdentity extends PlayerIdentity`, deliberately, because
 * the games this template exists for disagree about what a player IS. An
 * account-keyed game plays as an address; reveal-or-die and bomber-world
 * commit per ERC721 token; conquest commits per owner-derived empire id.
 *
 * So SOMETHING has to say which one this app chose, and this module is it.
 * It exists so that the choice is made in ONE file rather than spelled out at
 * every site that carries it, and the reason that matters is a merge: this
 * repo inherits `game/core/` from `template-commit-reveal` and takes every
 * cascade it publishes. Each shared file that named `0x${string}` as the
 * identity would be a file this repo had to re-resolve forever; because none
 * do, the whole identity difference between the two is the alias below.
 * `core/connection/mode.ts` is the proven version of the same pattern, where
 * `TARGET_STEP` is one constant and one line of difference across three
 * branches. See rules N1 to N3 of Decision 3 in the template's plan.
 *
 * TWO WORDS THAT ARE NOT THE SAME WORD, and conflating them is the mistake
 * this module exists to make impossible:
 *
 * - the ACCOUNT is who signed in. It owns things, it pays, and it is an
 *   address in every game and every configuration. `Game.identity` is that,
 *   and so are the avatar purchase's `owner`, `deposited`'s owner and
 *   everything in `onchain/delegation.ts`.
 * - the GAME IDENTITY is who PLAYS. The round, the commitment, the secret's
 *   domain separation and the round's storage key are all keyed by it, and it
 *   is what changes shape between games.
 *
 * HERE THEY ARE DIFFERENT VALUES OF DIFFERENT TYPES, which is the case the
 * separation exists for: the account is an address that OWNS avatars, and the
 * identity is the avatar it is currently playing. In the template the two
 * hold the same value, and that is exactly why the names had to be separated
 * upstream rather than here - while they are equal, nothing forces a caller
 * to say which one it meant, and every such site would have had to be re-read
 * and judged at the moment they stopped being equal. They were separated
 * while the values agreed, so this repo inherited the distinction already
 * made and had only to point it at an avatar.
 */
import type {Readable} from 'svelte/store';
import type {PlayerIdentity} from './core/seams';

/**
 * THE ONE LINE, and in this repo it is the changed one.
 *
 * This game commits per AVATAR - an ERC721 token id, which is
 * `owner << 96 | subID` - where the template commits per account address.
 * That is the whole identity difference between the two repos, and
 * `game/core/` arrives here byte-identical because it never named either.
 *
 * The template's copy of this file predicts exactly this edit, which is what
 * the arrangement is for: `with/nft-identity` will make the same one to the
 * same line for the same reason.
 */
export type GameIdentity = bigint;

/**
 * THE SAME LINE, ON THE OTHER SIDE OF THE ABI.
 *
 * The contract keys every player by a `uint256` and never by an address, so on
 * a game whose identity IS a token id there is nothing to convert: the avatar
 * id is already the number the contract wants. Upstream this widens an
 * account, which is the only place that arithmetic is allowed to appear.
 *
 * WHY A GAME THAT CONVERTS NOTHING STILL CALLS IT, since the identity function
 * looks like a candidate for deletion at every call site. Upstream it exists so
 * that `placement/commit-reveal.ts`, `reserve.ts` and `missed-reveal.ts` stay
 * byte-identical to `main`'s, and that reason does NOT transfer here: this game
 * replaced all three. What transfers is the other half - there is exactly ONE
 * name in the tree for "the identity, as the contract wants it", so the day a
 * game appears whose identity needs real conversion, every site that has to
 * change is already spelled the same way. A repo that passed the raw value
 * instead would have the conversion spelled two ways across the tree, which is
 * the divergence-by-copy this tree keeps paying for.
 */
export function onchainIdentity(identity: GameIdentity): bigint {
	return identity;
}

/**
 * The framework has to be able to carry it.
 *
 * Compile-time only. `PlayerIdentity` is the union the seams accept, so an
 * alias outside it would fail at every call site at once with an error that
 * names the call site rather than the cause. This fails here instead, next to
 * the line that is actually wrong.
 */
type IdentityIsCarryable = GameIdentity extends PlayerIdentity ? true : never;
const _identityIsCarryable: IdentityIsCarryable = true;
void _identityIsCarryable;

/**
 * Which identity this client is playing AS, right now.
 *
 * Undefined before there is one, which is a real state rather than a loading
 * artefact: nobody is signed in yet, or the account holds nothing it can play
 * with. The setup gate turns that into an instruction instead of a dead board.
 *
 * A plain `Readable` and nothing more, on purpose, and this repo is the
 * reason that works. THIS game's store (`$lib/world/active-avatar`) also
 * offers `select(avatarID)`, because an account can own several avatars and
 * somebody has to pick; the template has exactly one identity per account and
 * nothing to choose, so carrying `select` upstream would have shipped a
 * method no consumer there could exercise. A richer store satisfies this type
 * structurally, which is what lets the framework ask for the minimum and this
 * game supply more.
 */
export type ActiveIdentityStore = Readable<GameIdentity | undefined>;

/**
 * THE PROVIDER IS THIS GAME'S OWN, and that is why there is no function here.
 *
 * The template exports a `createActiveIdentity` at this point, because there
 * the identity IS the account and one construction serves the whole app. This
 * game CHOOSES: an account can own several avatars, so something has to pick
 * one and remember the pick. That something is
 * {@link $lib/world/active-avatar.createActiveAvatar}, which reads what the
 * account has in custody, refuses an avatar with no life left, prefers one
 * already standing in the world, and remembers the choice per owner across
 * reloads. It returns a store that satisfies `ActiveIdentityStore` and adds
 * `select`, so the framework sees exactly what it needs and the game keeps
 * the part only it can decide.
 *
 * That is D6's rule arriving at its intended end: identity is a SELECTION,
 * and the selection lives with the game whose rules decide it. Replacing the
 * template's provider rather than parameterising it is the shape to expect -
 * the choosing logic above cannot be passed in as a list of candidates.
 */
