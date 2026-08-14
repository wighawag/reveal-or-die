import {expect} from 'earl';
import {describe, it} from 'node:test'; // using node:test as hardhat v3 do not support vitest
import {network} from 'hardhat';
import {setupFixtures} from './utils/index.js';
import {encodeAbiParameters, keccak256, parseEther, zeroAddress} from 'viem';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {delegationMessage} from '@etherplay/delegation';

const {provider, networkHelpers} = await network.connect();
const {deployAll} = setupFixtures(provider);

type Placement = {cellID: bigint};

/** Pack a cell coordinate the way PositionUtils does: y in the high 32 bits. */
function cellAt(x: number, y: number): bigint {
	const ux = BigInt.asUintN(32, BigInt(x));
	const uy = BigInt.asUintN(32, BigInt(y));
	return (uy << 32n) + ux;
}

/**
 * The commitment hash, matching `_checkHash`: keccak256(abi.encode(secret,
 * placements)), truncated to 24 bytes.
 */
function commitmentHash(
	placements: readonly Placement[],
	secret: `0x${string}`,
): `0x${string}` {
	const encoded = encodeAbiParameters(
		[
			{type: 'bytes32'},
			{
				type: 'tuple[]',
				components: [{name: 'cellID', type: 'uint64'}],
			},
		],
		[secret, placements as {cellID: bigint}[]],
	);
	return keccak256(encoded).slice(0, 50) as `0x${string}`;
}

const SECRET_A =
	'0x0000000000000000000000000000000000000000000000000000000000000a11';
const SECRET_B =
	'0x0000000000000000000000000000000000000000000000000000000000000b22';

