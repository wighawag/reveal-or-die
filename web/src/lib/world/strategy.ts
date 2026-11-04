/**
 * HOW THIS GAME'S WORLD SEATS CAN PLAY, beyond the derived walk: the levels the
 * offline lobby offers, and the strategy that plays them.
 *
 * THE ONE FILE A GAME REPLACES to give its world seats a mind. Everything
 * around it is this repo's and stays identical in every game built on it: the
 * lobby reads `AI_LEVELS` off `$lib/offline`, which takes them from here; the
 * world's pass (`$lib/offline-players`) asks the strategy for a seat whose level
 * is not `random`, stores the turn before it commits it, and opens it from the
 * store (`$lib/game/core/strategy`). A game whose world has no levels exports
 * none, as this one does, and the lobby offers no choice.
 *
 * WHY THIS GAME OFFERS NONE. reveal-or-die's world has nothing to aim at: no
 * bombs, nothing a seat could do to another avatar, so a smarter walk would be
 * a walk. A descendant with something to play for supplies both exports (in
 * bomber-world, the "Bomber" level). The seam was adopted here rather than in
 * that game because the wiring is the same for every game on this world, and
 * a game should supply a strategy, not re-plumb the pass.
 *
 * WHAT A STRATEGY IS HANDED (`createWorldSeatStrategy`): a public client on the
 * world's provider and the world's deployments and config, so it can read the
 * board the way the game's own reader does. Nothing of the page: no context,
 * no submission, no handover (the seam's rule, `$lib/game/core/strategy`).
 */
import type {AiLevel, Strategy} from '$lib/game/core/strategy';
import type {DeploymentsStore} from '$lib/deployments-store';
import type {WorldConfig} from '$lib/world/config';
import type {PublicClient} from 'viem';
import type {Action} from 'reveal-or-die-contracts';

/** The levels the offline lobby offers for a world seat. Empty: none. */
export const WORLD_SEAT_LEVELS: readonly AiLevel[] = [];

/** The level a seat starts at in a fresh lobby choice. None: `random`. */
export const WORLD_SEAT_DEFAULT_LEVEL: string | undefined = undefined;

export type WorldSeatStrategyFactory = (params: {
	publicClient: Pick<
		PublicClient,
		'readContract' | 'getContractEvents' | 'getBlockNumber'
	>;
	deployments: DeploymentsStore;
	config: WorldConfig;
}) => Strategy<Action>;

/** What plays a level other than `random`, or none when no level is offered. */
export const createWorldSeatStrategy: WorldSeatStrategyFactory | undefined =
	undefined;
