import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {get} from 'svelte/store';

/**
 * THE LOBBY, WITHOUT BOOTING A WORLD.
 *
 * `$lib/offline` is mocked, and that is the point rather than a convenience:
 * what is worth asserting here is which world the lobby asks for and when it
 * asks at all, and a real boot would take a chain, a deploy and a browser to
 * say the same thing. The world's own half is asserted for real in
 * `test/lib/embedded/world.test.ts`, against a chain.
 *
 * The storage key the mock declares has to be the one the real module
 * declares, or these tests pass while the lobby forgets a key nothing else
 * uses - so the last test below asserts exactly that, against the real module.
 */
const started: {table: {occupant: {kind: string}}[]}[] = [];

vi.mock('$lib/offline', () => ({
	CHAIN_ID_STORAGE_KEY: 'offline-world:chain-id',
	startOfflineWorld: (params: {table: {occupant: {kind: string}}[]}) => {
		started.push(params);
		return Promise.resolve({step: 'Booting', what: 'in a test'});
	},
}));

const store = new Map<string, string>();
let reloads = 0;

beforeEach(async () => {
	started.length = 0;
	reloads = 0;
	store.clear();
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		removeItem: (key: string) => void store.delete(key),
	});
	vi.stubGlobal('location', {reload: () => void reloads++});
	vi.resetModules();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function lobby() {
	return import('$lib/offline-lobby');
}

describe('the offline lobby', () => {
	it('offers nothing until the browser has looked', async () => {
		// PRERENDER. Whether there is a world here is a question only this
		// browser's storage can answer, so the server cannot know which state is
		// right - and a chooser in prerendered HTML is a control on screen before
		// any handler is attached. Measured, not feared: a run that pressed eight
		// seats got three, silently, because the press landed before hydration and
		// the mount then reset the state.
		const {offlineLobby} = await lobby();
		expect(get(offlineLobby).step).toBe('Opening');
	});

	it('asks how many seats when there is no world yet', async () => {
		const {enterOfflineLobby, offlineLobby} = await lobby();
		enterOfflineLobby();

		expect(get(offlineLobby).step).toBe('Choosing');
		// NOTHING IS BOOTED BY ASKING. A lobby that started a world while the
		// player was still choosing would have provisioned the membership before
		// the choice, which is the one thing this whole design exists to prevent.
		expect(started).toHaveLength(0);
	});

	it('does not reset a choice when the route mounts again', async () => {
		// The lobby is app-scoped, like the world it starts, so navigating away
		// and back mounts the route a second time. A pass that reset the state
		// would throw away a choice the player was in the middle of making.
		const {enterOfflineLobby, chooseSeats, offlineLobby} = await lobby();
		enterOfflineLobby();
		chooseSeats(5);
		enterOfflineLobby();

		expect(get(offlineLobby)).toMatchObject({step: 'Choosing', seats: 5});
		expect(started).toHaveLength(0);
	});

	it('boots the table it was told to, once the player sits down', async () => {
		const {chooseSeats, sitDown, offlineLobby} = await lobby();
		chooseSeats(5);
		sitDown(get(offlineLobby).seats);

		expect(get(offlineLobby)).toMatchObject({step: 'Sat', seats: 5});
		expect(started).toHaveLength(1);
		expect(started[0].table).toHaveLength(5);
		expect(started[0].table.map((seat) => seat.occupant.kind)).toEqual([
			'you',
			'the-world',
			'the-world',
			'the-world',
			'the-world',
		]);
	});

	it('goes straight back into a world that is already here, at ITS count', async () => {
		// A booted world keeps the membership it was provisioned with. Offering
		// the chooser again would be offering a choice that cannot be honoured,
		// and honouring it silently would mean a table of three on a chain that
		// is waiting for four.
		store.set('offline-world:chain-id', '9007199254740123');
		store.set('offline-world:seats', '4');

		const {enterOfflineLobby, offlineLobby} = await lobby();
		enterOfflineLobby();

		expect(get(offlineLobby)).toMatchObject({step: 'Sat', seats: 4});
		expect(started[0].table).toHaveLength(4);
	});

	it('ignores a remembered count with no world behind it', async () => {
		// Both or neither: a seat record alone is not a world to carry on with,
		// and acting on it would boot a brand new world at a count nobody was
		// asked about on this visit.
		store.set('offline-world:seats', '4');

		const {enterOfflineLobby, offlineLobby} = await lobby();
		enterOfflineLobby();

		expect(get(offlineLobby).step).toBe('Choosing');
		expect(started).toHaveLength(0);
	});

	it('remembers the table BEFORE the boot, so an interrupted one still counts', async () => {
		const {sitDown} = await lobby();
		sitDown(4);
		expect(store.get('offline-world:seats')).toBe('4');
	});

	it('forgets the chain id when the player leaves, which is what makes it a NEW world', async () => {
		// Everything a player keeps is keyed by the chain id, so forgetting it is
		// the whole mechanism: the next boot mints one and builds beside the old
		// world rather than into it. Leaving the id behind would restore the old
		// membership under a new count, silently.
		store.set('offline-world:chain-id', '9007199254740123');
		store.set('offline-world:seats', '4');

		const {leaveTheTable} = await lobby();
		leaveTheTable();

		expect(store.has('offline-world:chain-id')).toBe(false);
		expect(store.has('offline-world:seats')).toBe(false);
		expect(reloads).toBe(1);
	});

	it('forgets the key the world actually writes', async () => {
		// Guards the guard. Every assertion above is written against the mock's
		// copy of the key, so a rename in `$lib/offline` would leave them green
		// while the lobby cleared a key nothing uses - and "leave this table"
		// would quietly go back into the same world.
		vi.doUnmock('$lib/offline');
		vi.resetModules();
		const real = await import('$lib/offline');
		expect(real.CHAIN_ID_STORAGE_KEY).toBe('offline-world:chain-id');
	});
});
