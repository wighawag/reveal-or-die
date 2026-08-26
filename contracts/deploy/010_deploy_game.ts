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
			// Who may play as whom. Its own route because a router maps one
			// selector to one route and UsingDelegation carries six. Takes no
			// config: the delegation record lives in namespaced storage shared
			// by every route behind the proxy, so this contract holds nothing.
			{name: 'Delegation', artifact: artifacts.GameDelegation, args: []},
		];

		// DO NOT pass a 4th argument to deployViaRouter until rocketh is fixed.
		//
		// Passing ANY options object - the content is irrelevant - silently
		// disables the router's change detection. @rocketh/router computes
		// `skipIfAlreadyDeployed = alwaysOverride ? false : true` and forces it
		// onto the ROUTER's options only (dist/index.js:11,23); the routes get an
		// options object built from scratch that omits the flag. In
		// @rocketh/deploy, skipIfAlreadyDeployed:true returns any existing
		// deployment of that NAME without comparing bytecode or args at all
		// (dist/index.js:384). When options are omitted entirely, optionsForRouter
		// is undefined and the router compares normally, which is correct.
		//
		// So: change a route, and the route redeploys to a new address while the
		// router is skipped and keeps pointing at the OLD one. No error. Verified
		// against a local node: the router's args referenced 0x8a79... while the
		// live Commit route was 0xa51c..., so the new code was unreachable through
		// the proxy.
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
