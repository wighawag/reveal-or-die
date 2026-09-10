import {Abi_GameToken} from '../generated/abis/GameToken.js';
import {Abi_GameAvatars} from '../generated/abis/GameAvatars.js';
import {Abi_IGame} from '../generated/abis/IGame.js';
import {deployScript, artifacts} from '../rocketh/deploy.js';
import {zeroAddress} from 'viem';

export default deployScript(
	async ({get, deployViaProxy, deployViaRouter, namedAccounts, data}) => {
		const {deployer, admin} = namedAccounts;

		const GameToken = get<Abi_GameToken>('GameToken');
		const GameAvatars = get<Abi_GameAvatars>('GameAvatars');

		const config = {
			startTime: 0n,
			commitPhaseDuration: data.Game.commitPhaseDuration,
			revealPhaseDuration: data.Game.revealPhaseDuration,
			time: zeroAddress,
			tokens: GameToken.address,
			// A PLACEMENT COSTS NOTHING HERE, and that is what "custody instead of
			// the bond" means in one number. `main` bonds the exact cost of what was
			// planned and forfeits it, so its reserve is the stake; on this branch
			// the stake is the avatar, the reserve is never funded and never
			// consulted, and a bond of zero is what lets `_makeCommitment` accept a
			// turn against an empty one. The ERC20 is still deployed and still named
			// in this config because the Config struct is shared; nothing moves it.
			placementCost: 0n,
		};

		const routes = [
			// Two of these are `main`'s route plus one override each, and the third
			// is new. See `src/game/avatar/UsingAvatarIdentity.sol`: the identity
			// model varies by overriding a virtual internal (N4), so the getters and
			// the delegation route below are the ones `main` deploys, unchanged.
			{name: 'Getters', artifact: artifacts.GameGetters, args: [config]},
			{
				name: 'Commit',
				artifact: artifacts.AvatarGameCommit,
				args: [config, GameAvatars.address],
			},
			{
				name: 'Reveal',
				artifact: artifacts.AvatarGameReveal,
				args: [config, GameAvatars.address],
			},
			// Getting an avatar in and out, and finding one to play. Its selectors
			// exist nowhere on `main`, so this route can never collide with one.
			{
				name: 'Custody',
				artifact: artifacts.AvatarGameCustody,
				args: [config, GameAvatars.address],
			},
			// Who may play as whom. Its own route because a router maps one
			// selector to one route, and UsingDelegation carries six. Takes no
			// config: the delegation record is namespaced storage shared across
			// every route behind the proxy, and this contract holds nothing.
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
			},
		);
	},
	{
		tags: ['Game', 'Game_deploy'],
		dependencies: ['GameToken_deploy', 'GameAvatars_deploy'],
	},
);
