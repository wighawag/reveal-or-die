import {describe, expect, it} from 'vitest';
import {get, writable, type Readable} from 'svelte/store';
import {holdPlanUntilBoardReleases} from '$lib/world/display-plan';
import {holdBoardUntilRoundEnds} from '$lib/world/hold';
import {createPlanning} from '$lib/world/planning';
import {createHud} from '$lib/world/ui/hud';
import {createViewState} from '$lib/view';
import {mergeWorldView, type AvatarView, type WorldView} from '$lib/world/view';
import {emptyWorld, type Avatar, type WorldState} from '$lib/world/state';
import type {Action} from '$lib/world/commit-reveal';
import type {WorldConfig} from '$lib/world/config';
import type {RoundState, RoundStore} from '$lib/game/core/round';
import type {Context} from '$lib/context/types';
import {ActionType, xyToBigIntID, type Position} from 'reveal-or-die-contracts';

/**
 * The handover between the two things that draw a turn.
 *
 * Before it resolves, the player's turn is drawn from LOCAL INTENT: planned
 * dots, an exit ring, and for an avatar that is not in the world yet, the
 * entering preview `mergeWorldView` invents. After it resolves, the same turn
 * is drawn from the BOARD, which holds it back until the round is over so that
 * a simultaneous round is not shown in the order the reveals were paid for.
 *
 * The round drops its actions the instant it reaches `Revealed`, seconds
 * before the board releases what they did, so the two used to change hands at
 * different moments and the player was shown NEITHER in between: the path
 * vanished while the avatar stood still, and a planned entry made the avatar
 * disappear from the board entirely for the rest of the reveal window.
 */
const ME = 7n;
const PLAYER = '0x1111111111111111111111111111111111111111' as const;
/** The corridor from `planning.test.ts`: (0,1), (0,2), (0,3) are walkable. */
const START: Position = {x: 0, y: 1};

const moveTo = (to: Position): Action => ({
	actionType: ActionType.Move,
	data: xyToBigIntID(to.x, to.y),
});
const enterAt = (at: Position): Action => ({
	actionType: ActionType.Enter,
	data: xyToBigIntID(at.x, at.y),
});

