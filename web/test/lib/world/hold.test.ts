import {describe, expect, it} from 'vitest';
import {get, writable} from 'svelte/store';
import {holdBoardUntilRoundEnds, holdResolvingRound} from '$lib/world/hold';
import {emptyWorld, type Avatar, type WorldState} from '$lib/world/state';
import {ActionType, xyToBigIntID} from 'reveal-or-die-contracts';

/**
 * Showing a round's outcome all at once, when the round is over.
 *
 * Reveals arrive one transaction at a time, in whatever order the mempool
 * delivers them, so a board that applies each as it lands draws a SIMULTANEOUS
 * round in payment order: avatar A moves, four seconds pass, avatar B moves.
 * That is not what happened, and it leaks who revealed first.
 */
const OWNER = '0x1111111111111111111111111111111111111111' as const;

function avatar(over: Partial<Avatar> & {avatarID: bigint}): Avatar {
	return {
		owner: OWNER,
		inGame: true,
		position: {x: 0, y: 0},
		lastEpoch: 6,
		life: 1,
		...over,
	};
}

function world(...avatars: Avatar[]): WorldState & {epoch: number} {
	const state = emptyWorld();
	for (const a of avatars) state.avatars.set(a.avatarID, a);
	return {...state, epoch: 7};
}

/**
 * `lastEpoch` AND `lastTurn` TOGETHER, because the chain cannot produce one
 * without the other: `_resolveActions` ends every resolved turn with
 * `_avatars[avatarID].lastEpoch = epoch`, and the log it emits carries the same
 * epoch. A fixture that advanced only the log described an avatar that cannot
 * exist, which is why these two helpers now set both.
 *
 * The reverse IS producible, and has its own tests below: the entity read
 * always carries `lastEpoch`, while the log read is allowed to come back empty.
 */
const movedThisRound = (id: bigint, to: {x: number; y: number}) =>
	avatar({
		avatarID: id,
		position: to,
		lastEpoch: 7,
		lastTurn: {
			epoch: 7,
			actions: [{actionType: ActionType.Move, data: xyToBigIntID(to.x, to.y)}],
		},
	});

/** The same turn as the chain reports it when the log read came back empty. */
const movedThisRoundWithoutItsLog = (id: bigint, to: {x: number; y: number}) =>
	avatar({avatarID: id, position: to, lastEpoch: 7});

const enteredThisRound = (id: bigint, at: {x: number; y: number}) =>
	avatar({
		avatarID: id,
		position: at,
		lastEpoch: 7,
		lastTurn: {
			epoch: 7,
			actions: [{actionType: ActionType.Enter, data: xyToBigIntID(at.x, at.y)}],
		},
	});

