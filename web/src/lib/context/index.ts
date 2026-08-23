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
import {createGameContext} from './game.js';
import type {Context} from './types.js';

export type {CoreServices} from './core.js';

export function createContext(): {
	context: Context;
	start: () => () => void;
} {
	return createCoreContext({createApp: createGameContext});
}
