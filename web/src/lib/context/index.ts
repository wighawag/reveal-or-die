/**
 * The app context, composed.
 *
 * Two halves, deliberately in two files, and the shape is INHERITED from
 * jolly-roger rather than invented here:
 *
 * - `./core.ts` is the template's. Connection, executors, balances, transaction
 *   observation, the RPC-health picture. It is merged down from upstream, so
 *   the less it differs the better.
 * - `./game.ts` is the commit-reveal framework wired to one game. It is what a
 *   descendant of this template rewrites.
 *
 * The core builds the game rather than the other way round, because the order
 * matters: the game needs the connection, and the health/refresh wiring needs
 * the game's chain reads. See the injection point in `core.ts`.
 */
import {createCoreContext} from './core.js';
import {createGameContext, SIGNER_GRANT} from './game.js';
import type {Context} from './types.js';

export type {CoreServices} from './core.js';

export function createContext(): {
	context: Context;
	start: () => () => void;
} {
	// Both of the game's contributions travel the same way, and for the same
	// reason: `core.ts` must not import `game.ts`. The grant is this app's answer
	// to "what is this browser's key for", which two pieces of shared UI need
	// (the payment dialog's consent step and the account panel's delegation row)
	// and neither can work out. See ui/delegation/grant.
	return createCoreContext({
		createApp: createGameContext,
		signerGrant: SIGNER_GRANT,
	});
}
