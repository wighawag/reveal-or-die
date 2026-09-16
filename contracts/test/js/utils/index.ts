import {Abi_GameToken} from '../../../generated/abis/GameToken.js';
import {Abi_IGame} from '../../../generated/abis/IGame.js';
import {Abi_StakeSale} from '../../../generated/abis/StakeSale.js';
import {
	artifacts,
	loadAndExecuteDeploymentsFromFiles,
} from '../../../rocketh/environment.js';
import {EthereumProvider} from 'hardhat/types/providers';
import {parseEther, zeroAddress} from 'viem';

/**
 * How the round advances. The contract's enum, by value.
 *
 * Mirrors `rocketh/config.ts`'s copy rather than importing it, because that one
 * is bigints for the deploy and these are the numbers a test asserts against.
 * Both mirror `UsingGameTypes.CyclePolicy`, whose ORDER is the only thing that
 * decides what a number means.
 */
export const EPOCH_POLICY = {
	Timed: 0,
	Manual: 1,
	TimedWithEarlyAdvance: 2,
} as const;

export type EpochPolicy = (typeof EPOCH_POLICY)[keyof typeof EPOCH_POLICY];

/**
 * The epoch arithmetic, in the client's terms, for a game whose anchor has not
 * moved.
 *
 * It exists twice on purpose: the contract computes it and so does this, so a
 * test that agreed with the contract by asking it would be asserting nothing.
 */
export function epochClock(config: {
	startTime: number;
	commitPhaseDuration: number;
	revealPhaseDuration: number;
}) {
	const epochDuration = config.commitPhaseDuration + config.revealPhaseDuration;
	return {
		epochDuration,
		getEpoch(time: number): {epoch: number; commiting: boolean} {
			if (time < config.startTime) {
				throw new Error('Game not started');
			}
			const timePassed = time - config.startTime;
			const epoch = Math.floor(timePassed / epochDuration) + 2;
			return {
				epoch,
				commiting:
					timePassed - (epoch - 2) * epochDuration < config.commitPhaseDuration,
			};
		},
		epochStartTime(epoch: number): number {
			return config.startTime + (epoch - 2) * epochDuration;
		},
		revealStartTime(epoch: number): number {
			return (
				config.startTime +
				(epoch - 2) * epochDuration +
				config.commitPhaseDuration
			);
		},
	};
}

/**
 * A SECOND GAME, ON A DIFFERENT EPOCH POLICY, beside the deployed one.
 *
 * The deployment this repo ships is timed, because that is what a real game
 * wants; the other two policies still have to be played, and the cheapest
 * honest way to play one is to deploy it. Everything else - entering,
 * committing, revealing, the board - is the same code and the same suites,
 * which is the point being asserted: the policy is a policy and not a mode.
 *
 * EVERY DEPLOYMENT GETS A NAME OF ITS OWN, and that is not tidiness. The
 * fixture is memoised by `loadFixture`, so every test shares ONE environment
 * while the chain underneath it is rolled back between them: a repeated name
 * would find a record of a proxy that no longer exists on chain and try to
 * upgrade it, which fails in a way that says nothing about the test.
 */
let deploymentSequence = 0;

export async function deployGameWith(
	fixtures: {env: any; GameToken: any},
	options: {
		name: string;
		epochPolicy: EpochPolicy;
		commitPhaseDuration: bigint;
		revealPhaseDuration: bigint;
		startTime?: bigint;
		placementCost?: bigint;
	},
) {
	const {env} = fixtures;
	const config = {
		startTime: options.startTime ?? 0n,
		commitPhaseDuration: options.commitPhaseDuration,
		revealPhaseDuration: options.revealPhaseDuration,
		time: zeroAddress,
		// WHAT THE GAME IS MADE OF COMES OUT OF THE FIXTURES, not out of the
		// caller's hand. A suite about the epoch should not have to know what
		// this game puts at stake, because that is the thing each branch of
		// this repo changes - and a caller that spelled it out would be the
		// line every branch has to rewrite.
		tokens: fixtures.GameToken.address,
		placementCost: options.placementCost ?? parseEther('1'),
		cyclePolicy: BigInt(options.epochPolicy),
	};

	const routes = [
		{name: 'Getters', artifact: artifacts.GameGetters, args: [config]},
		{name: 'Commit', artifact: artifacts.GameCommit, args: [config]},
		{name: 'Reveal', artifact: artifacts.GameReveal, args: [config]},
		{name: 'Delegation', artifact: artifacts.GameDelegation, args: []},
	];

	deploymentSequence++;
	return await env.deployViaProxy<Abi_IGame>(
		`${options.name}_${deploymentSequence}`,
		{
			account: env.namedAccounts.deployer,
			artifact: (name: string, params: any) =>
				env.deployViaRouter<Abi_IGame>(name, params, routes),
			args: [config],
		},
		{owner: env.namedAccounts.admin, linkedData: config},
	);
}

