import {Abi_Avatars} from '../generated/abis/Avatars.js';
import {Abi_IGame} from '../generated/abis/IGame.js';
import {deployScript, artifacts} from '../rocketh/deploy.js';
import {zeroAddress} from 'viem';

export default deployScript(
	async ({get, deployViaProxy, deployViaRouter, namedAccounts, data}) => {
		const {deployer, admin} = namedAccounts;

		const Avatars = get<Abi_Avatars>('Avatars');

		const config = {
			startTime: 0n,
			commitPhaseDuration: data.Game.commitPhaseDuration,
			revealPhaseDuration: data.Game.revealPhaseDuration,
			time: zeroAddress,
			avatars: Avatars.address,
		};

		const routes = [
			{name: 'Getters', artifact: artifacts.GameGetters, args: [config]},
			{name: 'Deposit', artifact: artifacts.GameDeposit, args: [config]},
			{name: 'Commit', artifact: artifacts.GameCommit, args: [config]},
			{name: 'Reveal', artifact: artifacts.GameReveal, args: [config]},
		];

		const Game = await deployViaProxy<Abi_IGame>(
			'Game',
			{
				account: deployer,
				artifact: (name, params) => {
					return deployViaRouter<Abi_IGame>(
						name,
						params,
						routes,
						// 	{
						// 	routerContract: {
						// 		type: 'custom',
						// 		artifact: artifacts.Router10X60,
						// 	},
						// }
					);
				},
				args: [config],
			},
			{
				owner: admin,
				linkedData: config,
				// proxyContract: {
				// 	type: 'custom',
				// 	artifact: artifacts.ERC173Proxy,
				// },
			},
		);
	},
	{tags: ['Game', 'Game_deploy'], dependencies: ['Avatars_deploy']},
);
