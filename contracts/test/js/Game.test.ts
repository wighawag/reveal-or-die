import {expect} from 'earl';
import {describe, it} from 'node:test'; // using node:test as hardhat v3 do not support vitest
import {network} from 'hardhat';
import {setupFixtures} from './utils/index.js';
import {encodeAbiParameters, keccak256, parseEther, zeroAddress} from 'viem';

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
		expect(
			(
				(await env.read(Game, {
					functionName: 'delegateOf',
					args: [account],
				})) as string
			).toLowerCase(),
		).toEqual(signer.toLowerCase());

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
		const {env, Game, unnamedAccounts} = await networkHelpers.loadFixture(deployAll);
		const account = unnamedAccounts[0];

		expect(
			await env.read(Game, {functionName: 'delegateOf', args: [account]}),
		).toEqual(zeroAddress);
		expect(
			await env.read(Game, {
				functionName: 'delegationWithdrawn',
				args: [account, account],
			}),
		).toEqual(false);
		expect(
			typeof (await env.read(Game, {
				functionName: 'delegationMessage',
				args: ['example.com', account],
			})),
		).toEqual('string');
	});
});
