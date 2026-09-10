import {Abi_GameAvatars} from '../generated/abis/GameAvatars.js';
import {Abi_IGame} from '../generated/abis/IGame.js';
import {deployScript, artifacts} from '../rocketh/deploy.js';

/**
 * WHERE ENTRY IS SOLD, which on this branch is an avatar rather than a stake.
 *
 * THE FILENAME IS `main`'S AND IS DELIBERATELY LEFT ALONE. Renaming it would be
 * a delete plus an add, which arrives in every future cascade as a
 * modify/delete conflict on a file `main` still develops - the most expensive
 * shape of divergence there is, in exchange for a better word. What this script
 * IS is the same thing at both levels: the one place that says how a player
 * gets what lets them play.
 *
 * The alternative considered and rejected was to leave `main`'s script alone
 * and add a second one beside it. That costs no shared-file edit at all, and it
 * ships a deployment offering a purchase that does nothing: `StakeSale` would
 * still mint an ERC20 and credit a reserve which, on this branch, nothing ever
 * reads and nothing can ever forfeit. A misleading contract is worse than a
 * misleading filename.
 */
export default deployScript(
	async ({get, execute, deploy, namedAccounts, data}) => {
		const {deployer, admin} = namedAccounts;

		const GameAvatars = get<Abi_GameAvatars>('GameAvatars');
		const Game = get<Abi_IGame>('Game');

		const config = {
			price: data.sale.price,
			recipient: admin,
		};

		const GameAvatarSale = await deploy(
			'GameAvatarSale',
			{
				account: deployer,
				artifact: artifacts.GameAvatarSale,
				args: [GameAvatars.address, Game.address, config],
			},
			{
				// The client reads the price off THIS deployment rather than off the
				// Game's, because the price is this contract's to state: `purchase`
				// reverts with `WrongPaymentAmount` unless the value it is sent
				// matches exactly, so a figure copied anywhere else is a figure that
				// can drift into reverting every purchase.
				//
				// `amount` is what one purchase yields, which is one avatar. It is
				// stated here rather than derived because `placement/config.ts` reads
				// it by name from whichever sale a node deploys, which is what keeps
				// that file identical on both branches.
				linkedData: {...config, amount: 1n},
			},
		);

		// THE MINT IS SHUT UNTIL THIS LINE RUNS, and that is the invariant rather
		// than a wiring step: `GameAvatars.minter` is zero until set, so a
		// deployment that stopped here would mint nothing at all instead of
		// minting for free. A stake that costs nothing to acquire is not a stake.
		await execute(GameAvatars, {
			account: admin,
			functionName: 'setMinter',
			args: [GameAvatarSale.address],
		});
	},
	{
		tags: ['StakeSale', 'StakeSale_deploy'],
		dependencies: ['GameAvatars_deploy', 'Game_deploy'],
	},
);
