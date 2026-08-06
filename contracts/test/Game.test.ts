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
			args: [parseEther('10')],
		});

		expect(
			await env.read(Game, {functionName: 'getReserve', args: [player]}),
		).toEqual(parseEther('10'));

		// Commit.
		const placements: Placement[] = [{cellID: cellAt(3, 4)}];
		await env.execute(Game, {
			account: player,
			functionName: 'makeCommitment',
			args: [
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
					args: [parseEther('10')],
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
					commitmentHash(placementsA, SECRET_A),
					parseEther('5'),
					zeroAddress,
				],
			});
			await env.execute(Game, {
				account: playerB,
				functionName: 'makeCommitment',
				args: [
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
			args: [parseEther('10')],
		});

		const placements: Placement[] = [{cellID: cellAt(1, 1)}];
		await env.execute(Game, {
			account: player,
			functionName: 'makeCommitment',
			args: [
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
			args: [parseEther('10')],
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