describe('holding the round being resolved', () => {
	it('keeps an avatar where it was until the round is over', () => {
		const shown = world(avatar({avatarID: 1n, position: {x: 0, y: 0}}));
		const held = holdResolvingRound({
			shown,
			latest: world(movedThisRound(1n, {x: 3, y: 0})),
			resolvingEpoch: 7,
		});
		expect(held.avatars.get(1n)?.position).toEqual({x: 0, y: 0});
	});

	it('lets through an avatar this round did not touch', () => {
		// Its last turn was an earlier round, so what the chain says about it is
		// not part of the outcome being withheld - holding it would be drawing a
		// stale board rather than a synchronised one.
		const shown = world(avatar({avatarID: 1n, position: {x: 0, y: 0}}));
		const older = avatar({
			avatarID: 1n,
			position: {x: 9, y: 9},
			lastTurn: {epoch: 5, actions: []},
		});
		const held = holdResolvingRound({
			shown,
			latest: world(older),
			resolvingEpoch: 7,
		});
		expect(held.avatars.get(1n)?.position).toEqual({x: 9, y: 9});
	});

	it('lets through an avatar that has just come into view', () => {
		// The player panned. It is not new to the WORLD, only to this camera, and
		// there is nothing held to show instead.
		const held = holdResolvingRound({
			shown: emptyWorld(),
			latest: world(avatar({avatarID: 2n, position: {x: 4, y: 4}})),
			resolvingEpoch: 7,
		});
		expect(held.avatars.get(2n)?.position).toEqual({x: 4, y: 4});
	});

	it('hides an avatar that ENTERED in the round being resolved', () => {
		// It was genuinely not on the board when the round began, so showing it
		// early is the leak this exists to prevent: everyone appears together.
		const held = holdResolvingRound({
			shown: emptyWorld(),
			latest: world(enteredThisRound(3n, {x: 1, y: 1})),
			resolvingEpoch: 7,
		});
		expect(held.avatars.has(3n)).toBe(false);
	});

	it('shows an avatar that moved this round but was never on screen', () => {
		// Panned onto mid-round: its turn is this round's, but it was on the
		// board before it - there is no "where it was" to hold, and hiding a
		// standing avatar would be worse than showing it a moment early.
		const held = holdResolvingRound({
			shown: emptyWorld(),
			latest: world(movedThisRound(4n, {x: 2, y: 2})),
			resolvingEpoch: 7,
		});
		expect(held.avatars.get(4n)?.position).toEqual({x: 2, y: 2});
	});

	it('holds a turn whose REVEAL LOG did not arrive', () => {
		// The defect this rule was rewritten for. `readResolvedTurns` catches its
		// own failures on purpose - losing the animation beats losing the board -
		// so `lastTurn` is allowed to be absent, and taking the hold's decision
		// from it meant one such fetch let the whole round through mid-window.
		// `lastEpoch` comes from storage in the same pinned read and cannot be.
		const shown = world(avatar({avatarID: 1n, position: {x: 0, y: 0}}));
		const held = holdResolvingRound({
			shown,
			latest: world(movedThisRoundWithoutItsLog(1n, {x: 3, y: 0})),
			resolvingEpoch: 7,
		});
		expect(held.avatars.get(1n)?.position).toEqual({x: 0, y: 0});
	});

	it('shows an avatar panned onto mid-round when no log can say what it did', () => {
		// The deliberate default when the log is missing, and the reason it is not
		// the cautious-looking one: every avatar reveals every epoch now (the
		// client commits empty turns to keep them alive), so "revealed this round"
		// describes almost the whole board, and hiding on a missing log would blank
		// most of it the moment a player panned during a reveal window. The risk
		// taken instead is one ENTRY appearing a few seconds early.
		const held = holdResolvingRound({
			shown: emptyWorld(),
			latest: world(movedThisRoundWithoutItsLog(4n, {x: 2, y: 2})),
			resolvingEpoch: 7,
		});
		expect(held.avatars.get(4n)?.position).toEqual({x: 2, y: 2});
	});

	it('does not hide an avatar whose ENTRY was an earlier round', () => {
		// It entered last round and moved in this one, and this round's log is the
		// one that went missing - so the newest log still on file says "Enter".
		// Reading that as an entry would delete an avatar that has been standing in
		// the world since before the round began.
		const held = holdResolvingRound({
			shown: emptyWorld(),
			latest: world(
				avatar({
					avatarID: 5n,
					position: {x: 2, y: 2},
					lastEpoch: 7,
					lastTurn: {
						epoch: 6,
						actions: [{actionType: ActionType.Enter, data: xyToBigIntID(2, 2)}],
					},
				}),
			),
			resolvingEpoch: 7,
		});
		expect(held.avatars.get(5n)?.position).toEqual({x: 2, y: 2});
	});

	it('carries the rest of the state through untouched', () => {
		const held = holdResolvingRound({
			shown: emptyWorld(),
			latest: world(avatar({avatarID: 1n})),
			resolvingEpoch: 7,
		});
		expect(held.epoch).toEqual(7);
	});
});

