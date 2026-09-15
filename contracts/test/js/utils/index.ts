import {Abi_GameToken} from '../../../generated/abis/GameToken.js';
import {Abi_IGame} from '../../../generated/abis/IGame.js';
import {Abi_GameAvatarSale} from '../../../generated/abis/GameAvatarSale.js';
import {Abi_GameAvatars} from '../../../generated/abis/GameAvatars.js';
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
 * Both mirror `UsingGameTypes.EpochPolicy`, whose ORDER is the only thing that
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
	fixtures: {env: any; GameToken: any; GameAvatars: any},
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
		// line every branch has to rewrite. This is that branch: the ERC20 is
		// still named because the Config struct is shared, and nothing here
		// ever funds a reserve.
		tokens: fixtures.GameToken.address,
		// Zero, as the deployment's is. What is at stake here is custody of the
		// avatar, so a bond is exactly what a commitment does not need.
		placementCost: options.placementCost ?? 0n,
		epochPolicy: BigInt(options.epochPolicy),
	};

	// THE BRANCH'S ROUTES, which is the whole difference. Two of them are
	// `main`'s plus one override each and the third is new, exactly as the
	// deploy script builds them - so a game deployed here to try a different
	// epoch policy is THIS game, keyed by avatars, rather than upstream's.
	const routes = [
		{name: 'Getters', artifact: artifacts.GameGetters, args: [config]},
		{
			name: 'Commit',
			artifact: artifacts.AvatarGameCommit,
			args: [config, fixtures.GameAvatars.address],
		},
		{
			name: 'Reveal',
			artifact: artifacts.AvatarGameReveal,
			args: [config, fixtures.GameAvatars.address],
		},
		{
			name: 'Custody',
			artifact: artifacts.AvatarGameCustody,
			args: [config, fixtures.GameAvatars.address],
		},
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
/**
 * WHAT ONE TURN BONDS, in a game that bonds anything.
 *
 * NOTHING, on this branch, and that is what "custody instead of a bond" means
 * where a suite can see it: a placement costs zero here because what is at
 * stake is the avatar, so a commitment sets nothing aside. Upstream this is
 * five ether out of the reserve. It is a constant rather than a number in each
 * suite so that a suite about the ROUND never has to name what is at stake.
 */
export const TURN_BOND = 0n;

/**
 * STOP BEING A MEMBER, by whatever leaving means here.
 *
 * The epoch waits for members, so something has to be able to stop being one:
 * that is what keeps a game with no clock from being frozen by somebody who
 * walked away. Here membership is CUSTODY, so leaving is taking the avatar
 * back out - which the contract refuses while a commitment of theirs is open,
 * because leaving must never be a way to not-reveal for free.
 */
export async function leaveGame(
	fixtures: {env: any; Game: any},
	account: `0x${string}`,
	identity: bigint,
): Promise<void> {
	const {env, Game} = fixtures;
	await env.execute(Game, {
		account,
		functionName: 'withdrawAvatar',
		args: [identity, account],
	});
}

export async function enterGame(
	fixtures: {env: any; Game: any; GameAvatarSale: any},
	account: `0x${string}`,
	options?: {payer?: `0x${string}`},
): Promise<bigint> {
	const {env, Game, GameAvatarSale} = fixtures;
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

	// THE SALE MINTS INTO THE DEPLOYED GAME, so a suite that deployed a game of
	// its own - to run a different epoch policy against it - has to move the
	// avatar across. Taking it out and sending it back in is the players' own
	// route rather than a test-only one, so what this exercises is something a
	// player could do. A second SALE is not available at all: `GameAvatars` has
	// one minter on purpose, so two live sales cannot coexist.
	const deployed = env.get('Game');
	if (Game.address.toLowerCase() !== deployed.address.toLowerCase()) {
		const GameAvatars = env.get<Abi_GameAvatars>('GameAvatars');
		await env.execute(deployed, {
			account,
			functionName: 'withdrawAvatar',
			args: [avatarID + 1n, account],
		});
		await env.execute(GameAvatars, {
			account,
			functionName: 'safeTransferFrom',
			args: [account, Game.address, avatarID + 1n],
		});
	}

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