describe('Game', function () {
	it('places a cell through a full commit/reveal round', async function () {
		const {
			env,
			Game,
			GameToken,
			unnamedAccounts,
			advanceToEpoch,
			advanceToRevealPhase,
			getEpoch,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const player = unnamedAccounts[0];
		const {epoch: startEpoch} = getEpoch(await getTimestamp());
		await advanceToEpoch(startEpoch + 2, true);

		// Fund and stake.
		await env.execute(GameToken, {
			account: player,
			functionName: 'mint',
			args: [player, parseEther('100')],
		});
		await env.execute(GameToken, {
			account: player,
			functionName: 'approve',
			args: [Game.address, parseEther('100')],
		});
		await env.execute(Game, {
			account: player,
			functionName: 'addToReserve',
			args: [player, parseEther('10')],
		});

		expect(
			await env.read(Game, {functionName: 'getReserve', args: [player]}),
		).toEqual(parseEther('10'));

		// Commit.
		//
		// The FIRST zeroAddress is `player`: commit as whoever is calling. The
		// last is `payee`, which is unrelated. A real client passes the account
		// here and sends from its delegate; see the delegation tests below.
		const placements: Placement[] = [{cellID: cellAt(3, 4)}];
		await env.execute(Game, {
			account: player,
			functionName: 'makeCommitment',
			args: [
				zeroAddress,
				commitmentHash(placements, SECRET_A),
				parseEther('5'),
				zeroAddress,
			],
		});

		// Reveal.
		const {epoch} = getEpoch(await getTimestamp());
		await advanceToRevealPhase(epoch, true);
		await env.execute(Game, {
			account: player,
			functionName: 'reveal',
			args: [player, placements, SECRET_A, zeroAddress],
		});

		const cell = (await env.read(Game, {
			functionName: 'getCell',
			args: [cellAt(3, 4)],
		})) as {totalStake: bigint; numClaimants: number};

		expect(cell.totalStake).toEqual(parseEther('1'));
		expect(cell.numClaimants).toEqual(1);

		// The placement was paid for out of the reserve.
		expect(
			await env.read(Game, {functionName: 'getReserve', args: [player]}),
		).toEqual(parseEther('9'));
	});

	/**
	 * The property that makes commit-reveal worth doing.
	 *
	 * Reveals arrive in whatever order the mempool delivers them, so the board
	 * that results from a set of commitments must not depend on that order. If
	 * it does, whoever pays the most gas decides the outcome, and committing
	 * bought nothing.
	 *
	 * This is easy to break by accident: "the first to reveal takes the cell"
	 * and "reject a cell that is already taken" both look like reasonable rules
	 * and both violate it. So it is asserted directly rather than trusted.
	 */
	it('reaches the same board whichever order the reveals arrive in', async function () {
		async function boardAfterRevealsInOrder(
			revealFirst: 'A' | 'B',
		): Promise<{totalStake: bigint; numClaimants: number}> {
			const {
				env,
				Game,
				GameToken,
				unnamedAccounts,
				advanceToEpoch,
				advanceToRevealPhase,
				getEpoch,
				getTimestamp,
			} = await networkHelpers.loadFixture(deployAll);

			const playerA = unnamedAccounts[0];
			const playerB = unnamedAccounts[1];

			const {epoch: startEpoch} = getEpoch(await getTimestamp());
			await advanceToEpoch(startEpoch + 2, true);

			for (const player of [playerA, playerB]) {
				await env.execute(GameToken, {
					account: player,
					functionName: 'mint',
					args: [player, parseEther('100')],
				});
				await env.execute(GameToken, {
					account: player,
					functionName: 'approve',
					args: [Game.address, parseEther('100')],
				});
				await env.execute(Game, {
					account: player,
					functionName: 'addToReserve',
					args: [player, parseEther('10')],
				});
			}

			// Both players commit to the SAME cell, blind to each other.
			const contested = cellAt(7, 7);
			const placementsA: Placement[] = [{cellID: contested}];
			const placementsB: Placement[] = [{cellID: contested}];

			await env.execute(Game, {
				account: playerA,
				functionName: 'makeCommitment',
				args: [
					zeroAddress,
					commitmentHash(placementsA, SECRET_A),
					parseEther('5'),
					zeroAddress,
				],
			});
			await env.execute(Game, {
				account: playerB,
				functionName: 'makeCommitment',
				args: [
					zeroAddress,
					commitmentHash(placementsB, SECRET_B),
					parseEther('5'),
					zeroAddress,
				],
			});

			const {epoch} = getEpoch(await getTimestamp());
			await advanceToRevealPhase(epoch, true);

			const revealA = () =>
				env.execute(Game, {
					account: playerA,
					functionName: 'reveal',
					args: [playerA, placementsA, SECRET_A, zeroAddress],
				});
			const revealB = () =>
				env.execute(Game, {
					account: playerB,
					functionName: 'reveal',
					args: [playerB, placementsB, SECRET_B, zeroAddress],
				});

			if (revealFirst === 'A') {
				await revealA();
				await revealB();
			} else {
				await revealB();
				await revealA();
			}

			return (await env.read(Game, {
				functionName: 'getCell',
				args: [contested],
			})) as {totalStake: bigint; numClaimants: number};
		}

		const aFirst = await boardAfterRevealsInOrder('A');
		const bFirst = await boardAfterRevealsInOrder('B');

		// Same final board either way: the cell is shared, not won.
		expect(aFirst.totalStake).toEqual(bFirst.totalStake);
		expect(aFirst.numClaimants).toEqual(bFirst.numClaimants);

		// And it really is shared, rather than both reveals failing.
		expect(aFirst.numClaimants).toEqual(2);
		expect(aFirst.totalStake).toEqual(parseEther('2'));
	});

	it('forfeits the bond of a player who never reveals', async function () {
		const {
			env,
			Game,
			GameToken,
			unnamedAccounts,
			advanceToEpoch,
			getEpoch,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const player = unnamedAccounts[0];
		const {epoch: startEpoch} = getEpoch(await getTimestamp());
		await advanceToEpoch(startEpoch + 2, true);

		await env.execute(GameToken, {
			account: player,
			functionName: 'mint',
			args: [player, parseEther('100')],
		});
		await env.execute(GameToken, {
			account: player,
			functionName: 'approve',
			args: [Game.address, parseEther('100')],
		});
		await env.execute(Game, {
			account: player,
			functionName: 'addToReserve',
			args: [player, parseEther('10')],
		});

		const placements: Placement[] = [{cellID: cellAt(1, 1)}];
		await env.execute(Game, {
			account: player,
			functionName: 'makeCommitment',
			args: [
				zeroAddress,
				commitmentHash(placements, SECRET_A),
				parseEther('4'),
				zeroAddress,
			],
		});

		// Let the epoch pass without revealing.
		const {epoch} = getEpoch(await getTimestamp());
		await advanceToEpoch(epoch + 1, true);

		await env.execute(Game, {
			account: unnamedAccounts[1],
			functionName: 'acknowledgeMissedReveal',
			args: [player],
		});

		// The bond is gone; the rest of the reserve is untouched.
		expect(
			await env.read(Game, {functionName: 'getReserve', args: [player]}),
		).toEqual(parseEther('6'));
	});

	it('lets one address pay the stake and another play with it', async function () {
		// The split the whole client architecture depends on: a player's moves are
		// signed by a local key that holds no funds, while the stake is paid from
		// the wallet that does. Without this, a wallet prompt would be required for
		// every commit and every reveal, and an email/social account (which has no
		// wallet provider at all) could not play.
		const {
			env,
			Game,
			GameToken,
			unnamedAccounts,
			advanceToEpoch,
			advanceToRevealPhase,
			getEpoch,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const payer = unnamedAccounts[0]; // the wallet, holds the money
		const player = unnamedAccounts[1]; // the signing key, holds nothing

		const {epoch: startEpoch} = getEpoch(await getTimestamp());
		await advanceToEpoch(startEpoch + 2, true);

		await env.execute(GameToken, {
			account: payer,
			functionName: 'mint',
			args: [payer, parseEther('100')],
		});
		await env.execute(GameToken, {
			account: payer,
			functionName: 'approve',
			args: [Game.address, parseEther('100')],
		});

		// The payer stakes ON BEHALF OF the player.
		await env.execute(Game, {
			account: payer,
			functionName: 'addToReserve',
			args: [player, parseEther('10')],
		});

		expect(
			await env.read(Game, {functionName: 'getReserve', args: [player]}),
		).toEqual(parseEther('10'));
		expect(
			await env.read(Game, {functionName: 'getReserve', args: [payer]}),
		).toEqual(0n);

		// And the player, who never held a token, can now play on it.
		const placements: Placement[] = [{cellID: cellAt(5, 5)}];
		await env.execute(Game, {
			account: player,
			functionName: 'makeCommitment',
			args: [
				zeroAddress,
				commitmentHash(placements, SECRET_A),
				parseEther('1'),
				zeroAddress,
			],
		});

		const {epoch} = getEpoch(await getTimestamp());
		await advanceToRevealPhase(epoch, true);
		await env.execute(Game, {
			account: player,
			functionName: 'reveal',
			args: [player, placements, SECRET_A, zeroAddress],
		});

		const cell = (await env.read(Game, {
			functionName: 'getCell',
			args: [cellAt(5, 5)],
		})) as {totalStake: bigint; numClaimants: number};
		expect(cell.totalStake).toEqual(parseEther('1'));

		// Paid for out of the reserve the payer funded.
		expect(
			await env.read(Game, {functionName: 'getReserve', args: [player]}),
		).toEqual(parseEther('9'));
	});

	it('lists placed cells in a zone', async function () {
		const {
			env,
			Game,
			GameToken,
			unnamedAccounts,
			advanceToEpoch,
			advanceToRevealPhase,
			getEpoch,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const player = unnamedAccounts[0];
		const {epoch: startEpoch} = getEpoch(await getTimestamp());
		await advanceToEpoch(startEpoch + 2, true);

		await env.execute(GameToken, {
			account: player,
			functionName: 'mint',
			args: [player, parseEther('100')],
		});
		await env.execute(GameToken, {
			account: player,
			functionName: 'approve',
			args: [Game.address, parseEther('100')],
		});
		await env.execute(Game, {
			account: player,
			functionName: 'addToReserve',
			args: [player, parseEther('10')],
		});

		// Two cells inside zone 0 (which spans -8..7 on both axes).
		const placements: Placement[] = [
			{cellID: cellAt(0, 0)},
			{cellID: cellAt(2, -3)},
		];
		await env.execute(Game, {
			account: player,
			functionName: 'makeCommitment',
			args: [
				zeroAddress,
				commitmentHash(placements, SECRET_A),
				parseEther('5'),
				zeroAddress,
			],
		});

		const {epoch} = getEpoch(await getTimestamp());
		await advanceToRevealPhase(epoch, true);
		await env.execute(Game, {
			account: player,
			functionName: 'reveal',
			args: [player, placements, SECRET_A, zeroAddress],
		});

		const [cells] = (await env.read(Game, {
			functionName: 'getCellsInZone',
			args: [0n],
		})) as [
			{cellID: bigint; totalStake: bigint; numClaimants: number}[],
			bigint,
		];

		expect(cells.length).toEqual(2);
		const ids = cells.map((c) => c.cellID).sort();
		expect(ids).toEqual([cellAt(0, 0), cellAt(2, -3)].sort());
	});
});

/**
 * Playing without holding the stake.
 *
 * A player's moves are sent by a key their browser generated, which they never
 * see and which holds nothing. That key must be able to COMMIT, because a
 * wallet prompt twice an epoch is not a game, and it must not be able to take
 * the money, because it is one cleared site away from being gone and anything
 * that gets hold of it has whatever authority it was given.
 *
 * So the account is the player and the key merely acts for it. These tests pin
 * both halves: what the delegate may do, and what it may not.
 */
describe('Game delegation', function () {
	/** Stake `amount` for `player`, paid by `player`. */
	async function stake(
		env: any,
		Game: any,
		GameToken: any,
		player: `0x${string}`,
		amount: bigint,
	) {
		await env.execute(GameToken, {
			account: player,
			functionName: 'mint',
			args: [player, amount],
		});
		await env.execute(GameToken, {
			account: player,
			functionName: 'approve',
			args: [Game.address, amount],
		});
		await env.execute(Game, {
			account: player,
			functionName: 'addToReserve',
			args: [player, amount],
		});
	}

	it('lets an authorised key commit for the account, bonding the ACCOUNT reserve', async function () {
		const {env, Game, GameToken, unnamedAccounts, advanceToEpoch, getEpoch, getTimestamp} =
			await networkHelpers.loadFixture(deployAll);

		const account = unnamedAccounts[0];
		// Stands in for the browser's local signer: it holds no tokens and has no
		// reserve of its own, which is the whole point.
		const signer = unnamedAccounts[1];
		const {epoch: startEpoch} = getEpoch(await getTimestamp());
		await advanceToEpoch(startEpoch + 2, true);

		await stake(env, Game, GameToken, account, parseEther('10'));

		await env.execute(Game, {
			account,
			functionName: 'registerDelegate',
			args: [signer, zeroAddress],
		});
		// Asked about the PAIR, which is the only question there is: an account
		// may authorise several browsers, so there is no such thing as "the"
		// delegate to read back.
		expect(
			await env.read(Game, {
				functionName: 'delegationStatus',
				args: [account, signer],
			}),
		).toEqual([true, false]);

		const placements: Placement[] = [{cellID: cellAt(5, 6)}];
		await env.execute(Game, {
			// SENT BY the signer, FOR the account.
			account: signer,
			functionName: 'makeCommitment',
			args: [
				account,
				commitmentHash(placements, SECRET_A),
				parseEther('1'),
				zeroAddress,
			],
		});

		// The commitment is the ACCOUNT'S, not the sender's. If it were filed
		// under the signer, losing the browser would lose the round, and the bond
		// would have come from a reserve the signer does not have.
		const commitment = (await env.read(Game, {
			functionName: 'getCommitment',
			args: [account],
		})) as {hash: `0x${string}`; bond: bigint};
		expect(commitment.bond).toEqual(parseEther('1'));

		const signerCommitment = (await env.read(Game, {
			functionName: 'getCommitment',
			args: [signer],
		})) as {hash: `0x${string}`; bond: bigint};
		expect(signerCommitment.bond).toEqual(0n);
	});

	it('refuses a key the account never authorised', async function () {
		const {env, Game, GameToken, unnamedAccounts, advanceToEpoch, getEpoch, getTimestamp} =
			await networkHelpers.loadFixture(deployAll);

		const account = unnamedAccounts[0];
		const stranger = unnamedAccounts[2];
		const {epoch: startEpoch} = getEpoch(await getTimestamp());
		await advanceToEpoch(startEpoch + 2, true);

		await stake(env, Game, GameToken, account, parseEther('10'));

		// Without the check this succeeds, and that is the theft: a stranger bonds
		// someone else's reserve to a commitment only they know the secret for, so
		// it can never be revealed and the bond is simply lost.
		await expect(
			env.execute(Game, {
				account: stranger,
				functionName: 'makeCommitment',
				args: [
					account,
					commitmentHash([{cellID: cellAt(1, 1)}], SECRET_A),
					parseEther('1'),
					zeroAddress,
				],
			}),
		).toBeRejected();

		const commitment = (await env.read(Game, {
			functionName: 'getCommitment',
			args: [account],
		})) as {bond: bigint};
		expect(commitment.bond).toEqual(0n);
	});

	it('never lets the delegate withdraw the stake', async function () {
		// The line that makes a disposable key safe to hold. It may SPEND the
		// reserve on playing, which is what it is for, and it may not take it out.
		// `withdrawFromReserve` has no player argument at all, so the delegate can
		// only ever withdraw its OWN reserve, which is empty.
		const {env, Game, GameToken, unnamedAccounts, advanceToEpoch, getEpoch, getTimestamp} =
			await networkHelpers.loadFixture(deployAll);

		const account = unnamedAccounts[0];
		const signer = unnamedAccounts[1];
		const {epoch: startEpoch} = getEpoch(await getTimestamp());
		await advanceToEpoch(startEpoch + 2, true);

		await stake(env, Game, GameToken, account, parseEther('10'));
		await env.execute(Game, {
			account,
			functionName: 'registerDelegate',
			args: [signer, zeroAddress],
		});

		await expect(
			env.execute(Game, {
				account: signer,
				functionName: 'withdrawFromReserve',
				args: [parseEther('10')],
			}),
		).toBeRejected();

		expect(
			await env.read(Game, {functionName: 'getReserve', args: [account]}),
		).toEqual(parseEther('10'));
	});

	it('routes every delegation selector on the proxy', async function () {
		// The router is where this breaks in practice: a route missing from the
		// deploy script, or two routes claiming one selector. Either way the
		// failure is a call that reverts with "function selector was not
		// recognized", which reads to a user as a broken wallet rather than as a
		// missing feature. Reading through the proxy is the only check that covers
		// the wiring as well as the code.
		//
		// All six of them, including the two writers, which are reached with a
		// call rather than a transaction: a selector that does not route reverts
		// on `eth_call` exactly as it would on a send, and this way the assertion
		// is about the wiring rather than about what registering does.
		const {env, Game, unnamedAccounts} =
			await networkHelpers.loadFixture(deployAll);
		const account = unnamedAccounts[0];

		expect(
			await env.read(Game, {
				functionName: 'delegationStatus',
				args: [account, account],
			}),
		).toEqual([false, false]);
		expect(
			typeof (await env.read(Game, {
				functionName: 'delegationMessage',
				args: [account, 0n],
			})),
		).toEqual('string');
		expect(
			typeof (await env.read(Game, {
				functionName: 'delegationDigest',
				args: [account, 0n],
			})),
		).toEqual('string');

		// The writers, sent for real. A selector that does not route reverts
		// before it reaches any code, so these landing at all is the assertion.
		const delegate = unnamedAccounts[1];
		await env.execute(Game, {
			account,
			functionName: 'registerDelegate',
			args: [delegate, zeroAddress],
		});
		await env.execute(Game, {
			account,
			functionName: 'revokeDelegate',
			args: [delegate],
		});
		expect(
			await env.read(Game, {
				functionName: 'delegationStatus',
				args: [account, delegate],
			}),
		).toEqual([false, true]);

		// The last one is reached by the error it gives back: rejecting the
		// signature means it got as far as the library, which is what routing
		// means here. A missing route would have said "function selector was not
		// recognized" instead.
		await expect(
			env.execute(Game, {
				account,
				functionName: 'registerDelegateViaSignature',
				args: [account, unnamedAccounts[2], 0n, `0x${'11'.repeat(65)}`],
				gas: 1000000n,
			}),
		).toBeRejectedWith(`custom error 'MalformedSignature()'`);
	});
});

/**
 * WHICH CONTRACT A SIGNATURE IS GOOD AT, when the contract is behind a router.
 *
 * The delegation message names the verifying contract, taken from
 * `address(this)`, and that bound is the whole point of the mechanism: a
 * credential minted for one game must not be submittable at another. This game
 * is deployed behind a PROXY, which the library upstream is not, so the answer
 * to "which address is that" is not something to reason about from how
 * `delegatecall` works. It is something to read off the deployed thing.
 *
 * If it were the route implementation rather than the proxy, every consequence
 * would be wrong at once: the client addresses the proxy, so it would build a
 * message for an address the contract never checks against; and re-deploying a
 * route would invalidate every signature already in existence.
 */
describe('Game delegation behind the router', function () {
	it('names the PROXY as the verifying contract, not the route', async function () {
		const {env, Game} = await networkHelpers.loadFixture(deployAll);
		const delegate = privateKeyToAccount(generatePrivateKey()).address;

		const message = (await env.read(Game, {
			functionName: 'delegationMessage',
			args: [delegate, 0n],
		})) as string;

		// The address the client talks to is the address inside the text.
		expect(message).toInclude(Game.address.toLowerCase());

		// And the route's own address is nowhere in it. Read from the deployment
		// rather than assumed, so this fails if the route stops being separate.
		const route = env.get('Game_Implementation_Router_Delegation_Route');
		expect(route.address.toLowerCase()).not.toEqual(Game.address.toLowerCase());
		expect(message).not.toInclude(route.address.toLowerCase());
	});

	it('accepts a signature built for the proxy, from the package builder', async function () {
		// The end of the chain the previous test starts: the client builds the
		// message in TypeScript for the address it addresses, the owner signs it
		// without ever sending anything, somebody else submits it, and the
		// registration lands. Nothing here reads the message off the contract, so
		// the two implementations are agreeing rather than being compared.
		const {env, Game, unnamedAccounts} =
			await networkHelpers.loadFixture(deployAll);

		const owner = privateKeyToAccount(generatePrivateKey());
		const delegate = privateKeyToAccount(generatePrivateKey());
		const payer = unnamedAccounts[0];
		const chainId = Number(
			BigInt((await provider.request({method: 'eth_chainId'})) as string),
		);

		const signature = await owner.signMessage({
			message: delegationMessage({
				delegate: delegate.address,
				contract: Game.address,
				chainId,
				deadline: 0,
			}),
		});

		await env.execute(Game, {
			account: payer,
			functionName: 'registerDelegateViaSignature',
			args: [owner.address, delegate.address, 0n, signature],
		});

		expect(
			await env.read(Game, {
				functionName: 'delegationStatus',
				args: [owner.address, delegate.address],
			}),
		).toEqual([true, false]);
	});

	it('refuses a signature naming the route implementation instead', async function () {
		// The negative half, and the one that would catch the bug quietly. A
		// signature for the wrong contract is well-formed, recovers to a real
		// address, and is simply somebody else's - so if the proxy ever started
		// verifying against the route, the test above would still pass while every
		// credential in the wild stopped working.
		const {env, Game, unnamedAccounts} =
			await networkHelpers.loadFixture(deployAll);

		const owner = privateKeyToAccount(generatePrivateKey());
		const delegate = privateKeyToAccount(generatePrivateKey());
		const route = env.get('Game_Implementation_Router_Delegation_Route');
		const chainId = Number(
			BigInt((await provider.request({method: 'eth_chainId'})) as string),
		);

		const signature = await owner.signMessage({
			message: delegationMessage({
				delegate: delegate.address,
				contract: route.address,
				chainId,
				deadline: 0,
			}),
		});

		await expect(
			env.execute(Game, {
				account: unnamedAccounts[0],
				functionName: 'registerDelegateViaSignature',
				args: [owner.address, delegate.address, 0n, signature],
				gas: 1000000n,
			}),
		).toBeRejectedWith(`custom error 'InvalidSignature()'`);
	});
});
