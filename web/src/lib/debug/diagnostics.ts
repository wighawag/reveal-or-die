/**
 * A running commentary on the things that flash past.
 *
 * WHY IT SUBSCRIBES RATHER THAN INSTRUMENTS. Everything traced here lives in
 * `core/`, which is byte-identical to `template-commit-reveal` across all 123
 * files, and keeping it that way is what makes merging from upstream free.
 * Sprinkling log lines through it would trade that for a permanent merge
 * conflict in every file touched. Every fact below is already published as a
 * store, so watching from outside costs nothing and stays here, in the app,
 * where a descendant's own diagnostics belong.
 *
 * WHAT IT IS FOR, concretely. Two faults observed in play that are over before
 * they can be described: a modal that appears and vanishes during a
 * local-signer transaction, and the "data may be stale" bar showing for a
 * second or two. Both are transitions, not states, so the only way to catch
 * them is to timestamp every transition and read it back beside a recording.
 *
 * Each line carries `+Nms` since the previous line in its own namespace, which
 * is the number that matters when the question is "what did that modal follow?"
 * rather than "what time was it?".
 *
 * TURNING IT ON: `?debug=diag:*&debugLevel=debug`. The switch is documented in
 * `web/README.md`, which is also where the sharp edges are written down (a bare
 * `?debug` does nothing, the level defaults to warn so the namespaces alone are
 * silent, and the namespace selection persists while the level does not).
 *
 * None of that machinery is here or anywhere in the app: the inline script in
 * `src/app.html` builds the factory and parses the URL before the first module
 * runs. Do NOT call `hookup()` from a module to "fix" logging that looks
 * inert - it installs a second factory over `globalThis._logFactory`, freshly
 * defaulted, silently undoing whatever the URL just asked for. I did exactly
 * that once; the README exists partly because of it.
 */
import {logs} from 'named-logs';
import type {Readable} from 'svelte/store';
import type {Context} from '$lib/context/types';

/** One namespace per question, so `?debug=diag:modal` is a useful filter. */
const NAMESPACES = {
	/** Anything that can put a modal on screen. */
	modal: 'diag:modal',
	/** RPC health, and the polls that decide it. */
	rpc: 'diag:rpc',
	/** Dispatches, from record to settle. The silent signer's work. */
	send: 'diag:send',
	/** The commit-reveal round and what the game does around it. */
	round: 'diag:round',
} as const;

/**
 * Log a store's value whenever the part we care about changes.
 *
 * `describe` returns a line, undefined to say "not worth a line", or a line with
 * a DETAIL: something to hand to the console beside the text, so an error
 * arrives as the expandable object it is rather than as `[object Object]`.
 * Repeats are dropped: these stores re-emit constantly (the onchain poll alone
 * fires every five seconds), and a trace that repeats itself is one nobody
 * reads to the end.
 */
function watch<T>(
	namespace: string,
	store: Readable<T>,
	describe: (value: T) => string | undefined | {line: string; detail?: unknown},
): () => void {
	const logger = logs(namespace);
	let previous: string | undefined;
	let last = Date.now();
	let first = true;

	return store.subscribe((value) => {
		const described = describe(value);
		if (described === undefined) return;
		const line = typeof described === 'string' ? described : described.line;
		if (line === previous) return;
		const now = Date.now();
		// The first line is a baseline, not an interval.
		const gap = first ? '' : ` (+${now - last}ms)`;
		first = false;
		last = now;
		previous = line;
		if (typeof described === 'string') {
			logger.debug(`${line}${gap}`);
		} else {
			logger.debug(`${line}${gap}`, described.detail);
		}
	});
}

const shortAddress = (a: string | undefined) =>
	a ? `${a.slice(0, 6)}..${a.slice(-4)}` : 'none';

/**
 * The one-line version of an error, for scanning a trace.
 *
 * NOT a substitute for the error itself: plenty of failures arrive as plain
 * objects (viem's request errors, the poller's `{message, cause}`), and
 * `String()` on those prints `[object Object]` - a trace that cannot be read is
 * one nobody reads to the end. So this reaches for a `message` field when there
 * is one, and the full object is passed to the console BESIDE the line (see
 * `watch`) so it can be expanded.
 */
export const errorSummary = (error: unknown): string => {
	if (error instanceof Error) return error.message;
	if (typeof error === 'object' && error !== null) {
		const message = (error as {message?: unknown}).message;
		if (typeof message === 'string' && message !== '') return message;
		return Object.prototype.toString.call(error);
	}
	return String(error);
};

/**
 * Start watching. Returns the teardown.
 *
 * Cheap enough to run always: every subscription is to a store the app already
 * keeps live, and `logs()` returns no-ops for a namespace nobody enabled. It is
 * still gated by the caller, because a subscription that exists only to be
 * discarded is still a subscription.
 */
