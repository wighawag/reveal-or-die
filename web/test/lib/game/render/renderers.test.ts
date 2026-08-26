import {describe, expect, it} from 'vitest';
import {writable} from 'svelte/store';
import type {Frame, ViewStateStore, ViewStateValue} from '$lib/game/core/seams';
import {createStatefulRenderer} from '$lib/game/render/stateful';
import {createImmediateRenderer} from '$lib/game/render/immediate';

type Cell = {stake: number};
type View = {cells: Map<string, Cell>};

function makeViewState() {
	const store = writable<ViewStateValue<View>>({step: 'Unloaded'});
	const viewState: ViewStateStore<View> = {
		subscribe: store.subscribe,
		status: writable({loading: false}),
	};
	return {store, viewState};
}

const frame: Frame = {
	time: 0,
	delta: 16,
	transform: {centerX: 0, centerY: 0, scale: 10},
	screen: {width: 100, height: 100},
	devicePixelRatio: 1,
};

describe('createStatefulRenderer', () => {
	function setup() {
		const {store, viewState} = makeViewState();
		const log: string[] = [];
		const surface = {name: 'surface'};

		const renderer = createStatefulRenderer<
			typeof surface,
			View,
			string,
			Cell,
			{key: string}
		>({
			viewState,
			entities: (view) => view.cells,
			changed: (a, b) => a.stake !== b.stake,
			add: ({key, surface: given}) => {
				expect(given).toBe(surface);
				log.push(`add ${key}`);
				return {key};
			},
			update: ({key}) => log.push(`update ${key}`),
			remove: ({key}) => log.push(`remove ${key}`),
			onEpochChanged: ({epoch, previousEpoch}) =>
				log.push(`epoch ${previousEpoch} -> ${epoch}`),
			onStopped: () => log.push('stopped'),
		});

		return {store, log, surface, renderer};
	}

	it('mirrors the view state into the scene', () => {
		const {store, log, surface, renderer} = setup();
		renderer.onAppStarted(surface);

		store.set({step: 'Loaded', epoch: 1, cells: new Map([['a', {stake: 1}]])});
		expect(log).toEqual(['epoch undefined -> 1', 'add a']);

		log.length = 0;
		store.set({step: 'Loaded', epoch: 1, cells: new Map([['a', {stake: 2}]])});
		expect(log).toEqual(['update a']);

		log.length = 0;
		store.set({step: 'Loaded', epoch: 1, cells: new Map()});
		expect(log).toEqual(['remove a']);
	});

	/**
	 * The signal a commit-reveal game needs and an ordinary one does not:
	 * everything drawn from local intent is scoped to one epoch. Fired BEFORE the
	 * new epoch's entities are applied, so a renderer can drop the old overlay
	 * without racing what replaces it.
	 */
	it('announces an epoch change before applying that epoch', () => {
		const {store, log, surface, renderer} = setup();
		renderer.onAppStarted(surface);
		store.set({step: 'Loaded', epoch: 1, cells: new Map()});
		log.length = 0;
		store.set({step: 'Loaded', epoch: 2, cells: new Map([['a', {stake: 1}]])});
		expect(log).toEqual(['epoch 1 -> 2', 'add a']);
	});

	/**
	 * State going back to Unloaded means what is on screen is no longer known to
	 * be true (an account switch, a chain reset). Leaving it there shows a board
	 * that belongs to nobody, and it reads as a rendering hiccup rather than a
	 * bug, which is how it survives.
	 */
	it('empties the scene when the state goes back to Unloaded', () => {
		const {store, log, surface, renderer} = setup();
		renderer.onAppStarted(surface);
		store.set({step: 'Loaded', epoch: 1, cells: new Map([['a', {stake: 1}]])});
		log.length = 0;

		store.set({step: 'Unloaded'});
		expect(log).toEqual(['remove a']);

		// And the epoch is forgotten with it, so reloading the same epoch is
		// announced again rather than being mistaken for "no change".
		log.length = 0;
		store.set({step: 'Loaded', epoch: 1, cells: new Map([['a', {stake: 1}]])});
		expect(log).toEqual(['epoch undefined -> 1', 'add a']);
	});

	/**
	 * On teardown the surface has already taken its children with it, so running
	 * remove handlers is at best wasted work and at worst an exception thrown
	 * during unmount. Resources the surface does not own are freed in onStopped.
	 */
	it('drops the scene on stop without running remove handlers', () => {
		const {store, log, surface, renderer} = setup();
		renderer.onAppStarted(surface);
		store.set({step: 'Loaded', epoch: 1, cells: new Map([['a', {stake: 1}]])});
		log.length = 0;

		renderer.onAppStopped();
		expect(log).toEqual(['stopped']);
	});

	it('stops listening to the view state once stopped', () => {
		const {store, log, surface, renderer} = setup();
		renderer.onAppStarted(surface);
		renderer.onAppStopped();
		log.length = 0;
		store.set({step: 'Loaded', epoch: 9, cells: new Map([['a', {stake: 1}]])});
		expect(log).toEqual([]);
	});

	it('reports what the last change was', () => {
		const {store, surface, renderer} = setup();
		renderer.onAppStarted(surface);
		store.set({
			step: 'Loaded',
			epoch: 1,
			cells: new Map([
				['a', {stake: 1}],
				['b', {stake: 1}],
			]),
		});
		store.set({step: 'Loaded', epoch: 1, cells: new Map([['a', {stake: 2}]])});
		expect(renderer.lastDiff?.updated.map(([key]) => key)).toEqual(['a']);
		expect(renderer.lastDiff?.removed.map(([key]) => key)).toEqual(['b']);
	});
});

describe('createImmediateRenderer', () => {
	function setup() {
		const {store, viewState} = makeViewState();
		const drawn: ViewStateValue<View>[] = [];
		const surface = {name: 'context'};
		const renderer = createImmediateRenderer<typeof surface, View>({
			viewState,
			draw: ({view, surface: given}) => {
				expect(given).toBe(surface);
				drawn.push(view);
			},
		});
		return {store, drawn, surface, renderer};
	}

	it('draws the current view state on every tick', () => {
		const {store, drawn, surface, renderer} = setup();
		renderer.onAppStarted(surface);
		store.set({step: 'Loaded', epoch: 1, cells: new Map([['a', {stake: 1}]])});

		renderer.tick(frame);
		renderer.tick(frame);
		expect(drawn).toHaveLength(2);
		expect(drawn[0]).toBe(drawn[1]);
	});

	/**
	 * An immediate renderer generally has to clear its surface every frame
	 * whatever happens, so being called with nothing to draw is normal. Skipping
	 * the call instead would leave the last loaded frame burnt into the canvas.
	 */
	it('draws the Unloaded state rather than skipping the frame', () => {
		const {drawn, surface, renderer} = setup();
		renderer.onAppStarted(surface);
		renderer.tick(frame);
		expect(drawn).toEqual([{step: 'Unloaded'}]);
	});

	it('does not draw before it starts or after it stops', () => {
		const {store, drawn, surface, renderer} = setup();
		renderer.tick(frame);
		expect(drawn).toEqual([]);

		renderer.onAppStarted(surface);
		renderer.onAppStopped();
		store.set({step: 'Loaded', epoch: 1, cells: new Map()});
		renderer.tick(frame);
		expect(drawn).toEqual([]);
	});
});
