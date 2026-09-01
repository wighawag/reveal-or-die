import {describe, expect, it} from 'vitest';
import {avatarChanged} from '$lib/world/render/avatar-renderer';
import type {AvatarView} from '$lib/world/view';

function view(over: Partial<AvatarView> = {}): AvatarView {
	return {
		avatarID: 1n,
		owner: '0x1111111111111111111111111111111111111111',
		inGame: true,
		position: {x: 1, y: 2},
		lastEpoch: 3,
		life: 1,
		isPlayer: false,
		planned: [],
		plannedPosition: {x: 1, y: 2},
		entering: false,
		...over,
	};
}

describe('avatarChanged', () => {
	it('says nothing changed for an equal but freshly built entity', () => {
		// This is the case the whole function exists for: mergeWorldView rebuilds
		// every AvatarView on every derive, so by reference the entire board
		// changes each time the poller returns. Reference inequality would redraw
		// everything, several times a minute, forever.
		expect(view()).not.toBe(view());
		expect(avatarChanged(view(), view())).toBe(false);
	});

	it('notices a move', () => {
		expect(avatarChanged(view(), view({position: {x: 1, y: 3}}))).toBe(true);
		expect(avatarChanged(view(), view({position: {x: 2, y: 2}}))).toBe(true);
	});

	it('notices the avatar becoming the player, with nothing else different', () => {
		// The bug this closes: "which avatar is mine" used to be pushed in through
		// a separate call rather than being part of the entity, so it was not part
		// of what the diff compared. An avatar that became the player's without
		// otherwise changing kept drawing as somebody else's, indefinitely.
		expect(avatarChanged(view(), view({isPlayer: true}))).toBe(true);
		expect(avatarChanged(view({isPlayer: true}), view())).toBe(true);
	});

	it('notices death, spawning, and a change of owner', () => {
		expect(avatarChanged(view(), view({life: 0}))).toBe(true);
		expect(avatarChanged(view(), view({entering: true}))).toBe(true);
		expect(
			avatarChanged(
				view(),
				view({owner: '0x2222222222222222222222222222222222222222'}),
			),
		).toBe(true);
	});

	it('notices a plan appearing, changing and being cleared', () => {
		const planned = view({
			planned: [{type: 'move', to: {x: 1, y: 3}}],
			plannedPosition: {x: 1, y: 3},
		});
		expect(avatarChanged(view(), planned)).toBe(true);
		expect(avatarChanged(planned, view())).toBe(true);

		const longer = view({
			planned: [
				{type: 'move', to: {x: 1, y: 3}},
				{type: 'move', to: {x: 1, y: 4}},
			],
			plannedPosition: {x: 1, y: 4},
		});
		expect(avatarChanged(planned, longer)).toBe(true);
	});

	it('notices a plan of the same length that ends somewhere else', () => {
		// length alone is not enough: re-planning one step to a different cell
		// leaves the count identical, and the path would otherwise never redraw.
		const a = view({
			planned: [{type: 'move', to: {x: 1, y: 3}}],
			plannedPosition: {x: 1, y: 3},
		});
		const b = view({
			planned: [{type: 'move', to: {x: 2, y: 2}}],
			plannedPosition: {x: 2, y: 2},
		});
		expect(avatarChanged(a, b)).toBe(true);
	});

	it('ignores fields that do not affect the picture', () => {
		// lastEpoch and inGame are not drawn, so a change in them must not cost a
		// redraw of every avatar on the board.
		expect(avatarChanged(view(), view({lastEpoch: 99}))).toBe(false);
		expect(avatarChanged(view(), view({inGame: false}))).toBe(false);
	});
});

describe('a resolved turn arriving', () => {
	/**
	 * The diff decides whether `update` is called at all, so anything the object
	 * needs to HEAR about has to be compared here. A resolved turn is the one
	 * fact that can arrive without moving the avatar: a step the contract
	 * refused, or an exit, leaves every other field where it was.
	 */
	const turn = (epoch: number) => ({
		epoch,
		actions: [{type: 'move' as const, to: {x: 1, y: 2}}],
	});

	it('is a change, even when nothing else about the avatar is', () => {
		expect(avatarChanged(view(), view({lastTurn: turn(4)}))).toBe(true);
		expect(
			avatarChanged(view({lastTurn: turn(4)}), view({lastTurn: turn(5)})),
		).toBe(true);
	});

	it('is not a change when the same turn is re-read', () => {
		// The poller re-reads every few seconds and hands back the same turn until
		// the next epoch resolves. Treating that as a change would restart the
		// animation on every poll.
		expect(
			avatarChanged(view({lastTurn: turn(4)}), view({lastTurn: turn(4)})),
		).toBe(false);
	});
});