/**
 * The identity an ACCOUNT plays as, in a game whose identity is the account.
 *
 * The contract keys every player by a `uint256` and never by an address, so
 * that a game keying by an avatar, a character or an empire puts its token id
 * in the same slot without changing a signature (see
 * `UsingGameInternal._playerOf`). This template is an address game, so the
 * widening happens here, and it happens in ONE function so that the suites read
 * as "this account's reserve" rather than as arithmetic.
 *
 * Deliberately not applied to `GameToken.mint` or `approve`: those really do
 * take an address, and a helper that got used on them would be hiding the
 * distinction it exists to draw.
 */
export function idOf(account: `0x${string}`): bigint {
	return BigInt(account);
}

/**
 * GET AN ACCOUNT INTO THE GAME, and hand back the identity it plays as.
 *
 * Every suite here needs this and none of them is about it, which is why it is
 * one function rather than three calls repeated six times. It is also the ONE
 * place a game with a different identity model has to differ: on this template
 * a player is an account with a staked reserve, so entering is mint, approve
 * and `addToReserve`, and the identity is the account itself. On
 * `with/nft-identity` the same call buys an avatar into the game's custody and
 * returns its token id, and the suites that use it are unchanged.
 *
 * `payer` is separable because it genuinely is: the wallet holding the money
 * and the key playing the game are different addresses by design (see the
 * delegation suite), and topping up someone else's reserve is a gift rather
 * than an attack, since only its owner can withdraw it.
 */
/**
 * WHAT ONE TURN BONDS, in a game that bonds anything.
 *
 * Here a placement is paid for out of the reserve, so a commitment has to set
 * some of it aside; on a branch whose stake is custody of a token there is
 * nothing to bond and this is zero. It is a constant rather than a number in
 * each suite so that a suite about the ROUND never has to name what is at
 * stake.
 */
export const TURN_BOND = parseEther('5');

/**
 * STOP BEING A MEMBER, by whatever leaving means here.
 *
 * The epoch waits for members, so something has to be able to stop being one:
 * that is what keeps a game with no clock from being frozen by somebody who
 * walked away. On this game membership is a funded reserve, so leaving is
 * taking all of it back out. It settles nothing and costs nothing beyond the
 * departure, which is the point - leaving the set the epoch waits for and
 * being punished for going silent are different questions.
 */
export async function leaveGame(
	fixtures: {env: any; Game: any},
	account: `0x${string}`,
	_identity: bigint,
): Promise<void> {
	const {env, Game} = fixtures;
	const reserve = (await env.read(Game, {
		functionName: 'getReserve',
		args: [idOf(account)],
	})) as bigint;
	await env.execute(Game, {
		account,
		functionName: 'withdrawFromReserve',
		args: [reserve],
	});
}

export async function enterGame(
	fixtures: {env: any; Game: any; GameToken: any},
	account: `0x${string}`,
	options?: {amount?: bigint; payer?: `0x${string}`},
): Promise<bigint> {
	const {env, Game, GameToken} = fixtures;
	const amount = options?.amount ?? parseEther('10');
	const payer = options?.payer ?? account;

	await env.execute(GameToken, {
		account: payer,
		functionName: 'mint',
		args: [payer, amount],
	});
	await env.execute(GameToken, {
		account: payer,
		functionName: 'approve',
		args: [Game.address, amount],
	});
	await env.execute(Game, {
		account: payer,
		functionName: 'addToReserve',
		args: [idOf(account), amount],
	});

	return idOf(account);
}

export function setupFixtures(provider: EthereumProvider) {
	return {
		async deployAll() {
			const env = await loadAndExecuteDeploymentsFromFiles({
				provider: provider,
			});

			const Game = env.get<Abi_IGame>('Game');
			const GameToken = env.get<Abi_GameToken>('GameToken');
			const StakeSale = env.get<Abi_StakeSale>('StakeSale');

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
				StakeSale,
				linkedData,
				getEpoch,
				getTimestamp,
				// Exposed because a game deployed INSIDE a test has a schedule of
				// its own: the two helpers above answer for the deployment's
				// durations, and an epoch policy suite is the one thing that
				// deploys a game with different ones.
				advanceToTime,
				advanceToRevealPhase,
				advanceToEpoch,
				namedAccounts: env.namedAccounts,
				unnamedAccounts: env.unnamedAccounts,
			};
		},
	};
}
