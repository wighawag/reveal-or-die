/**
 * Turning the app's logs on, from the URL.
 *
 * `named-logs` is inert until something hooks it up, and nothing did. `hookup()`
 * was called in `vite.config.ts`, which runs in NODE at config-load time and
 * does nothing whatsoever for the browser, so `init`, `game:chain-time`, `ens`
 * and `service-worker` have all been logging into the void. The four query
 * params that look like they control it (`debug`, `debugLevel`, `traceLevel`,
 * `debugLabel`) were declared in `$lib` and read by nobody.
 *
 * OFF BY DEFAULT AND ON BY URL, which is the point. A game whose rounds are
 * seconds long produces faults that are over before they can be described: a
 * modal that flashes, a banner that comes and goes. Studying those means
 * recording them with a timestamped trace running, and nobody records anything
 * if turning it on needs a different build.
 *
 * NOT `dev`-gated, for the same reason. A fault that only appears in a built
 * preview, on a phone, or on somebody else's machine is exactly the one worth
 * tracing, and a dev-only switch rules all three out. The cost in production is
 * a few disabled calls per second, which is what `named-logs` is for.
 *
 * IT IS STICKY, and that is `named-logs-console`'s doing rather than a choice
 * here: `factory.enable` writes to `localStorage.debug` and the module reads it
 * back on import. So `?debug` survives reloads, which is right for recording a
 * session, and `?debug=off` is how it stops.
 */
import {logs} from 'named-logs';
import {factory, hookup} from 'named-logs-console';

/**
 * Levels, as `named-logs` numbers them.
 *
 * Named because `?debugLevel=5` is otherwise a magic number somebody has to be
 * told over a call. Both spellings work: `?debugLevel=debug` and `?debugLevel=5`.
 */
export const LOG_LEVELS = {
	error: 1,
	warn: 2,
	info: 3,
	log: 4,
	debug: 5,
	trace: 6,
} as const;

/** What `?debug` alone turns on: everything short of stack traces. */
const DEFAULT_LEVEL = LOG_LEVELS.debug;

/** Values of `?debug` that mean "stop", rather than a namespace filter. */
const OFF = new Set(['off', 'false', '0', 'no']);

export function parseLevel(value: unknown): number | undefined {
	if (value === undefined || value === true || value === '') return undefined;
	const named = LOG_LEVELS[String(value) as keyof typeof LOG_LEVELS];
	if (named !== undefined) return named;
	const numeric = Number(value);
	return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

export type LoggingParams = {
	/**
	 * `?debug` for everything, `?debug=world:*,diag:*` for a filter (the syntax
	 * `factory.enable` takes), `?debug=off` to stop and clear the stored setting.
	 */
	debug?: string | boolean;
	debugLevel?: string;
	traceLevel?: string;
	/** `?debugLabel=false` drops the namespace prefix from each line. */
	debugLabel?: string | boolean;
};

/**
 * What `setupLogging` did, so the caller can say so rather than guess.
 *
 * `'restored'` is the case worth distinguishing: no param this time, but the
 * console is live because a previous `?debug` is still in localStorage. Silently
 * logging in a session nobody asked to log is how a user ends up reporting
 * "the console is full of noise" as a bug.
 */
export type LoggingOutcome = 'enabled' | 'disabled' | 'restored' | 'inert';

export function setupLogging(params: LoggingParams): LoggingOutcome {
	// The server has no console worth hooking and no URL to read.
	if (typeof window === 'undefined') return 'inert';

	// Must happen before anything else: `hookup` is what makes `logs()` return
	// loggers that write anywhere at all.
	hookup();

	const asked = params.debug;

	if (typeof asked === 'string' && OFF.has(asked.toLowerCase())) {
		factory.disable();
		return 'disabled';
	}

	if (!asked) {
		// No param. `named-logs-console` may still have enabled itself from
		// `localStorage.debug` when it was imported, which is the sticky case.
		let stored: string | null = null;
		try {
			stored = localStorage.getItem('debug');
		} catch {
			// Storage disabled. Nothing was restored, so nothing to report.
		}
		return stored ? 'restored' : 'inert';
	}

	factory.level = parseLevel(params.debugLevel) ?? DEFAULT_LEVEL;
	const traceLevel = parseLevel(params.traceLevel);
	if (traceLevel !== undefined) factory.traceLevel = traceLevel;
	// Labels earn their width when a recording is read back frame by frame,
	// which is what this is for, so they are on unless the URL says otherwise.
	factory.labelVisible = !(
		typeof params.debugLabel === 'string' &&
		OFF.has(params.debugLabel.toLowerCase())
	);

	// `?debug` on its own is every namespace; `?debug=a,b` is a filter.
	factory.enable(typeof asked === 'string' ? asked : undefined);

	logs('debug').info(
		`logging enabled at level ${factory.level}` +
			(typeof asked === 'string' ? ` for "${asked}"` : ' for all namespaces'),
	);
	return 'enabled';
}
