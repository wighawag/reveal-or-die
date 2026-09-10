import {describe, expect, it} from 'vitest';
import {get, writable, type Readable} from 'svelte/store';
import {createReserve, type ReserveDeps} from '$lib/placement/reserve';
import type {PlacementConfig} from '$lib/placement/config';
import type {ActiveIdentityStore} from '$lib/game/identity';

/**
 * WHAT IS AT STAKE, read correctly - which on this branch is custody.
 *
 * Upstream this suite pins two silent failures in a chain read. Here the store
 * makes no chain read at all: custody IS identity on a game whose players are
 * avatars, so it derives from the identity provider rather than asking the
 * same question twice and being able to disagree with itself for a frame.
 *
 * That moves what can go wrong, and this file follows it. The failure that
 * matters now is the LOADING one, and it is invisible in a screenshot: an
 * unfinished custody read must not look like an account with no avatar, or the
 * BUY AN AVATAR gate covers a playable board on every load. Upstream has the
 * same trap and says so at `setupNeeded`; here it is easier to fall into,
 * because "no identity yet" and "no avatar" are the same value.
 */

const config = {} as unknown as PlacementConfig;

/** An identity provider, at whatever point in its life a test needs it. */
function fakeIdentity(state: {
	loaded: boolean;
	identity?: bigint;
}): ActiveIdentityStore & {updates: number} {
	let updates = 0;
	const store = writable<bigint | undefined>(state.identity);
	const identity = {
		subscribe: store.subscribe,
		loaded: writable(state.loaded) as Readable<boolean>,
		update: async () => {
			updates++;
		},
		get updates() {
			return updates;
		},
	};
	return identity as ActiveIdentityStore & {updates: number};
}

const deps = {
	connection: {ensureConnected: async () => {}},
	accountExecutor: writable({status: 'ready'}),
	account: writable('0x2222222222222222222222222222222222222222'),
	accountBalance: writable({step: 'Loaded', value: 10n ** 18n}),
	balanceCheck: {ensureCanAfford: async (o: unknown) => o},
	deployments: writable({contracts: {Game: {address: '0xgame', abi: []}}}),
	publicClient: {},
} as unknown as ReserveDeps;

describe('what is at stake', () => {
	it('says nothing until custody has been read', () => {
		// `Unloaded` rather than "you have no avatar". The setup gate reads this
		// store, and an unfinished read reported as an empty one puts the gate
		// over a board the player can already use.
		const reserve = createReserve({
			deps,
			config,
			identity: fakeIdentity({loaded: false}),
		});

		expect(get(reserve)).toEqual({step: 'Unloaded'});
	});

	it('is one avatar when one is in the game', () => {
		const reserve = createReserve({
			deps,
			config,
			identity: fakeIdentity({loaded: true, identity: 3n}),
		});

		expect(get(reserve)).toEqual({
			step: 'Loaded',
			amount: 1n,
			tokenBalance: 0n,
		});
	});

	it('is none when custody has been read and there is nothing', () => {
		// The gate's actual trigger: `amount === 0n` on a LOADED read is what
		// tells the player to go and get an avatar.
		const reserve = createReserve({
			deps,
			config,
			identity: fakeIdentity({loaded: true}),
		});

		expect(get(reserve)).toEqual({
			step: 'Loaded',
			amount: 0n,
			tokenBalance: 0n,
		});
	});

	it('counts an avatar of id zero as an avatar', () => {
		// `0n` is falsy, and an emptiness test written as `if (!identity)` would
		// report the one player whose token id is zero as having nothing at
		// stake - forever, silently, while every other player is fine. This
		// game's sale never mints id zero, and a game that inherits this file
		// might.
		const reserve = createReserve({
			deps,
			config,
			identity: fakeIdentity({loaded: true, identity: 0n}),
		});

		expect(get(reserve)).toMatchObject({step: 'Loaded', amount: 1n});
	});

	it('re-reads custody rather than keeping a count of its own', () => {
		// `update()` is called after a purchase and after a forfeit is settled.
		// Both change custody on chain, and the identity provider is the only
		// thing that reads it, so anything else here would be a second copy of
		// the answer that can disagree with the board.
		const identity = fakeIdentity({loaded: true, identity: 3n});
		const reserve = createReserve({deps, config, identity});

		void reserve.update();

		expect(identity.updates).toBe(1);
	});
});
