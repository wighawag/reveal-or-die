/**
 * WHICH avatar this client is playing.
 *
 * The template's game is keyed by the account address, so it never has to
 * choose: there is exactly one identity and the chain hands it over. This game
 * commits per AVATAR, and an account can own several, so somebody has to pick
 * one and the pick has to survive a reload.
 *
 * ONE ACTIVE AVATAR PER CLIENT, decided in docs/plans/web-port.md. Nothing on
 * chain partitions authority per avatar - `_requireAccountForAvatar` resolves
 * the avatar's OWNER and asks whether the sender may act for that account - so
 * every signer the account has delegated can move every avatar it owns. Keeping
 * one active avatar per client is therefore a CLIENT CONVENTION and not a
 * guarantee; it is what stops two tabs committing over each other, and a player
 * who wants to run two avatars opens a second browser.
 *
 * It is also why the round's storage key includes the avatar id
 * (see ./storage.ts): switching the active avatar with a key that did not would
 * load the previous avatar's planned actions and commit them for the new one.
 */
import {derived, get, writable, type Readable} from 'svelte/store';
import type {DepositedAvatar, DepositedState} from './deposited';

const PREFIX = '__world_avatar_';

/**
 * Where the choice is remembered.
 *
 * Per OWNER as well as per deployment, because signing in as somebody else on
 * the same browser must not resume with an avatar that account does not own:
 * every call would revert with `NotAuthorizedOwner`, which reads as the game
 * being broken rather than as a stale choice.
 */
export function activeAvatarStorageKey(params: {
	chainID: string | number;
	gameAddress: string;
	owner: string;
}): string {
	return `${PREFIX}${params.chainID}_${params.gameAddress}_${params.owner}`.toLowerCase();
}

/**
 * Which avatar to play, given what the account has deposited.
 *
 * Pure, and separate from the store, because the two ways to get it wrong are
 * both invisible from reading it: forgetting to honour a choice the player
 * already made (so switching avatars silently undoes itself on the next poll),
 * and honouring one that is no longer playable (so the board looks fine and
 * every commit reverts).
 *
 * An avatar with no life left is not a candidate. It cannot act - `commit`
 * reverts with `AvatarIsDead` - so offering it as the active one would present
 * a playable board that refuses every move.
 *
 * Otherwise the one already IN the world wins over one on the bench. Switching
 * away from an avatar that is standing somewhere abandons it mid-game, and it
 * is still exposed to whatever else is on the board while nobody is moving it.
 */
export function chooseActiveAvatar(params: {
	avatars: readonly DepositedAvatar[];
	/** What the player last chose, if anything. */
	preferred: bigint | undefined;
}): bigint | undefined {
	const playable = params.avatars.filter((a) => a.life > 0);
	if (
		params.preferred !== undefined &&
		playable.some((a) => a.avatarID === params.preferred)
	) {
		return params.preferred;
	}
	return playable.find((a) => a.inGame)?.avatarID ?? playable[0]?.avatarID;
}

export type ActiveAvatarStore = Readable<bigint | undefined> & {
	readonly value: bigint | undefined;
	/**
	 * Play this avatar from now on. Ignored for an avatar the account has not
	 * deposited, because the contract would refuse every call made for it.
	 */
	select(avatarID: bigint): void;
};

/** Reading and writing the remembered choice, defensively. */
function createPreference(
	keyFor: (owner: string | undefined) => string | undefined,
) {
	return {
		read(owner: string | undefined): bigint | undefined {
			const k = keyFor(owner);
			if (!k || typeof localStorage === 'undefined') return undefined;
			try {
				const raw = localStorage.getItem(k);
				// A bigint, stored as a STRING: an avatar id is an address shifted
				// left 96 bits and cannot round-trip through a JSON number.
				return raw ? BigInt(raw) : undefined;
			} catch {
				return undefined;
			}
		},
		write(owner: string | undefined, avatarID: bigint | undefined) {
			const k = keyFor(owner);
			if (!k || typeof localStorage === 'undefined') return;
			try {
				if (avatarID === undefined) localStorage.removeItem(k);
				else localStorage.setItem(k, avatarID.toString());
			} catch {
				// Storage can be full or disabled. Losing the preference costs the
				// player one click next time; throwing here would take the board down.
			}
		},
	};
}

export function createActiveAvatar(params: {
	deposited: Readable<DepositedState>;
	/** The account whose avatars these are. */
	owner: Readable<`0x${string}` | undefined>;
	chainID: string | number;
	gameAddress: string;
}): ActiveAvatarStore {
	const {deposited, owner, chainID, gameAddress} = params;

	const preference = createPreference((o) =>
		o ? activeAvatarStorageKey({chainID, gameAddress, owner: o}) : undefined,
	);

	/**
	 * What the player last chose, IN MEMORY.
	 *
	 * Not read from storage on construction: this is built during SSR too, where
	 * there is no localStorage and no account yet. The stored value is consulted
	 * lazily below, once there is an owner to key it by.
	 */
	const chosen = writable<bigint | undefined>(undefined);

	/**
	 * `owner` is a DEPENDENCY, not something read out of band, because the stored
	 * preference is keyed by it: derived only from `deposited` and `chosen`, this
	 * would keep answering with the previous account's key until the next read
	 * happened to land.
	 *
	 * A `chosen` left over from a previous account needs no clearing. An avatar id
	 * is `owner << 96 | subID`, so it cannot appear in a different account's list,
	 * and `chooseActiveAvatar` drops anything that is not there.
	 */
	const active = derived(
		[deposited, chosen, owner],
		([$deposited, $chosen, $owner]): bigint | undefined => {
			if ($deposited.step !== 'Loaded') return undefined;
			return chooseActiveAvatar({
				avatars: $deposited.avatars,
				preferred: $chosen ?? preference.read($owner),
			});
		},
	);

	let value: bigint | undefined;
	active.subscribe((v) => (value = v));

	return {
		subscribe: active.subscribe,
		get value() {
			return value;
		},
		select(avatarID: bigint) {
			const $deposited = get(deposited);
			if (
				$deposited.step !== 'Loaded' ||
				!$deposited.avatars.some((a) => a.avatarID === avatarID)
			) {
				return;
			}
			preference.write(get(owner), avatarID);
			chosen.set(avatarID);
		},
	};
}
