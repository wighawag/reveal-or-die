import {describe, expect, it} from 'vitest';
import {mergeWorldView, type LocalPlan} from '$lib/world/view';
import {emptyWorld, type Avatar, type WorldState} from '$lib/world/state';

const PLAYER = '0x1111111111111111111111111111111111111111' as const;
const OTHER = '0x2222222222222222222222222222222222222222' as const;

function avatar(over: Partial<Avatar> & {avatarID: bigint}): Avatar {
	return {
		owner: OTHER,
		inGame: true,
		position: {x: 0, y: 0},
		lastEpoch: 1,
		life: 1,
		...over,
	};
}

function world(...avatars: Avatar[]): WorldState {
	const state = emptyWorld();
	for (const a of avatars) state.avatars.set(a.avatarID, a);
	return state;
}

const noPlan: LocalPlan = {planned: []};

describe('mergeWorldView', () => {
	it('carries every onchain avatar through', () => {
		const view = mergeWorldView({
			onchain: world(avatar({avatarID: 1n}), avatar({avatarID: 2n})),
			local: noPlan,
			epoch: 5,
		});
		expect([...view.avatars.keys()]).toEqual([1n, 2n]);
		expect(view.epoch).toEqual(5);
	});

	it('marks only the active avatar as the player, on the entity', () => {
		const view = mergeWorldView({
			onchain: world(avatar({avatarID: 1n}), avatar({avatarID: 2n})),
			local: {activeAvatarID: 2n, player: PLAYER, planned: []},
			epoch: 5,
		});
		// on the ENTITY, because the stateful renderer only re-draws entities its
		// diff says changed. Held outside, "this one is mine" is applied once and
		// never re-applied.
		expect(view.avatars.get(1n)!.isPlayer).toBe(false);
		expect(view.avatars.get(2n)!.isPlayer).toBe(true);
		expect(view.activeAvatarID).toEqual(2n);
	});

	it('leaves position alone and reports intent separately', () => {
		const view = mergeWorldView({
			onchain: world(avatar({avatarID: 1n, position: {x: 0, y: 1}})),
			local: {
				activeAvatarID: 1n,
				player: PLAYER,
				planned: [
					{type: 'move', to: {x: 0, y: 2}},
					{type: 'move', to: {x: 0, y: 3}},
				],
			},
			epoch: 5,
		});
		const a = view.avatars.get(1n)!;
		// where it IS, unchanged: the chain has not moved it
		expect(a.position).toEqual({x: 0, y: 1});
		// where the player SAID it should go: the last planned step
		expect(a.plannedPosition).toEqual({x: 0, y: 3});
		expect(a.planned).toHaveLength(2);
	});

	it('invents the avatar when the player has planned to enter', () => {
		// nothing on chain yet: a player who picks a spawn and sees nothing until
		// the reveal lands an epoch later cannot tell the click registered.
		const view = mergeWorldView({
			onchain: emptyWorld(),
			local: {
				activeAvatarID: 7n,
				player: PLAYER,
				planned: [{type: 'enter', to: {x: 0, y: 1}}],
			},
			epoch: 5,
		});
		const a = view.avatars.get(7n)!;
		expect(a.entering).toBe(true);
		expect(a.inGame).toBe(false);
		expect(a.isPlayer).toBe(true);
		expect(a.owner).toEqual(PLAYER);
		expect(a.position).toEqual({x: 0, y: 1});
	});

	it('does not mark an avatar as entering once it is on chain', () => {
		const view = mergeWorldView({
			onchain: world(avatar({avatarID: 7n, position: {x: 0, y: 1}})),
			local: {
				activeAvatarID: 7n,
				player: PLAYER,
				planned: [{type: 'move', to: {x: 0, y: 2}}],
			},
			epoch: 6,
		});
		expect(view.avatars.get(7n)!.entering).toBe(false);
	});

	it('does not write the planned flag back onto the onchain state', () => {
		// the onchain store is the single source of truth; a re-derive must not
		// find a planned field left behind on it and read it as confirmed.
		const onchain = world(avatar({avatarID: 1n, position: {x: 0, y: 1}}));
		mergeWorldView({
			onchain,
			local: {
				activeAvatarID: 1n,
				player: PLAYER,
				planned: [{type: 'move', to: {x: 9, y: 9}}],
			},
			epoch: 5,
		});
		const stored = onchain.avatars.get(1n)! as Avatar & {planned?: unknown};
		expect(stored.planned).toBeUndefined();
		expect(stored.position).toEqual({x: 0, y: 1});
	});

	it('ignores a plan for an avatar nobody is playing', () => {
		const view = mergeWorldView({
			onchain: world(avatar({avatarID: 1n})),
			local: {planned: [{type: 'move', to: {x: 5, y: 5}}]},
			epoch: 5,
		});
		expect(view.activeAvatarID).toBeUndefined();
		expect(view.avatars.get(1n)!.plannedPosition).toEqual({x: 0, y: 0});
	});
});

describe('the turn the chain resolved', () => {
	/**
	 * `CommitmentRevealed` carries the actions the contract ACCEPTED, per
	 * avatar. Carrying them onto the view is what lets the renderer replay every
	 * avatar's turn rather than teleporting each one to its new cell, and it is
	 * the only thing on the entity that says what HAPPENED as opposed to what is.
	 */
	it('arrives in the renderer\u2019s vocabulary, not the contract\u2019s', () => {
		const view = mergeWorldView({
			onchain: world(
				avatar({
					avatarID: 1n,
					lastTurn: {
						epoch: 7,
						// Move to (1,0), then Exit named at the same cell.
						actions: [
							{actionType: 1, data: 1n},
							{actionType: 2, data: 1n},
						],
					},
				}),
			),
			local: noPlan,
			epoch: 7,
		});
		expect(view.avatars.get(1n)?.lastTurn).toEqual({
			epoch: 7,
			actions: [
				{type: 'move', to: {x: 1, y: 0}},
				{type: 'exit', to: {x: 1, y: 0}},
			],
		});
	});

	it('is absent for an avatar whose reveal was not fetched', () => {
		// Outside the block range, or it has not acted since. The renderer reads
		// that as "nothing to replay" rather than as an empty turn.
		const view = mergeWorldView({
			onchain: world(avatar({avatarID: 1n})),
			local: noPlan,
			epoch: 7,
		});
		expect(view.avatars.get(1n)?.lastTurn).toBeUndefined();
	});

	it('is carried for OTHER players too, which is the point of it', () => {
		// The event is per avatar and indexed by zone, so the client learns every
		// visible avatar's turn, not only the one it is playing.
		const view = mergeWorldView({
			onchain: world(
				avatar({avatarID: 1n}),
				avatar({
					avatarID: 2n,
					owner: OTHER,
					lastTurn: {epoch: 7, actions: [{actionType: 1, data: 1n}]},
				}),
			),
			local: {planned: [], activeAvatarID: 1n, player: PLAYER},
			epoch: 7,
		});
		const other = view.avatars.get(2n);
		expect(other?.isPlayer).toBe(false);
		expect(other?.lastTurn?.actions).toHaveLength(1);
	});
});
