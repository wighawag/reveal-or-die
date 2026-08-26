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
			numMoves: data.Game.numMoves,
		};

		const routes = [
			{name: 'Getters', artifact: artifacts.GameGetters, args: [config]},
			{name: 'Deposit', artifact: artifacts.GameDeposit, args: [config]},
			{name: 'Commit', artifact: artifacts.GameCommit, args: [config]},
			{name: 'Reveal', artifact: artifacts.GameReveal, args: [config]},
		];

		// NOTE: do not forward the proxy's `options` as a 4th argument to
		// deployViaRouter. Under rocketh 0.19 that argument sets
		// skipIfAlreadyDeployed on the ROUTER alone, so a changed route deploys to
		// a new address while the router keeps pointing at the old one and is
		// never rewired - a silent half-upgrade.
		await deployViaProxy<Abi_IGame>(
			'Game',
			{
				account: deployer,
				artifact: (name, params) =>
					deployViaRouter<Abi_IGame>(name, params, routes),
				args: [config],
			},
			{
				owner: admin,
				linkedData: config,
				// deterministic: true,
				// proxyContract: {
				// 	type: 'custom',
				// 	artifact: artifacts.ERC173Proxy,
				// },
			},
		);
	},
	{tags: ['Game', 'Game_deploy'], dependencies: ['Avatars_deploy']},
);