describe('the board store the renderer reads', () => {
	function setup(initialPhase: 'play' | 'wait') {
		const state = writable<
			{step: 'Unloaded'} | ({step: 'Loaded'} & WorldState & {epoch: number})
		>({step: 'Unloaded'});
		const phase = writable<{phase: 'play' | 'wait'}>({phase: initialPhase});
		const epoch = writable(7);
		const {board, holding} = holdBoardUntilRoundEnds({
			state: {
				subscribe: state.subscribe,
				status: writable({loading: false}),
				update: async () => {},
			} as never,
			phase,
			epoch,
		});
		const load = (world: WorldState & {epoch: number}) =>
			state.set({step: 'Loaded', ...world});
		return {board, holding, phase, epoch, load, state};
	}

	const positionOf = (
		value: {step: 'Unloaded'} | ({step: 'Loaded'} & WorldState),
		id: bigint,
	) => (value.step === 'Loaded' ? value.avatars.get(id)?.position : undefined);

	it('holds a fetch that lands mid-round, and releases it when the round ends', () => {
		const {board, phase, load} = setup('play');
		const seen: unknown[] = [];
		const stop = board.subscribe((v) => seen.push(v));

		load(world(avatar({avatarID: 1n, position: {x: 0, y: 0}})));
		expect(positionOf(get(board) as never, 1n)).toEqual({x: 0, y: 0});

		// The round starts resolving, and the reveal lands.
		phase.set({phase: 'wait'});
		load(world(movedThisRound(1n, {x: 3, y: 0})));
		expect(positionOf(get(board) as never, 1n)).toEqual({x: 0, y: 0});

		// The round is over: everything that happened in it appears at once.
		phase.set({phase: 'play'});
		expect(positionOf(get(board) as never, 1n)).toEqual({x: 3, y: 0});
		stop();
	});

	it('shows the newest board when there is nothing on screen to hold against', () => {
		// A page opened mid-round has no "before" to keep showing, and a blank
		// board would be a worse lie than an early one.
		const {board, load} = setup('wait');
		const stop = board.subscribe(() => {});
		load(world(movedThisRound(1n, {x: 3, y: 0})));
		expect(positionOf(get(board) as never, 1n)).toEqual({x: 3, y: 0});
		stop();
	});

	it('holds against what is ON SCREEN, not against each new fetch', () => {
		// Several fetches land during a ten second window; each must hold to the
		// same drawn board rather than to the one before it.
		const {board, phase, load} = setup('play');
		const stop = board.subscribe(() => {});
		load(world(avatar({avatarID: 1n, position: {x: 0, y: 0}})));
		phase.set({phase: 'wait'});
		load(world(movedThisRound(1n, {x: 3, y: 0})));
		load(world(movedThisRound(1n, {x: 3, y: 0})));
		expect(positionOf(get(board) as never, 1n)).toEqual({x: 0, y: 0});
		stop();
	});

	it('says which round it is holding, so the overlay can wait for the same moment', () => {
		// THE RELEASE IS PUBLISHED rather than left to be guessed at. The local
		// overlay of a turn - the planned dots, the entering preview - has to stay
		// on screen until the board lets the outcome out; a second reading of
		// "roughly now" disagrees by a frame or a poll, and the gap between the two
		// is a player watching their own avatar vanish.
		const {board, holding, phase, load} = setup('play');
		const stop = board.subscribe(() => {});
		const stopHolding = holding.subscribe(() => {});

		load(world(avatar({avatarID: 1n, position: {x: 0, y: 0}})));
		expect(get(holding)).toBeUndefined();

		phase.set({phase: 'wait'});
		load(world(movedThisRound(1n, {x: 3, y: 0})));
		expect(get(holding)).toBe(7);

		phase.set({phase: 'play'});
		expect(get(holding)).toBeUndefined();
		stopHolding();
		stop();
	});

	it('is not holding anything when there was nothing on screen to hold', () => {
		// A page opened mid-round shows the newest board, so there is no outcome
		// being withheld and nothing for an overlay to wait for.
		const {board, holding, load} = setup('wait');
		const stop = board.subscribe(() => {});
		const stopHolding = holding.subscribe(() => {});
		load(world(movedThisRound(1n, {x: 3, y: 0})));
		expect(get(holding)).toBeUndefined();
		stopHolding();
		stop();
	});

	it('is not holding anything while the board is Unloaded', () => {
		const {board, holding, phase, load, state} = setup('play');
		const stop = board.subscribe(() => {});
		const stopHolding = holding.subscribe(() => {});
		load(world(avatar({avatarID: 1n})));
		phase.set({phase: 'wait'});
		state.set({step: 'Unloaded'});
		expect(get(holding)).toBeUndefined();
		stopHolding();
		stop();
	});

	it('does not release the round early, and stay released, over one logless fetch', () => {
		// The damage was STICKY: the board handed out becomes the memory, so a
		// single fetch that let the round through left it through for the rest of
		// the window - and the walk at the boundary was then skipped, because
		// `AvatarObject.updateWalk` refuses a replay whose destination is already
		// where the avatar is drawn. The player saw the board flash to its new
		// positions mid-reveal and then stand still when it should have animated.
		const {board, phase, load} = setup('play');
		const stop = board.subscribe(() => {});

		load(world(avatar({avatarID: 1n, position: {x: 0, y: 0}})));
		phase.set({phase: 'wait'});

		// The fetch whose logs did not arrive...
		load(world(movedThisRoundWithoutItsLog(1n, {x: 3, y: 0})));
		expect(positionOf(get(board) as never, 1n)).toEqual({x: 0, y: 0});

		// ...and the next one, with them back. Still held, and still against where
		// the avatar actually stood when the round began.
		load(world(movedThisRound(1n, {x: 3, y: 0})));
		expect(positionOf(get(board) as never, 1n)).toEqual({x: 0, y: 0});

		phase.set({phase: 'play'});
		expect(positionOf(get(board) as never, 1n)).toEqual({x: 3, y: 0});
		stop();
	});

	it('lets an Unloaded board through at once', () => {
		// The board is no longer known to be true (an account switch, a chain
		// reset). There is nothing to synchronise and nothing to hold.
		const {board, phase, load, state} = setup('play');
		const stop = board.subscribe(() => {});
		load(world(avatar({avatarID: 1n})));
		phase.set({phase: 'wait'});
		state.set({step: 'Unloaded'});
		expect((get(board) as {step: string}).step).toBe('Unloaded');
		stop();
	});
});
