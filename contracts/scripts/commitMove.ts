import {Abi_IGame} from '../generated/abis/IGame.js';
import hre from 'hardhat';
import {loadEnvironmentFromHardhat} from '../rocketh/environment.js';
import {zeroAddress} from 'viem';

async function main() {
	const env = await loadEnvironmentFromHardhat({hre});
	const Game = env.get<Abi_IGame>('Game');

	const before_avatars = await env.read(Game, {
		functionName: 'getAvatarsInZone',
		args: [0n, 0n, 100n],
	});

	console.log(before_avatars);

	await env.execute(Game, {
		account: env.namedAccounts.deployer,
		functionName: 'commit',
		args: [
			1n,
			'0x0000000000000000000000000000000000000000000000000000000000000000',
			zeroAddress,
		],
	});

	const after_avatars = await env.read(Game, {
		functionName: 'getAvatarsInZone',
		args: [0n, 0n, 100n],
	});
	console.log(after_avatars);
}
main();
