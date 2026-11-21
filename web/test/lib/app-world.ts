import deployAvatars from 'reveal-or-die-contracts/deploy/001_deploy_avatars.js';
import deployGame from 'reveal-or-die-contracts/deploy/010_deploy_game.js';
import deploySale from 'reveal-or-die-contracts/deploy/020_deploy_sale.js';
import deployTables from 'reveal-or-die-contracts/deploy/030_deploy_tables.js';

/**
 * WHAT AN EMBEDDED WORLD MUST DEPLOY for the app's context to work, and the
 * rocketh setup it deploys with, in ONE place, so a descendant that replaces
 * the app's contracts (its own contracts package, its own deploy scripts)
 * edits this file and not every suite that boots a world. Read by
 * `embedded/world.test.ts` and `embedded/deployments.test.ts`. Its e2e twin is
 * `MAIN_PAGE` of `web/e2e/routes.ts`, whose `contract` names the same contract.
 *
 * HERE, THIS GAME'S CONTRACTS. This game's `embedded/world.test.ts` is its
 * own: it boots `OFFLINE_DEPLOYMENT` of `$lib/offline` whole (its scripts with
 * the data and accounts they need). What reads this file is the stem's
 * `offline-world.test.ts`, which opens a world of this game's deploy scripts
 * at their default data (every contract the app's records name, so the
 * world's own check passes) and checks the opener, not the game.
 */
export {config, extensions} from 'reveal-or-die-contracts/rocketh/config.js';

/** The deploy scripts a world runs, in order (as `OFFLINE_DEPLOYMENT` of `$lib/offline` deploys). */
export const APP_SCRIPTS = [
	// The avatars first: the game takes the collection's address in its
	// constructor, and the sale needs both.
	{id: '001_deploy_avatars', module: deployAvatars},
	{id: '010_deploy_game', module: deployGame},
	{id: '020_deploy_sale', module: deploySale},
	{id: '030_deploy_tables', module: deployTables},
];

/** The deployment name of the contract the app's context reads. */
export const APP_CONTRACT = 'Game' as const;
