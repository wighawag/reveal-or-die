import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {get, writable} from 'svelte/store';
import {
	activeAvatarStorageKey,
	chooseActiveAvatar,
	createActiveAvatar,
} from '$lib/world/active-avatar';
import type {DepositedAvatar, DepositedState} from '$lib/world/deposited';

/**
 * One active avatar per client, and which one.
 *
 * The rule is a CLIENT CONVENTION rather than something the chain enforces (see
 * docs/plans/web-port.md), which is exactly why it is worth pinning: nothing
 * downstream will fail loudly if the choice drifts, the player just loses turns
 * to an avatar they did not mean to move.
 */

const avatar = (
	avatarID: bigint,
	overrides: Partial<DepositedAvatar> = {},
): DepositedAvatar => ({
	avatarID,
	inGame: false,
	position: 0n,
	lastEpoch: 0n,
	life: 3,
	...overrides,
});

describe('choosing which avatar to play', () => {
	it('has nothing to choose from an empty bench', () => {
		expect(
			chooseActiveAvatar({avatars: [], preferred: undefined}),
		).toBeUndefined();
	});

	it('keeps the avatar the player chose', () => {
		// The failure this prevents is silent: the deposited list is re-read on a
		// poll, and a choice that is not honoured would simply snap back to the
		// default a second after the player switched.
		expect(
			chooseActiveAvatar({
				avatars: [avatar(1n), avatar(2n)],
				preferred: 2n,
			}),
		).toEqual(2n);
	});

	it('ignores a choice the account no longer has', () => {
		// Withdrawn, sold, or belonging to the account that was signed in before.
		// Every call made for it would revert with `NotAuthorizedOwner`, which
		// reads as the game being broken rather than as a stale preference.
		expect(chooseActiveAvatar({avatars: [avatar(1n)], preferred: 99n})).toEqual(
			1n,
		);
	});

	it('never picks a dead avatar, even a chosen one', () => {
		// `commit` reverts with `AvatarIsDead`, so a dead avatar as the active one
		// is a board that looks playable and refuses every move.
		expect(
			chooseActiveAvatar({
				avatars: [avatar(1n, {life: 0}), avatar(2n)],
				preferred: 1n,
			}),
		).toEqual(2n);
	});

	it('has nothing to play when every avatar is dead', () => {
		expect(
			chooseActiveAvatar({
				avatars: [avatar(1n, {life: 0})],
				preferred: undefined,
			}),
		).toBeUndefined();
	});

	it('prefers one already in the world over one on the bench', () => {
		// Switching away from an avatar that is standing somewhere abandons it
		// mid-game while the board carries on around it.
		expect(
			chooseActiveAvatar({
				avatars: [avatar(1n), avatar(2n, {inGame: true})],
				preferred: undefined,
			}),
		).toEqual(2n);
	});
});

describe('the remembered choice', () => {
	it('is keyed by owner as well as by deployment', () => {
		// Two accounts on one browser own different avatars; resuming with the
		// other account's would revert on every call.
		const key = (owner: string) =>
			activeAvatarStorageKey({chainID: 31337, gameAddress: '0xGAME', owner});
		expect(key('0xAAA')).not.toEqual(key('0xBBB'));
		// Lowercased, so a checksummed address and a lowercase one are one key.
		expect(key('0xAaA')).toEqual(key('0xaaa'));
	});
});

/**
 * A localStorage that exists, so the persistence path is actually exercised.
 *
 * Node has none, and the module's guards degrade to "remember nothing", which
 * would make every assertion below pass without the code under test running.
 */
function installStorage(): Map<string, string> {
	const entries = new Map<string, string>();
	(globalThis as Record<string, unknown>).localStorage = {
		getItem: (k: string) => entries.get(k) ?? null,
		setItem: (k: string, v: string) => void entries.set(k, v),
		removeItem: (k: string) => void entries.delete(k),
	};
	return entries;
}

describe('the active-avatar store', () => {
	const make = (
		initial: DepositedState,
		owner: `0x${string}` | undefined = undefined,
	) => {
		const deposited = writable<DepositedState>(initial);
		const ownerStore = writable<`0x${string}` | undefined>(owner);
		const store = createActiveAvatar({
			deposited,
			owner: ownerStore,
			chainID: 31337,
			gameAddress: '0xGAME',
		});
		return {deposited, owner: ownerStore, store};
	};

	it('holds nothing until the deposited avatars have been read', () => {
		// Not "no avatar", which is a different answer: the gate in front of the
		// board must not tell a player to deposit one while the read is in flight.
		const {store} = make({step: 'Loading'});
		expect(get(store)).toBeUndefined();
	});

	it('settles on a default once they land', () => {
		const {deposited, store} = make({step: 'Loading'});
		deposited.set({step: 'Loaded', avatars: [avatar(7n)]});
		expect(get(store)).toEqual(7n);
		expect(store.value).toEqual(7n);
	});

	it('switches when asked', () => {
		const {store} = make({
			step: 'Loaded',
			avatars: [avatar(1n), avatar(2n)],
		});
		store.select(2n);
		expect(get(store)).toEqual(2n);
	});

	it('refuses an avatar the account has not deposited', () => {
		// The contract holds the avatar; one that is merely owned in the wallet
		// cannot be committed for, so accepting the choice would produce a board
		// that reverts rather than an error the player can act on.
		const {store} = make({step: 'Loaded', avatars: [avatar(1n)]});
		store.select(42n);
		expect(get(store)).toEqual(1n);
	});

	describe('across a reload and across accounts', () => {
		beforeEach(() => installStorage());
		afterEach(() => {
			delete (globalThis as Record<string, unknown>).localStorage;
		});

		it('resumes with the avatar the player last chose', () => {
			const avatars = [avatar(1n), avatar(2n)];
			make({step: 'Loaded', avatars}, '0xOWNER').store.select(2n);

			// A second store is what a reload looks like from here.
			const reloaded = make({step: 'Loaded', avatars}, '0xOWNER').store;
			expect(get(reloaded)).toEqual(2n);
		});

		it('re-reads the preference when the account changes', () => {
			// `owner` is a DEPENDENCY of the derive, not something read out of band.
			// Without that, switching account keeps answering from the previous
			// account's key until the deposited read next happens to land - and the
			// symptom is a stale avatar chosen for the wrong player.
			const a = [avatar(1n), avatar(2n)];
			make({step: 'Loaded', avatars: a}, '0xA').store.select(2n);

			const {owner, store} = make({step: 'Loaded', avatars: a}, '0xB');
			// Read through the LIVE value rather than `get()`, which subscribes
			// afresh and so recomputes whether or not `owner` is a dependency. This
			// is the reading a component holding the store actually sees.
			// 0xB has chosen nothing, so it gets the default.
			expect(store.value).toEqual(1n);
			owner.set('0xA');
			expect(store.value).toEqual(2n);
		});
	});
});
