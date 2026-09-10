import {Abi_GameToken} from '../../../generated/abis/GameToken.js';
import {Abi_IGame} from '../../../generated/abis/IGame.js';
import {Abi_GameAvatarSale} from '../../../generated/abis/GameAvatarSale.js';
import {Abi_GameAvatars} from '../../../generated/abis/GameAvatars.js';
import {loadAndExecuteDeploymentsFromFiles} from '../../../rocketh/environment.js';
import {EthereumProvider} from 'hardhat/types/providers';
import {zeroAddress} from 'viem';

/**
 * The identity an ACCOUNT would play as, in a game whose identity IS the
 * account.
 *
 * KEPT ON THIS BRANCH ALTHOUGH NO PLAYER HERE HAS ONE, and that is what it is
 * for: the assertions that an account has NOTHING at stake still have to name
 * the slot they are asserting about, and on a game keyed by avatars the only
 * honest way to say "this address is not a player" is to look up the identity
 * an address game would have given it and find it empty.
 */
export function idOf(account: `0x${string}`): bigint {
	return BigInt(account);
}

/**
 * Whose avatar this is, lowercased.
 *
 * The case is the whole reason this is a function. Named accounts arrive from
 * the environment lowercased and a contract read comes back CHECKSUMMED, so a
 * direct comparison fails on a pair of addresses that are the same address -
 * a failure that says nothing about the game and costs a minute every time.
 */
export async function avatarOwner(
	env: any,
	Game: any,
	avatarID: bigint,
): Promise<string> {
	return String(
		await env.read(Game, {functionName: 'getAvatarOwner', args: [avatarID]}),
	).toLowerCase();
}

/**
 * GET AN ACCOUNT INTO THE GAME, and hand back the identity it plays as.
 *
 * THIS IS THE BRANCH'S HALF OF THE SUITE. On `main` a player is an account
 * with a staked reserve, so entering is mint, approve and `addToReserve` and
 * the identity is the account widened. Here a player is an AVATAR: entering is
 * one purchase that mints a token straight into the game's custody, and the
 * identity is that token's id, which has nothing to do with the account that
 * owns it.
 *
 * Everything above this line in the suites is unchanged, which is the point.
 * Order independence, the delegation rules, the router's selectors and the
 * zone listing are properties of the ROUND, and they are proven here against a
 * different identity model with the same words. That is stronger evidence that
 * the seam is in the right place than either run is on its own.
 *
 * `payer` is separable for the same reason it is upstream, and it means
 * something slightly different: whoever sends the purchase pays, and `account`
 * is the avatar's owner. Buying a stranger an avatar is a gift, because only
 * its owner can play it or take it out.
 */
export async function enterGame(
	fixtures: {env: any; Game: any; GameAvatarSale: any},
	account: `0x${string}`,
	options?: {payer?: `0x${string}`},
): Promise<bigint> {
	const {env, GameAvatarSale} = fixtures;
	const payer = options?.payer ?? account;
	const price = (GameAvatarSale.linkedData as {price: string}).price;

	// The id is read back rather than predicted: it is the sale's to allocate
	// (sequential, from 1), and a test that computed it would be asserting
	// against its own copy of that rule instead of against the contract's.
	const avatarID = (await env.read(GameAvatarSale, {
		functionName: 'lastAvatarID',
	})) as bigint;

	await env.execute(GameAvatarSale, {
		account: payer,
		functionName: 'purchase',
		args: [account, zeroAddress, 0n],
		value: BigInt(price),
	});

	return avatarID + 1n;
}

export function setupFixtures(provider: EthereumProvider) {
	return {
		async deployAll() {
			const env = await loadAndExecuteDeploymentsFromFiles({
				provider: provider,
			});

			const Game = env.get<Abi_IGame>('Game');
			const GameToken = env.get<Abi_GameToken>('GameToken');
			const GameAvatarSale = env.get<Abi_GameAvatarSale>('GameAvatarSale');
			const GameAvatars = env.get<Abi_GameAvatars>('GameAvatars');

			const linkedData = Game.linkedData as {
				startTime: string;
				commitPhaseDuration: string;
				revealPhaseDuration: string;
				time: `0x${string}`;
				placementCost: string;
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
				GameToken,
				GameAvatarSale,
				GameAvatars,
				linkedData,
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
