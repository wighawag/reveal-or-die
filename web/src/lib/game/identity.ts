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
 * branch is where the reference game becomes token-keyed, and every shared
 * file that named `0x${string}` as the identity would be a file this branch
 * has to edit and therefore conflict on forever.
 * `core/connection/mode.ts` is the proven version of the same pattern, where
 * `TARGET_STEP` is one constant and one line of difference across three
 * branches. See rules N1 to N3 of Decision 3 in the plan on the `work` branch.
 *
 * TWO WORDS THAT ARE NOT THE SAME WORD, and conflating them is the mistake
 * this module exists to make impossible:
 *
 * - the ACCOUNT is who signed in. It owns things, it pays, and it is an
 *   address in every game and every configuration. `Game.identity` is that,
 *   and so are `acquire`'s `owner`, the reserve's `payer` and everything in
 *   `onchain/delegation.ts`.
 * - the GAME IDENTITY is who PLAYS. The round, the commitment, the secret's
 *   domain separation, the stake and the round's storage key are all keyed by
 *   it, and it is what changes shape between games.
 *
 * ON `main` THEY HOLD THE SAME VALUE, because the template is deliberately an
 * address game. ON THIS BRANCH THEY DO NOT, and that is the whole point: an
 * account owns avatars, an avatar plays, and one account could hold several
 * (D6, not built - but nothing here precludes it).
 */
import {derived, get, writable, type Readable} from 'svelte/store';
import type {Context} from '$lib/context/types';
import type {PlayerIdentity} from './core/seams';

/**
 * THE ONE LINE.
 *
 * This is the whole difference between an address game and a token game, and
 * it is what this branch changes. Nothing in `game/core/` moves for it, which
 * is the property the identity boundary test enforces from both sides.
 */
export type GameIdentity = bigint;

/**
 * THE SAME LINE, ON THE OTHER SIDE OF THE ABI.
 *
 * The contract keys every player by a `uint256` and never by an address, so on
 * a game whose identity IS a token id there is nothing to convert: the
 * identity is already the number the contract wants. Upstream this widens an
 * account, which is the only place that arithmetic is allowed to appear.
 *
 * Kept as a function rather than deleted at the call sites. It costs nothing,
 * it keeps `placement/commit-reveal.ts`, `reserve.ts` and `missed-reveal.ts`
 * byte-identical to `main`'s, and those three are files `main` keeps
 * developing for reasons that have nothing to do with identity.
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
 * artefact: nobody is signed in yet, or the account holds no avatar in the
 * game. The setup gate turns that into an instruction instead of a dead board.
 *
 * RICHER THAN `main`'S, AND STRUCTURALLY COMPATIBLE, which is exactly the
 * escape hatch the upstream version documents: "a richer store satisfies this
 * type structurally, so a game that needs selection supplies it without this
 * type growing a method that does nothing here". Two members are added and
 * both are needed by something that only exists here:
 *
 * - `loaded` is the difference between "you own no avatar" and "custody has
 *   not been read yet". Upstream the identity is the account, so there is no
 *   such gap; here, treating an unfinished read as an empty one would put the
 *   BUY AN AVATAR gate over a playable board on every load.
 * - `update` exists because custody changes on chain: a purchase creates an
 *   avatar, a seizure takes it away, and neither is something this store can
 *   learn from the account it is watching.
 */
export type ActiveIdentityStore = Readable<GameIdentity | undefined> & {
	/** Whether custody has been read for the current account. */
	loaded: Readable<boolean>;
	/** Re-read custody. Called when something is known to have changed it. */
	update(): Promise<void>;
};

/**
 * The identity PROVIDER: where the active identity comes from.
 *
 * D6 requires that identity be a SELECTION rather than a derivation, even
 * where there is exactly one of them. On `main` that rule costs nothing
 * because the account IS the identity; here it is load-bearing, because the
 * answer genuinely has to be looked up and can genuinely be "none".
 *
 * THIS GAME DOES NOT YET CHOOSE, and the difference from `main` is that it
 * COULD. An account can hold several avatars, and this picks the first one
 * still in custody. Remembering a choice per owner across reloads is what
 * reveal-or-die's `world/active-avatar.ts` does and what D6 will want; it is
 * deliberately not built, because nothing on this branch can exercise it and
 * an unexercised selection UI is the thing this project keeps deleting.
 *
 * WHY IT FILTERS RATHER THAN TRUSTING THE LIST. `getAvatarsOf` is every avatar
 * this account has ever put in, including ones it has taken back out and ones
 * it has LOST by never revealing - the contract keeps the list append-only on
 * purpose (see `UsingAvatarIdentity`). So custody is asked about each one, and
 * an avatar that has been seized simply stops being an identity. That is the
 * stake being real, arriving in the client as an empty board and a gate.
 */
export function createActiveIdentity(params: {
	/** Who is signed in, which is who avatars belong to. */
	account: Readable<`0x${string}` | undefined>;
	deps: Pick<Context, 'publicClient' | 'deployments'>;
}): ActiveIdentityStore {
	const {account, deps} = params;
	const state = writable<{loaded: boolean; identity: GameIdentity | undefined}>(
		{loaded: false, identity: undefined},
	);

	async function update() {
		const owner = get(account);
		if (!owner) {
			// Not signed in. `loaded` stays FALSE rather than reporting an empty
			// custody: "nobody is here" is the sign-in gate's answer, and claiming
			// to have read the chain about an account that does not exist would let
			// the stake gate answer a question nobody asked.
			state.set({loaded: false, identity: undefined});
			return;
		}
		const deployments = deps.deployments.get();
		const game = {
			address: deployments.contracts.Game.address,
			abi: deployments.contracts.Game.abi,
		};
		const candidates = (await deps.publicClient.readContract({
			...game,
			functionName: 'getAvatarsOf',
			args: [owner],
		})) as readonly bigint[];

		for (const avatarID of candidates) {
			const holder = (await deps.publicClient.readContract({
				...game,
				functionName: 'getAvatarOwner',
				args: [avatarID],
			})) as `0x${string}`;
			if (holder.toLowerCase() === owner.toLowerCase()) {
				state.set({loaded: true, identity: avatarID});
				return;
			}
		}
		state.set({loaded: true, identity: undefined});
	}

	// Signing in, signing out and switching accounts all change the answer, and
	// none of them is something a consumer should have to remember to announce.
	account.subscribe(() => void update());

	// `$custody` rather than the `$state` this repo's naming convention would
	// suggest: `svelte-conventions-boundary.test.ts` matches rune names as
	// words, so a callback parameter called `$state` reads as a rune in a `.ts`
	// file and fails the build. Cheap to avoid, invisible until it happens.
	return {
		subscribe: derived(state, ($custody) => $custody.identity).subscribe,
		loaded: derived(state, ($custody) => $custody.loaded),
		update,
	};
}
