import {Abi_Avatars} from '../../generated/abis/Avatars.js';
import {Abi_AvatarsSale} from '../../generated/abis/AvatarsSale.js';
import {Abi_IGame} from '../../generated/abis/IGame.js';
import {loadAndExecuteDeploymentsFromFiles} from '../../rocketh/environment.js';
import {EthereumProvider} from 'hardhat/types/providers';

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

			function getEpoch(time: number): {epoch: number; commiting: boolean} {
				const epochDuration =
					Number(linkedData.commitPhaseDuration) +
					Number(linkedData.revealPhaseDuration);
				const startTime = Number(linkedData.startTime);
				if (time < startTime) {
					throw new Error('Game not started');
				}
				const timePassed = time - startTime;
				const epoch = Math.floor(timePassed / epochDuration + 2);
				const commiting =
					timePassed - (epoch - 2) * epochDuration <
					Number(linkedData.commitPhaseDuration);

				return {epoch, commiting};
			}

			function getEpochStartTime(epoch: number): number {
				const epochDuration =
					Number(linkedData.commitPhaseDuration) +
					Number(linkedData.revealPhaseDuration);
				return Number(linkedData.startTime) + (epoch - 2) * epochDuration;
			}

			async function advanceToEpoch(epoch: number, mine?: boolean) {
				await advanceToTime(getEpochStartTime(epoch), mine);
			}

			async function advanceToRevealPhase(epoch: number, mine?: boolean) {
				await advanceToTime(
					getEpochStartTime(epoch) + Number(linkedData.commitPhaseDuration),
					mine,
				);
			}

			return {
				env,
				Game,
				Avatars,
				AvatarsSale,
				getEpoch,
				getTimestamp,
				advanceToRevealPhase,
				advanceToEpoch,
				namedAccounts: env.namedAccounts,
				unnamedAccounts: env.unnamedAccounts,
			};
		},
	};
}
