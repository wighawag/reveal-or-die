/**
 * This app's own additions to the trace.
 *
 * The mechanism and everything the template composes for every app are in
 * `$lib/game/core/diagnostics`: the modal candidates, RPC health and its
 * inputs, the signer's balance, the round and the cycle. Read that file first;
 * it is also where the argument for watching from OUTSIDE rather than
 * instrumenting `core/` lives, and it is the reason a descendant can keep this
 * file without inheriting a merge conflict.
 *
 * WHAT BELONGS HERE is whatever is this game's own. They go on the `round`
 * namespace beside the round itself, because the question they answer is
 * always relative to it: "the setup gate opened at +0, the acquisition
 * finished at +4s, the round committed at +4.2s" is a story, and the same
 * three lines in three namespaces are not.
 *
 * A game built from this template replaces the list below with its own and
 * leaves everything else alone.
 *
 * `Context` is accepted here and NOT upstream, deliberately: `context/types.ts`
 * is one of the files a game replaces, so a framework file that named it could
 * not be inherited by the games it exists for. Upstream describes what it needs
 * structurally instead, and this app's `Context` satisfies it with no cast -
 * which is the check that the structural description is honest.
 */
import {DIAG, startCoreDiagnostics, watch} from '$lib/game/core/diagnostics';
import type {Context} from '$lib/context/types';

export function startDiagnostics(context: Context): () => void {
	const stops = [startCoreDiagnostics(context)];
	const {game} = context;

	stops.push(
		watch(DIAG.round, game.acquisition, ($acquisition) =>
			$acquisition.step === 'Error'
				? `acquisition: Error ${$acquisition.message}`
				: `acquisition: ${$acquisition.step}`,
		),
	);

	stops.push(
		watch(
			DIAG.round,
			game.missedReveal,
			($missed) => `missedReveal: ${$missed.step}`,
		),
	);

	// The chain holding a commitment this browser cannot open is the most
	// time-critical state the app has, and it lasts one cycle. Traced beside the
	// round because the question is always what the round was doing when it
	// appeared.
	stops.push(
		watch(
			DIAG.round,
			game.recovery,
			($recovery) => `recovery: ${$recovery.step}`,
		),
	);

	stops.push(
		watch(
			DIAG.round,
			game.setup,
			($setup) => `setup: ${$setup ? $setup.step : 'ready to play'}`,
		),
	);

	return () => {
		for (const stop of stops) stop();
	};
}
