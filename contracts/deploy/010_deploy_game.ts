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
			// DECLARED, so the cycle cannot be inferred from the durations any
			// more. It travels on to the client in `linkedData` below, where
			// `resolveCycleConfig` reads it; a deployment record that predates
			// the parameter is read the old way, which is what that deployment
			// actually ran. See `UsingGameTypes.CyclePolicy`.
			cyclePolicy: data.Game.cyclePolicy,
			numMissesAllowed: data.Game.numMissesAllowed,
		};

		const routes = [
			{name: 'Getters', artifact: artifacts.GameGetters, args: [config]},
			{name: 'Deposit', artifact: artifacts.GameDeposit, args: [config]},
			{name: 'Commit', artifact: artifacts.GameCommit, args: [config]},
			{name: 'Reveal', artifact: artifacts.GameReveal, args: [config]},
			// Who may play as whom. Its own route because a router maps one
			// selector to one route and UsingDelegation carries six. Takes no
			// config: the delegation record lives in namespaced storage shared
			// by every route behind the proxy, so this contract holds nothing.
			{name: 'Delegation', artifact: artifacts.GameDelegation, args: []},
		];

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
