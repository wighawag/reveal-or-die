/**
 * This game's own additions to the trace.
 *
 * The mechanism and everything the template composes for every app are in
 * `$lib/game/core/diagnostics`: the modal candidates, RPC health and each of
 * its inputs, the signer's balance, the submission and the cycle. Read that file
 * first; it is also where the argument for watching from OUTSIDE rather than
 * instrumenting `core/` lives, and it is the reason this file exists at all
 * rather than log lines in inherited code.
 *
 * WHAT BELONGS HERE is whatever is this game's own. They go on the
 * `submission` namespace beside the submission itself, because the question
 * they answer is
 * always relative to it: "the setup gate opened at +0, the purchase finished
 * at +4s, the submission committed at +4.2s" is a story, and the same three
 * lines
 * in three namespaces are not.
 *
 * TURNING IT ON: `?debug=diag:*&debugLevel=debug`. The switch is documented in
 * `web/README.md`, which is also where the sharp edges are written down (a bare
 * `?debug` does nothing, the level defaults to warn so the namespaces alone are
 * silent, and the namespace selection persists while the level does not).
 */
import {DIAG, startCoreDiagnostics, watch} from '$lib/game/core/diagnostics';
import type {Context} from '$lib/context/types';

export function startDiagnostics(context: Context): () => void {
	const stops = [startCoreDiagnostics(context)];
	const {game} = context;

	stops.push(
		watch(DIAG.submission, game.purchase, ($purchase) =>
			$purchase.step === 'Error'
				? `purchase: Error ${$purchase.message}`
				: `purchase: ${$purchase.step}`,
		),
	);

	stops.push(
		watch(
			DIAG.submission,
			game.missedReveal,
			($missed) => `missedReveal: ${$missed.step}`,
		),
	);

	stops.push(
		watch(
			DIAG.submission,
			game.setup,
			($setup) => `setup: ${$setup ? $setup.step : 'ready to play'}`,
		),
	);

	// Which avatar is being played. Every commitment, every storage key and
	// every reveal is filed under it, so a trace that does not say which one is
	// a trace of an unnamed player.
	stops.push(
		watch(
			DIAG.submission,
			game.activeIdentity,
			($id) =>
				`activeAvatar: ${
					$id === undefined ? 'none' : `#${($id & 0xffffffffn).toString(16)}`
				}`,
		),
	);

	return () => {
		for (const stop of stops) stop();
	};
}