export function startDiagnostics(context: Context): () => void {
	const stops: Array<() => void> = [];

	// ---- what can put a modal on screen ------------------------------------
	//
	// Listed together on purpose. The complaint is "a modal flashed", and the
	// first question is WHICH, so every candidate reports in one namespace and
	// the trace answers it by elimination.

	stops.push(
		// `estimating` is the one that opens a modal titled "Preparing
		// Transaction" for the duration of a balance check. Moves deliberately do
		// not go through this (see world/commit-reveal.ts), so seeing it around a
		// commit would itself be the finding.
		watch(
			NAMESPACES.modal,
			context.balanceCheck,
			($check) => `balanceCheck: ${$check.step}`,
		),
	);

	stops.push(
		watch(NAMESPACES.modal, context.inFlight, ($inFlight) => {
			const requests = $inFlight.requests.length;
			const outcomes = Object.keys($inFlight.outcomes).length;
			// A request with NO outcome is silent by design; one WITH an outcome is
			// what opens the in-flight modal. Both are reported so the trace shows
			// the moment a silent record becomes a reported one.
			return `inFlight: ${requests} request(s), ${outcomes} reconciled`;
		}),
	);

	stops.push(
		watch(
			NAMESPACES.modal,
			context.accountCannotSend,
			($state) => `accountCannotSend: ${JSON.stringify($state)}`,
		),
	);

	stops.push(
		watch(
			NAMESPACES.modal,
			context.confirmation,
			($state) => `confirmation: ${JSON.stringify($state)}`,
		),
	);

	stops.push(
		watch(
			NAMESPACES.modal,
			context.errorDetails,
			($state) =>
				// The details modal carries a whole transaction error, so this reports
				// only whether it is up.
				`errorDetails: ${$state ? 'shown' : 'hidden'}`,
		),
	);

	stops.push(
		watch(
			NAMESPACES.modal,
			context.topUp,
			($flow) => `topUp: ${($flow as {phase?: string}).phase ?? 'unknown'}`,
		),
	);

	// ---- the stale-data bar -------------------------------------------------
	//
	// `computeHealth` takes the most recent SETTLED outcome across its inputs
	// with no tolerance for a single failure, so one blip raises the bar until
	// the next success settles. The bar itself only shows a category, so the
	// error is logged in full here: that is the bit needed to tell a real
	// outage from the node being momentarily behind.

	stops.push(
		watch(NAMESPACES.rpc, context.rpcHealth, ($health) =>
			$health.healthy
				? 'healthy'
				: {
						line: `UNHEALTHY: ${
							$health.error ? errorSummary($health.error) : 'no error given'
						}`,
						// The whole error, as an object the console can expand: the
						// summary above is for scanning, and `String()` on a plain
						// object is how this line used to read `[object Object]`.
						detail: $health.error,
					},
		),
	);

	// The three inputs `createRpcHealthStore` folds together. Logged separately
	// because the bar cannot say WHICH one failed, and that is the whole
	// question: a failing gas poll and a failing board read mean different
	// things and have different remedies.
	const pollers: Array<
		[string, Readable<{loading: boolean; error?: unknown}>]
	> = [
		['onchainState', context.onchainState.status],
		['gasFee', context.gasFee.status],
		['accountBalance', context.accountBalance.status],
		['signerBalance', context.signerBalance.status],
	];
	for (const [name, status] of pollers) {
		stops.push(
			watch(NAMESPACES.rpc, status, ($status) =>
				$status.error
					? {
							line: `${name}: ERROR ${errorSummary($status.error)}`,
							detail: $status.error,
						}
					: $status.loading
						? undefined // loading is noise; only settled outcomes decide health
						: `${name}: ok`,
			),
		);
	}

	// ---- the silent signer's transactions -----------------------------------

	stops.push(
		watch(NAMESPACES.send, context.signerBalance, ($balance) =>
			$balance.step === 'Loaded'
				? `signer balance: ${$balance.value}`
				: `signer balance: ${$balance.step}`,
		),
	);

	// ---- the game's own loop ------------------------------------------------
	//
	// Here rather than as log lines inside `world/` because the round is the one
	// thing every other trace has to be lined up against: a modal at +200ms
	// means nothing until you know a commit went out at +0.

	const {game} = context;

	stops.push(
		watch(NAMESPACES.round, game.round, ($round) => {
			const step = $round.step;
			if (step === 'Error') {
				return `round: Error during ${$round.during}: ${$round.message}`;
			}
			const actions = 'actions' in $round ? $round.actions.length : 0;
			// An EMPTY committed round is the liveness commit (see `commitWhenIdle`),
			// and telling it apart from a real turn matters when reading a trace.
			return `round: ${step}${'epoch' in $round ? ` epoch=${$round.epoch}` : ''} actions=${actions}`;
		}),
	);

	stops.push(
		watch(
			NAMESPACES.round,
			game.epochInfo,
			($epoch) =>
				`epoch ${$epoch.currentEpoch} ${$epoch.isCommitPhase ? 'commit' : 'reveal'}`,
		),
	);

	stops.push(
		watch(NAMESPACES.round, game.purchase, ($purchase) =>
			$purchase.step === 'Error'
				? `purchase: Error ${$purchase.message}`
				: `purchase: ${$purchase.step}`,
		),
	);

	stops.push(
		watch(
			NAMESPACES.round,
			game.missedReveal,
			($missed) => `missedReveal: ${$missed.step}`,
		),
	);

	stops.push(
		watch(
			NAMESPACES.round,
			game.setup,
			($setup) => `setup: ${$setup ? $setup.step : 'ready to play'}`,
		),
	);

	stops.push(
		watch(
			NAMESPACES.round,
			game.activeAvatarID,
			($id) =>
				`activeAvatar: ${$id === undefined ? 'none' : `#${($id & 0xffffffffn).toString(16)}`}`,
		),
	);

	stops.push(
		watch(
			NAMESPACES.round,
			context.account,
			($account) => `account: ${shortAddress($account)}`,
		),
	);

	return () => {
		for (const stop of stops) stop();
	};
}
