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
			// THE CHUNK: how many actions one reveal transaction may carry. Recorded
			// in `linkedData` below like everything else the client has to agree with
			// the contract about, and this one is not optional: a client that split a
			// turn into pieces of a different size would have every reveal past the
			// first revert, after the stake was already bonded.
			//
			// IT MATTERS MORE HERE THAN ON `main`. There a turn is bounded
			// economically - the reserve buys ten placements and no more - so a
			// reveal could never be enormous even before it was chunked. Here a
			// placement costs nothing, so nothing bounded a reveal's length at all
			// until this parameter did.
			actionsPerReveal: data.Game.actionsPerReveal,
			// How the cycle advances, said out loud rather than derived from the
			// phase durations being zero. It is recorded in `linkedData` below,
			// which is where the client reads it: a client that had to infer the
			// policy from the durations would be reconstructing a decision the
			// deploy already made.
			cyclePolicy: data.Game.cyclePolicy,
		};

		/**
		 * What the CLIENT has to budget with, which the contract never reads.
		 *
		 * Recorded alongside the config rather than inside it: these are gas
		 * figures measured against THIS deployment's contracts, and the contract
		 * has no use for them, so putting them in the `Config` struct would spend
		 * deploy gas and a storage slot on a number only the front end reads.
		 *
		 * They are here rather than in the client because contracts are not
		 * inherited in this template tree and the client's files are: a descendant
		 * writes its own game and would otherwise inherit gas measured against a
		 * game it does not run. See `rocketh/config.ts` for the measurements and
		 * `test/js/GasBudget.test.ts` for what stops them rotting.
		 */
		const clientGas = {
			commitGas: data.Game.commitGas,
			revealGas: data.Game.revealGas,
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
				// The struct the contract was constructed with, PLUS what only the
				// client needs. `linkedData` is the deployment record's, not the
				// contract's, so it may say more than the constructor took.
				linkedData: {...config, ...clientGas},
			},
		);
	},
	{
		tags: ['Game', 'Game_deploy'],
		dependencies: ['GameToken_deploy', 'GameAvatars_deploy'],
	},
);
