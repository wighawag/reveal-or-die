import {Abi_Avatars} from '../generated/abis/Avatars.js';
import {deployScript, artifacts} from '../rocketh/deploy.js';
import {zeroAddress} from 'viem';

/**
 * TABLES: reveal-or-die for a fixed set of seats, created by anyone, beside the
 * persistent world (stratagems' plan, step R1b).
 *
 * A table is an ADDRESS of its own, an EIP-1167 clone of one implementation
 * made by the base's `CommitRevealGameFactory`, which also opens its roster.
 * The implementation is the world's routes with the table's rules compiled in
 * (`src/game/table/`: a mode, a stake a seat, no exit, a death clock from the
 * start, the close and the leftovers), the table's own `GameTable` route, and
 * the base's lobby route, behind a router WITHOUT a proxy: nothing upgrades a
 * table. The world deploys none of the table's routes and has no lobby route,
 * so nothing can open a roster on it.
 *
 * Every table plays by the implementation's immutables, so its config (below)
 * is the factory's linked data, where a client finds it (`world/table.ts`).
 *
 * Named 030_deploy_TABLES because `.offshoot-omissions` deletes the template's
 * `030_deploy_lobby.ts` by path on every cascade.
 *
 * The offline world imports its scripts one by one (`web/src/lib/offline.ts`)
 * and not this one: an in-tab chain has nobody to invite.
 */
export default deployScript(
	async ({get, deploy, deployViaRouter, namedAccounts, data}) => {
		const {deployer} = namedAccounts;

		const Avatars = get<Abi_Avatars>('Avatars');

		const config = {
			startTime: 0n,
			commitPhaseDuration: data.Table.commitPhaseDuration,
			revealPhaseDuration: data.Table.revealPhaseDuration,
			time: zeroAddress,
			avatars: Avatars.address,
			numMoves: data.Table.numMoves,
			cyclePolicy: data.Table.cyclePolicy,
			numMissesAllowed: data.Table.numMissesAllowed,
			actionsPerReveal: data.Table.actionsPerReveal,
		};
		const stake = data.Table.stake;
		const args = [config, stake] as const;

		const implementation = await deployViaRouter(
			'GameTableImplementation',
			{account: deployer},
			[
				{name: 'Getters', artifact: artifacts.GameTableGetters, args},
				{name: 'Deposit', artifact: artifacts.GameTableDeposit, args},
				{name: 'Commit', artifact: artifacts.GameTableCommit, args},
				{name: 'Reveal', artifact: artifacts.GameTableReveal, args},
				{name: 'Loot', artifact: artifacts.GameTableLoot, args},
				{name: 'Table', artifact: artifacts.GameTable, args},
				// The world's: delegation holds nothing in the route, so the same
				// code lands at the address the world's has.
				{name: 'Delegation', artifact: artifacts.GameDelegation, args: []},
				// the base's own lobby route, the same for every game: it takes only
				// the cycle's half of the config
				{
					name: 'Lobby',
					artifact: artifacts.CommitRevealLobby,
					args: [
						{
							startTime: config.startTime,
							commitPhaseDuration: config.commitPhaseDuration,
							revealPhaseDuration: config.revealPhaseDuration,
							time: config.time,
							actionsPerReveal: config.actionsPerReveal,
							cyclePolicy: config.cyclePolicy,
						},
					],
				},
			],
			// The router and every route. Deterministic (CREATE2), like every
			// contract here: see "Deterministic deployments" in README.md.
			{deterministic: true},
		);

		await deploy(
			'GameTableFactory',
			{
				account: deployer,
				artifact: artifacts.CommitRevealGameFactory,
				args: [implementation.address],
			},
			{
				// Every table's rules, where a client finds them: a table is
				// composed at run time from its address and THIS record, as the
				// world is from `Game`'s.
				linkedData: {...config, stake},
				deterministic: true,
			},
		);
	},
	{
		tags: ['Tables', 'Tables_deploy'],
		dependencies: ['Avatars_deploy'],
	},
);
