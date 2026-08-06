/**
 * The view seam.
 *
 * What the renderer draws: onchain state with the player's local, not-yet-onchain
 * intent layered on top. The template supplies the wiring (subscribe to both,
 * re-derive, pass the status through); the game supplies the merge, because
 * only it knows what a planned move looks like on top of a confirmed one.
 */
import {derived} from 'svelte/store';
import type {
	OnchainStateStore,
	OnchainStateValue,
	ViewStateStore,
	ViewStateValue,
} from '$lib/game/core/seams';
import type {Readable} from 'svelte/store';

export type {ViewStateStore, ViewStateValue} from '$lib/game/core/seams';

/**
 * Merge confirmed state with local intent.
 *
 * Receives the loaded onchain state and whatever the game keeps locally, and
 * returns what should be drawn. Called on every change of either, so it should
 * be cheap and must not mutate its inputs: the onchain store stays the single
 * source of truth, and a re-derive must not leave view-only flags behind on it.
 */
export type ViewMerge<TState, TLocal, TView> = (params: {
	onchain: TState;
	local: TLocal;
	epoch: number;
}) => TView;

export function createViewState<TState, TLocal, TView>(params: {
	onchainState: OnchainStateStore<TState & {epoch: number}>;
	localState: Readable<TLocal>;
	merge: ViewMerge<TState, TLocal, TView>;
}): ViewStateStore<TView> {
	const {onchainState, localState, merge} = params;

	const _value = derived(
		[{subscribe: onchainState.subscribe}, localState],
		([$onchain, $local]): ViewStateValue<TView> => {
			const state = $onchain as OnchainStateValue<TState & {epoch: number}>;
			if (state.step === 'Unloaded') {
				return {step: 'Unloaded'};
			}
			const epoch = state.epoch;
			return {
				step: 'Loaded',
				epoch,
				...merge({onchain: state as unknown as TState, local: $local, epoch}),
			};
		},
	);

	return {
		subscribe: _value.subscribe,
		status: onchainState.status,
	};
}
