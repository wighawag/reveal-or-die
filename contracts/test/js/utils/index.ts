import {Abi_Avatars} from '../../../generated/abis/Avatars.js';
import {Abi_AvatarsSale} from '../../../generated/abis/AvatarsSale.js';
import {Abi_IGame} from '../../../generated/abis/IGame.js';
import {
	artifacts,
	loadAndExecuteDeploymentsFromFiles,
} from '../../../rocketh/environment.js';
import {EthereumProvider} from 'hardhat/types/providers';
import {zeroAddress} from 'viem';

/**
 * How the cycle advances, as {UsingGameTypes-CyclePolicy} numbers them.
 *
 * RE-EXPORTED FROM THE DEPLOY CONFIG rather than written out again. These
 * numbers already cross three boundaries unchecked - the Solidity enum, the
 * deploy config, and the client's own `['timed', 'manual', 'hybrid']` - and a
 * suite with a fourth copy would be a suite that can agree with itself while
 * disagreeing with the chain.
 */
export {CYCLE_POLICY} from '../../../rocketh/config.js';

/**
 * Deploy a game of this suite's own, with a configuration it chooses.
 *
 * WHY A SECOND DEPLOY EXISTS AT ALL, since every other test here plays the
 * SHIPPED one. Because the shipped one is timed, on every environment, and
 * always has been - so the manual branch of `_cycleNumber()`, `_moveToNextPhase` and
 * the since-removed `_moveToNextEpoch` were reachable by nothing in this repo
 * and were wrong for as long as they had existed. A suite that can only deploy one configuration can
 * only ever test one.
 *
 * THE SAME ROUTES AND THE SAME PROXY as `deploy/010_deploy_game.ts`, because a
 * game assembled differently from the real one is a game whose test says
 * nothing about the real one. Notably `Deposit` and `Delegation` have to be
 * here: an avatar is deposited through the first and authority to play it comes
 * from the second, and both write storage the commit path reads through the
 * proxy.
 */
export async function deployGameWith(
	env: Awaited<ReturnType<typeof loadAndExecuteDeploymentsFromFiles>>,
	name: string,
	config: {
		avatars: `0x${string}`;
		cyclePolicy: number;
		commitPhaseDuration?: bigint;
		revealPhaseDuration?: bigint;
		numMoves?: bigint;
		numMissesAllowed?: bigint;
	},
) {
	const {deployer, admin} = env.namedAccounts;
	// A manual cycle has no clock, so both durations must be zero and the
	// constructor refuses anything else. Defaulting from the policy keeps every
	// caller that is not testing the guard itself from having to restate it.
	const manual = config.cyclePolicy === 1;
	const full = {
		startTime: 0n,
		commitPhaseDuration: config.commitPhaseDuration ?? (manual ? 0n : 30n),
		revealPhaseDuration: config.revealPhaseDuration ?? (manual ? 0n : 10n),
		time: zeroAddress,
		avatars: config.avatars,
		numMoves: config.numMoves ?? 10n,
		cyclePolicy: config.cyclePolicy,
		numMissesAllowed: config.numMissesAllowed ?? 3n,
	};

	const routes = [
		{name: 'Getters', artifact: artifacts.GameGetters, args: [full]},
		{name: 'Deposit', artifact: artifacts.GameDeposit, args: [full]},
		{name: 'Commit', artifact: artifacts.GameCommit, args: [full]},
		{name: 'Reveal', artifact: artifacts.GameReveal, args: [full]},
		{name: 'Delegation', artifact: artifacts.GameDelegation, args: []},
	];

	return env.deployViaProxy<Abi_IGame>(
		name,
		{
			account: deployer,
			artifact: (artifactName, params) =>
				env.deployViaRouter<Abi_IGame>(artifactName, params, routes),
			args: [full],
		},
		{owner: admin, linkedData: full},
	);
}

export function setupFixtures(provider: EthereumProvider) {
	return {
		async deployAll() {
			const env = await loadAndExecuteDeploymentsFromFiles({
				provider: provider,
			});

			const Game = env.get<Abi_IGame>('Game');
			const Avatars = env.get<Abi_Avatars>('Avatars');
			const AvatarsSale = env.get<Abi_AvatarsSale>('AvatarsSale');

			const linkedData = Game.linkedData as {
				startTime: string;
				commitPhaseDuration: string;
				revealPhaseDuration: string;
				time: `0x${string}`;
			};

			let _timeOverride: {timestamp: number; whenMs: number} | undefined;

			async function advanceToTime(time: number, mine?: boolean) {
				await provider.request({
					method: 'evm_setNextBlockTimestamp',
					params: [time],
				});
				_timeOverride = {timestamp: time, whenMs: Date.now()};
				if (mine) {
					await provider.request({method: 'evm_mine'});
				}
			}

			async function getTimestamp(): Promise<number> {
				if (_timeOverride) {
					const block = await provider.request({
						method: 'eth_getBlockByNumber',
						params: ['latest', false],
					});
					const blockTimestamp: number = (block as any).timestamp;
					if (blockTimestamp > _timeOverride.timestamp) {
						_timeOverride = undefined;
						return blockTimestamp;
					}
					return (
						_timeOverride.timestamp +
						Math.floor((Date.now() - _timeOverride.whenMs) / 1000)
					);
				}
				return Math.floor(Date.now() / 1000);
			}

			function getCycleNumber(time: number): {
				cycleNumber: number;
				commiting: boolean;
			} {
				const cycleDuration =
					Number(linkedData.commitPhaseDuration) +
					Number(linkedData.revealPhaseDuration);
				const startTime = Number(linkedData.startTime);
				if (time < startTime) {
					throw new Error('Game not started');
				}
				const timePassed = time - startTime;
				const cycleNumber = Math.floor(timePassed / cycleDuration + 2);
				const commiting =
					timePassed - (cycleNumber - 2) * cycleDuration <
					Number(linkedData.commitPhaseDuration);

				return {cycleNumber, commiting};
			}

			function getCycleStartTime(cycleNumber: number): number {
				const cycleDuration =
					Number(linkedData.commitPhaseDuration) +
					Number(linkedData.revealPhaseDuration);
				return Number(linkedData.startTime) + (cycleNumber - 2) * cycleDuration;
			}

			async function advanceToCycle(cycleNumber: number, mine?: boolean) {
				await advanceToTime(getCycleStartTime(cycleNumber), mine);
			}

			async function advanceToRevealPhase(cycleNumber: number, mine?: boolean) {
				await advanceToTime(
					getCycleStartTime(cycleNumber) +
						Number(linkedData.commitPhaseDuration),
					mine,
				);
			}

			return {
				env,
				Game,
				Avatars,
				AvatarsSale,
				getCycleNumber,
				getTimestamp,
				advanceToRevealPhase,
				advanceToCycle,
				namedAccounts: env.namedAccounts,
				unnamedAccounts: env.unnamedAccounts,
			};
		},
	};
}
