import {expect} from 'earl';
import {describe, it} from 'node:test'; // using node:test as hardhat v3 do not support vitest
import {network} from 'hardhat';
import {setupFixtures} from './utils/index.js';
import {
	decodeEventLog,
	encodeAbiParameters,
	keccak256,
	zeroAddress,
} from 'viem';

const {provider, networkHelpers, viem} = await network.connect();
const {deployAll} = setupFixtures(provider);

type Action = {actionType: number; data: bigint};

/**
 * The commitment the contract will recompute at reveal:
 * `bytes24(keccak256(abi.encode(secret, actions)))`, see
 * UsingGameInternal._checkHash. bytes24 is the LEFTMOST 24 bytes of the digest.
 *
 * This has to be computed rather than stubbed. The contract used to accept a
 * zero commitment as a wildcard, and this test committed exactly that, so it
 * asserted the reveal path while never once exercising the commit-reveal
 * binding it exists to protect.
 */
function commitmentHash(
	secret: `0x${string}`,
	actions: Action[],
): `0x${string}` {
	const encoded = encodeAbiParameters(
		[
			{type: 'bytes32'},
			{
				type: 'tuple[]',
				components: [
					{name: 'actionType', type: 'uint8'},
					{name: 'data', type: 'uint128'},
				],
			},
		],
		[secret, actions],
	);
	return keccak256(encoded).slice(0, 50) as `0x${string}`;
}

describe('Game', function () {
	it('basic test', async function () {
		const {
			env,
			Game,
			Avatars,
			AvatarsSale,
			unnamedAccounts,
			advanceToEpoch,
			advanceToRevealPhase,
			getEpoch,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const before_avatars = await env.read(Game, {
			functionName: 'getAvatarsInZone',
			args: [0n, 0n, 100n],
		});

		// console.log(before_avatars);

		const timestamp = await getTimestamp();
		const {epoch: initialEpoch, commiting: initialCommiting} =
			getEpoch(timestamp);

		const subID = 0n;
		const avatarID = (BigInt(unnamedAccounts[0]) << 96n) + subID;
		await env.execute(AvatarsSale, {
			account: env.unnamedAccounts[0],
			functionName: 'purchase',
			args: [
				Game.address,
				subID,
				encodeAbiParameters(
					[{type: 'address'}, {type: 'address'}],
					[unnamedAccounts[0], unnamedAccounts[0]],
				),
				zeroAddress,
				0n,
				zeroAddress,
			],
			value: BigInt(AvatarsSale.linkedData!.paymentAmount as string),
		});

		await advanceToEpoch(initialEpoch + 2);
		const entrancePosition = 0n;
		const secret =
			'0x0000000000000000000000000000000000000000000000000000000000000000';

		const enterActions: Action[] = [
			{actionType: 0, data: entrancePosition},
		];
		await env.execute(Game, {
			account: env.unnamedAccounts[0],
			functionName: 'commit',
			args: [avatarID, commitmentHash(secret, enterActions), zeroAddress],
		});

		await advanceToRevealPhase(initialEpoch + 2);

		await env.execute(Game, {
			account: env.unnamedAccounts[0],
			functionName: 'reveal',
			args: [avatarID, enterActions, secret, zeroAddress],
		});

		await advanceToEpoch(initialEpoch + 3);

		const moveActions: Action[] = [
			{actionType: 1, data: 4n},
			{actionType: 1, data: 4n},
		];
		await env.execute(Game, {
			account: env.unnamedAccounts[0],
			functionName: 'commit',
			args: [avatarID, commitmentHash(secret, moveActions), zeroAddress],
		});

		await advanceToRevealPhase(initialEpoch + 3);

		await env.execute(Game, {
			account: env.unnamedAccounts[0],
			functionName: 'reveal',
			args: [avatarID, moveActions, secret, zeroAddress],
		});

		// const after_avatars = await env.read(Game, {
		// 	functionName: 'getAvatarsInZone',
		// 	args: [0n, 0n, 100n],
		// });

		const after_avatars = await env.read(Game, {
			functionName: 'getAvatarsInMultipleZones',
			args: [
				[1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n, 12n, 13n, 14n, 0n],
				0n,
				100n,
			],
		});

		expect(after_avatars[0][0].position).toEqual(4n);
		// console.log(after_avatars);
	});
});
