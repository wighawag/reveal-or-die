import {expect} from 'earl';
import {describe, it} from 'node:test';
import {network} from 'hardhat';
import {originDelegationMessage} from '@etherplay/connect-core';
import {privateKeyToAccount, generatePrivateKey} from 'viem/accounts';
import {createWalletClient, custom, type Account, type Chain} from 'viem';
import {setupFixtures} from './utils/index.js';

const {provider, networkHelpers} = await network.connect();
const {deployAll} = setupFixtures(provider);

async function balanceOf(address: `0x${string}`): Promise<bigint> {
	return BigInt(
		(await provider.request({
			method: 'eth_getBalance',
			params: [address, 'latest'],
		})) as string,
	);
}

/**
 * A wallet client bound to a key the test generated.
 *
 * The deployment tooling can only send from accounts it manages, and a delegate
 * is by definition a key that appeared from nowhere. Signing locally and
 * broadcasting is also what the app does with it, so this is the real path
 * rather than a test-only shortcut around it.
 */
async function clientFor(account: Account) {
	const chainId = Number(
		BigInt((await provider.request({method: 'eth_chainId'})) as string),
	);
	const chain = {
		id: chainId,
		name: 'test',
		nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
		rpcUrls: {default: {http: []}},
	} as const satisfies Chain;
	return createWalletClient({
		account,
		chain,
		transport: custom(provider as never),
	});
}

/**
 * The seam between the contract and the library that produces the signature.
 *
 * These two build the same string in two languages, and a signature only
 * verifies if they agree on every byte of it. Nothing about that agreement is
 * enforced by a type or a compiler: reword the message on either side, change
 * the address casing, and every signature ever generated silently stops
 * verifying, with no error that points at the cause.
 *
 * So it is pinned here, from both directions: the strings are compared
 * directly, and then a signature made the way production makes it is put
 * through the contract the way production submits it.
 */