function avatar(over: Partial<Avatar> & {avatarID: bigint}): Avatar {
	return {
		owner: PLAYER,
		inGame: true,
		position: START,
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

/** A round whose step can be driven straight from the test. */
function fakeRound(initial: RoundState<Action> = {step: 'Idle'}) {
	const state = writable<RoundState<Action>>(initial);
	let value = initial;
	state.subscribe((v) => (value = v));
	const round = {
		subscribe: state.subscribe,
		get value() {
			return value;
		},
		plan: (actions: readonly Action[]) =>
			state.set({step: 'Planning', epoch: 7, actions: [...actions]}),
		commit: async () => {},
		reveal: async () => {},
		dismiss: () => {},
		start: () => () => {},
	} as unknown as RoundStore<bigint, Action>;
	return {round, state};
}

const config = {numMoves: 3} as WorldConfig;

/** The plan store exactly as the context builds it, from the real planning. */
function livePlan(round: RoundStore<bigint, Action>, at?: Position) {
	return createPlanning({
		round,
		config,
		currentPosition: writable(at) as Readable<Position | undefined>,
		activeAvatarID: writable(ME),
		player: writable(PLAYER),
	});
}

describe('the display copy of a turn', () => {
	function setup(at?: Position) {
		const {round, state} = fakeRound();
		const planning = livePlan(round, at);
		const holding = writable<number | undefined>(undefined);
		const display = holdPlanUntilBoardReleases({
			round,
			plan: planning.plan,
			holding,
		});
		const stop = display.subscribe(() => {});
		return {state, planning, holding, display, stop};
	}

	it('survives the reveal landing, which is when the round throws the actions away', () => {
		const {state, holding, display, stop} = setup(START);
		state.set({step: 'Planning', epoch: 7, actions: [moveTo({x: 0, y: 2})]});
		expect(get(display).planned).toHaveLength(1);

		// The round is resolving and the board is holding its outcome back.
		holding.set(7);
		// The reveal lands: `Revealed` carries no actions at all.
		state.set({step: 'Revealed', epoch: 7});
		expect(get(display).planned).toEqual([{type: 'move', to: {x: 0, y: 2}}]);
		stop();
	});

	it('clears when the board releases, and not a moment before', () => {
		const {state, holding, display, stop} = setup(START);
		state.set({step: 'Planning', epoch: 7, actions: [moveTo({x: 0, y: 2})]});
		holding.set(7);
		state.set({step: 'Revealed', epoch: 7});
		expect(get(display).planned).toHaveLength(1);

		// The round is over: the board is showing what the turn did, so the local
		// account of it is finished.
		holding.set(undefined);
		expect(get(display).planned).toHaveLength(0);
		stop();
	});

	it('never resurrects a turn from an earlier round', () => {
		// The player planned nothing this epoch, so there is nothing of theirs to
		// draw - and `commitWhenIdle` still commits and reveals an empty turn for
		// them every epoch, which is exactly when a memory with no epoch on it
		// would redraw last round's path.
		const {state, holding, display, stop} = setup(START);
		state.set({step: 'Planning', epoch: 7, actions: [moveTo({x: 0, y: 2})]});
		state.set({step: 'Revealed', epoch: 7});
		state.set({step: 'Idle'});

		holding.set(8);
		expect(get(display).planned).toHaveLength(0);
		stop();
	});

	it('forgets a path the player cleared before the round resolved', () => {
		// The last thing the round carried is what the turn WAS. A memory that
		// only kept non-empty plans would redraw a path the player deleted, for
		// the whole of the round the empty turn resolves in - and an empty turn is
		// not a rare case, it is what `commitWhenIdle` sends every epoch a player
		// stands still.
		const {state, holding, display, stop} = setup(START);
		state.set({step: 'Planning', epoch: 7, actions: [moveTo({x: 0, y: 2})]});
		state.set({step: 'Planning', epoch: 7, actions: []});
		state.set({step: 'Revealed', epoch: 7});
		holding.set(7);
		expect(get(display).planned).toHaveLength(0);
		stop();
	});

	it('leaves the plan the HUD and the controls read exactly where it was', () => {
		// FOR DISPLAY ONLY. Once a turn is committed there is nothing left to
		// undo, so `movesLeft`, the planned count and the Undo and Clear buttons
		// must keep reading the ROUND: a held display copy that reached them
		// would offer to take back a turn that is already on chain.
		const {state, planning, holding, display, stop} = setup(START);
		state.set({step: 'Planning', epoch: 7, actions: [moveTo({x: 0, y: 2})]});
		state.set({step: 'Revealed', epoch: 7});
		holding.set(7);

		expect(get(display).planned).toHaveLength(1);
		expect(get(planning.plan).planned).toHaveLength(0);
		expect(get(planning.movesLeft)).toBe(config.numMoves);
		stop();
	});

	it('is not what the HUD counts', () => {
		const {state, planning, holding, display, stop} = setup(START);
		state.set({step: 'Planning', epoch: 7, actions: [moveTo({x: 0, y: 2})]});
		state.set({step: 'Revealed', epoch: 7});
		holding.set(7);

		const hud = get(createHud(fakeContext(state, planning)));
		expect(get(display).planned).toHaveLength(1);
		expect(hud.plannedCount).toBe(0);
		expect(hud.canClear).toBe(false);
		expect(hud.movesLeft).toBe(config.numMoves);
		stop();
	});
});

/** A context with only the parts `createHud` reads, wired as the app wires it. */
function fakeContext(
	round: Readable<RoundState<Action>>,
	planning: ReturnType<typeof livePlan>,
) {
	return {
		hasLocalSigner: true,
		game: {
			twoPhase: writable({phase: 'wait', timeLeft: 5, duration: 20}),
			phase: writable('reveal'),
			round,
			// THE LIVE PLAN, which is the wiring under test as much as the values
			// are: the HUD is given what controls a turn, never the display copy.
			planning: {
				movesLeft: planning.movesLeft,
				plan: planning.plan,
				canExit: planning.canExit,
			},
			revealOutcome: writable(undefined),
			deposited: writable({
				step: 'Loaded',
				avatars: [
					{avatarID: ME, inGame: true, position: 0n, lastEpoch: 6n, life: 1},
				],
			}),
			activeAvatarID: writable(ME),
			currentPosition: writable(START),
			epochInfo: writable({currentEpoch: 7}),
			missedReveal: writable({step: 'Clear'}),
			setup: writable(undefined),
			purchase: writable({step: 'Idle'}),
			config: {sale: {price: 10000000000n}},
		},
		deployments: {get: () => ({chain: {nativeCurrency: {symbol: 'ETH'}}})},
	} as unknown as Context;
}

/**
 * The whole handover, composed the way the context composes it.
 *
 * Both halves turn on ONE signal - the board's own `holding` - and this is
 * what pins that: the assertions are over EVERY value the view emits across
 * the release, not over the value it settles on. A version where the overlay
 * clears on its own reading of the round or the epoch settles correctly and
 * still shows a hole, which is precisely the bug.
 */
describe('the handover, from the local overlay to the board', () => {
	function compose(round: RoundStore<bigint, Action>, at?: Position) {
		const state = writable<
			{step: 'Unloaded'} | ({step: 'Loaded'} & WorldState & {epoch: number})
		>({step: 'Unloaded'});
		const phase = writable<{phase: 'play' | 'wait'}>({phase: 'play'});
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
		const planning = livePlan(round, at);
		const viewState = createViewState({
			onchainState: board,
			localState: holdPlanUntilBoardReleases({
				round,
				plan: planning.plan,
				holding,
			}),
			merge: mergeWorldView,
		});

		const seen: (AvatarView | undefined)[] = [];
		const stop = viewState.subscribe((v) => {
			const view = v as {step: string} & WorldView;
			seen.push(view.step === 'Loaded' ? view.avatars.get(ME) : undefined);
		});
		const load = (w: WorldState & {epoch: number}) =>
			state.set({step: 'Loaded', ...w});
		return {seen, load, phase, planning, stop};
	}

	it('keeps a planned ENTRY on screen from the click to the avatar being real', () => {
		// The worst of the two symptoms. The entering preview is the ONLY thing
		// drawing this avatar - it is genuinely not on chain yet - and the board
		// deliberately hides the real one until the round ends, so a gap between
		// them is the player's avatar disappearing for several seconds.
		const {round, state} = fakeRound();
		const {seen, load, phase, stop} = compose(round);
		load(world());
		state.set({step: 'Planning', epoch: 7, actions: [enterAt(START)]});
		seen.length = 0;

		// The round closes, and the reveal lands: the chain now has the avatar,
		// and the board is holding it back because it entered THIS round.
		phase.set({phase: 'wait'});
		load(
			world(
				avatar({
					avatarID: ME,
					lastEpoch: 7,
					lastTurn: {epoch: 7, actions: [enterAt(START)]},
				}),
			),
		);
		state.set({step: 'Revealed', epoch: 7});
		// The round ends and the board releases it.
		phase.set({phase: 'play'});

		expect(seen.length).toBeGreaterThan(3);
		for (const drawn of seen) expect(drawn).toBeDefined();
		// Exactly one avatar the whole way, and it stops being a preview.
		const last = seen[seen.length - 1]!;
		expect(last.entering).toBe(false);
		expect(last.position).toEqual(START);
		expect(last.planned).toHaveLength(0);
		stop();
	});

	it('keeps a planned PATH drawn until the board has the turn to replay', () => {
		const {round, state} = fakeRound();
		const {seen, load, phase, stop} = compose(round, START);
		load(world(avatar({avatarID: ME})));
		state.set({
			step: 'Planning',
			epoch: 7,
			actions: [moveTo({x: 0, y: 2}), moveTo({x: 0, y: 3})],
		});
		seen.length = 0;

		phase.set({phase: 'wait'});
		load(
			world(
				avatar({
					avatarID: ME,
					position: {x: 0, y: 3},
					lastEpoch: 7,
					lastTurn: {
						epoch: 7,
						actions: [moveTo({x: 0, y: 2}), moveTo({x: 0, y: 3})],
					},
				}),
			),
		);
		state.set({step: 'Revealed', epoch: 7});
		phase.set({phase: 'play'});

		// Every frame shows the turn as one of the two: still planned, or landed
		// and ready to be walked. Never neither, which is the avatar standing at
		// its old cell with the path rubbed out.
		for (const drawn of seen) {
			expect(drawn).toBeDefined();
			expect(drawn!.planned.length > 0 || drawn!.lastTurn?.epoch === 7).toBe(
				true,
			);
		}
		const last = seen[seen.length - 1]!;
		expect(last.position).toEqual({x: 0, y: 3});
		expect(last.planned).toHaveLength(0);
		stop();
	});
});