describe('Delegation', function () {
	const ORIGIN = 'https://jolly-roger.example';

	describe('message encoding', function () {
		it('should build the exact same text as @etherplay/connect-core', async function () {
			const {env, Game} =
				await networkHelpers.loadFixture(deployAll);
			const delegate = privateKeyToAccount(generatePrivateKey()).address;

			const onchain = await env.read(Game, {
				functionName: 'delegationMessage',
				args: [ORIGIN, delegate],
			});

			expect(onchain).toEqual(originDelegationMessage(ORIGIN, delegate));
		});

		it('should render the delegate lowercase, whichever casing it is given', async function () {
			const {env, Game} =
				await networkHelpers.loadFixture(deployAll);
			// viem hands out EIP-55 checksummed addresses, so this is the casing
			// the library actually receives. Both sides have to lowercase it.
			const checksummed = privateKeyToAccount(generatePrivateKey()).address;
			const lowercased = checksummed.toLowerCase() as `0x${string}`;
			expect(checksummed).not.toEqual(lowercased);

			const onchain = await env.read(Game, {
				functionName: 'delegationMessage',
				args: [ORIGIN, checksummed],
			});

			expect(onchain).toInclude(lowercased);
			expect(onchain).not.toInclude(checksummed);
		});
	});

	describe('registerDelegateViaSignature', function () {
		it('should accept a signature made by the library, submitted by someone else', async function () {
			const {env, Game, unnamedAccounts} =
				await networkHelpers.loadFixture(deployAll);

			// The owner: a key that signs and never sends. It holds nothing, and
			// nothing here ever asks it to, which is the whole point of this path.
			const owner = privateKeyToAccount(generatePrivateKey());
			const delegate = privateKeyToAccount(generatePrivateKey());
			const payer = unnamedAccounts[0];

			const signature = await owner.signMessage({
				message: originDelegationMessage(ORIGIN, delegate.address),
			});

			await env.execute(Game, {
				functionName: 'registerDelegateViaSignature',
				args: [owner.address, ORIGIN, delegate.address, signature],
				account: payer,
			});

			const registered = await env.read(Game, {
				functionName: 'delegateOf',
				args: [owner.address],
			});
			expect(registered).toEqual(delegate.address);
		});

		it('should fund the delegate out of the submitted value', async function () {
			const {env, Game, unnamedAccounts} =
				await networkHelpers.loadFixture(deployAll);

			const owner = privateKeyToAccount(generatePrivateKey());
			const delegate = privateKeyToAccount(generatePrivateKey());
			const payer = unnamedAccounts[0];
			const amount = 10n ** 16n; // 0.01

			const signature = await owner.signMessage({
				message: originDelegationMessage(ORIGIN, delegate.address),
			});

			await env.execute(Game, {
				functionName: 'registerDelegateViaSignature',
				args: [owner.address, ORIGIN, delegate.address, signature],
				account: payer,
				value: amount,
			});

			// Registered AND able to act: a delegate with no gas is registered in
			// name only, which is the state funding-on-registration exists to skip.
			expect(await balanceOf(delegate.address)).toEqual(amount);

			// The owner paid nothing and sent nothing, which is the point.
			expect(await balanceOf(owner.address)).toEqual(0n);
		});

		it('should let the delegate play as the owner, on the owner\'s stake', async function () {
			// The whole production path in one test: the owner SIGNS and never
			// sends, somebody else submits the registration and funds the delegate
			// in the same transaction, and the delegate then plays - bonding a
			// reserve that belongs to the owner and that the delegate could never
			// withdraw.
			const {env, Game, GameToken, unnamedAccounts, advanceToEpoch, getEpoch, getTimestamp} =
				await networkHelpers.loadFixture(deployAll);

			const owner = privateKeyToAccount(generatePrivateKey());
			const delegate = privateKeyToAccount(generatePrivateKey());
			const payer = unnamedAccounts[0];

			const {epoch: startEpoch} = getEpoch(await getTimestamp());
			await advanceToEpoch(startEpoch + 2, true);

			// The stake is the OWNER'S, bought with the payer's tokens. This is the
			// same asymmetry as the funding above: the account that holds the money
			// and the account that plays are not the same account.
			await env.execute(GameToken, {
				account: payer,
				functionName: 'mint',
				args: [payer, 10n ** 19n],
			});
			await env.execute(GameToken, {
				account: payer,
				functionName: 'approve',
				args: [Game.address, 10n ** 19n],
			});
			await env.execute(Game, {
				account: payer,
				functionName: 'addToReserve',
				args: [owner.address, 10n ** 19n],
			});

			const signature = await owner.signMessage({
				message: originDelegationMessage(ORIGIN, delegate.address),
			});

			await env.execute(Game, {
				functionName: 'registerDelegateViaSignature',
				args: [owner.address, ORIGIN, delegate.address, signature],
				account: payer,
				value: 10n ** 17n,
			});

			const delegateClient = await clientFor(delegate);
			await delegateClient.writeContract({
				address: Game.address,
				abi: Game.abi,
				functionName: 'makeCommitment',
				args: [
					owner.address,
					'0x0000000000000000000000000000000000000000000000aa' as `0x${string}`,
					10n ** 18n,
					'0x0000000000000000000000000000000000000000' as `0x${string}`,
				],
			});

			// Filed under the owner, and the key that signed the transaction
			// appears nowhere.
			const ownerCommitment = (await env.read(Game, {
				functionName: 'getCommitment',
				args: [owner.address],
			})) as {bond: bigint};
			const delegateCommitment = (await env.read(Game, {
				functionName: 'getCommitment',
				args: [delegate.address],
			})) as {bond: bigint};

			expect(ownerCommitment.bond).toEqual(10n ** 18n);
			expect(delegateCommitment.bond).toEqual(0n);
		});

		it('should reject a signature for a different origin', async function () {
			const {env, Game, unnamedAccounts} =
				await networkHelpers.loadFixture(deployAll);

			const owner = privateKeyToAccount(generatePrivateKey());
			const delegate = privateKeyToAccount(generatePrivateKey());

			const signature = await owner.signMessage({
				message: originDelegationMessage(
					'https://not-the-app.example',
					delegate.address,
				),
			});

			await expect(
				env.execute(Game, {
					functionName: 'registerDelegateViaSignature',
					args: [owner.address, ORIGIN, delegate.address, signature],
					account: unnamedAccounts[0],
					gas: 1000000n,
				}),
			).toBeRejectedWith(`custom error 'InvalidSignature()'`);
		});
	});
});
