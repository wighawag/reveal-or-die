import {expect} from 'earl';
import {describe, it} from 'node:test'; // using node:test as hardhat v3 do not support vitest
import {network} from 'hardhat';
import {
	setupFixtures,
	idOf,
	enterGame,
	avatarOwner,
	deployGameWith,
	CYCLE_POLICY,
	commitmentChain,
	commitmentHashFor,
	revealTurn,
	DEFAULT_ACTIONS_PER_REVEAL,
	NO_FURTHER_ACTIONS,
	type CyclePolicy,
	type Placement,
} from './utils/index.js';
import {zeroAddress} from 'viem';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {delegationMessage} from '@etherplay/delegation';

const {provider, networkHelpers} = await network.connect();
const {deployAll} = setupFixtures(provider);

/** Pack a cell coordinate the way PositionUtils does: y in the high 32 bits. */
function cellAt(x: number, y: number): bigint {
	const ux = BigInt.asUintN(32, BigInt(x));
	const uy = BigInt.asUintN(32, BigInt(y));
	return (uy << 32n) + ux;
}

const SECRET_A =
	'0x0000000000000000000000000000000000000000000000000000000000000a11';
const SECRET_B =
	'0x0000000000000000000000000000000000000000000000000000000000000b22';

describe('Game', function () {
	it('places a cell through a full commit/reveal submission', async function () {
		const {
			env,
			Game,
			GameAvatarSale,
			actionsPerReveal,
			unnamedAccounts,
			advanceToCycleNumber,
			advanceToRevealPhase,
			getCycleNumber,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const player = unnamedAccounts[0];
		const {cycleNumber: startCycleNumber} = getCycleNumber(
			await getTimestamp(),
		);
		await advanceToCycleNumber(startCycleNumber + 2, true);

		// Buy an avatar, which puts it at stake in the same transaction.
		const identity = await enterGame({env, Game, GameAvatarSale}, player);

		// WHAT IS AT STAKE, and the identity that is playing, are one thing here.
		expect(await avatarOwner(env, Game, identity)).toEqual(player);

		// Commit.
		//
		// The leading argument is the IDENTITY, which is what a real client sends
		// (it plays through a delegate, so "whoever is calling" would be the wrong
		// answer); the trailing zeroAddress is `payee`, which is unrelated. See
		// the delegation tests below.
		const placements: Placement[] = [{cellID: cellAt(3, 4)}];
		await env.execute(Game, {
			account: player,
			functionName: 'makeCommitment',
			args: [
				identity,
				commitmentHashFor(placements, SECRET_A, actionsPerReveal),
				0n,
				zeroAddress,
			],
		});

		// Reveal.
		const {cycleNumber} = getCycleNumber(await getTimestamp());
		await advanceToRevealPhase(cycleNumber, true);
		await revealTurn(
			{env, Game},
			{
				account: player,
				identity,
				placements,
				secret: SECRET_A,
				actionsPerReveal,
			},
		);

		const cell = (await env.read(Game, {
			functionName: 'getCell',
			args: [cellAt(3, 4)],
		})) as {totalStake: bigint; numClaimants: number};

		expect(cell.totalStake).toEqual(0n);
		expect(cell.numClaimants).toEqual(1);

		// The placement cost nothing, and the avatar is still at stake: playing a
		// round neither spends the stake nor releases it. On `main` this is where
		// the reserve goes down by the placement cost.
		expect(await avatarOwner(env, Game, identity)).toEqual(player);
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
	 *
	 * IT IS REPLAYED UNDER EVERY CYCLE POLICY, because the policy is the place
	 * the same failure can reappear one level up: a cycle that could be pushed
	 * forward by a subset would let whoever is quickest decide what everyone
	 * else got, which is the reveal race wearing a clock. The board must come
	 * out identical whether the phase turned over on a timer or because the
	 * players were all present and said so.
	 */
	it('reaches the same board whichever order the reveals arrive in', async function () {
		async function boardAfterRevealsInOrder(
			revealFirst: 'A' | 'B',
			policy: CyclePolicy,
		): Promise<{
			contested: {totalStake: bigint; numClaimants: number};
			listed: string[];
		}> {
			const fixtures = await networkHelpers.loadFixture(deployAll);
			const {
				env,
				Game: TimedGame,
				GameAvatarSale,
				actionsPerReveal,
				unnamedAccounts,
				advanceToCycleNumber,
				advanceToRevealPhase,
				getCycleNumber,
				getTimestamp,
			} = fixtures;

			const playerA = unnamedAccounts[0];
			const playerB = unnamedAccounts[1];

			const {cycleNumber: startCycleNumber} = getCycleNumber(
				await getTimestamp(),
			);
			await advanceToCycleNumber(startCycleNumber + 2, true);

			// The shipped deployment is the timed one, so that policy is played
			// on the real thing rather than on a copy of it.
			const manual = policy === CYCLE_POLICY.Manual;
			const Game =
				policy === CYCLE_POLICY.Timed
					? TimedGame
					: await deployGameWith(fixtures, {
							name: `Game_replay_${policy}`,
							cyclePolicy: policy,
							commitPhaseDuration: manual ? 0n : 30n,
							revealPhaseDuration: manual ? 0n : 10n,
						});

			/** Get to the reveal phase the way this policy allows. */
			async function openRevealPhase() {
				if (policy === CYCLE_POLICY.Timed) {
					const {cycleNumber} = getCycleNumber(await getTimestamp());
					await advanceToRevealPhase(cycleNumber, true);
					return;
				}
				// Both players have committed, so the phase may be brought
				// forward. Anyone may do it; it is nobody's move.
				await env.execute(Game, {
					account: playerA,
					functionName: 'advanceCycle',
					args: [],
				});
			}

			// The whole fixture bag with the game to enter overriding the
			// deployed one: how a player gets IN is the game's, and it is what
			// `utils` exists to differ about between branches.
			const identityA = await enterGame({...fixtures, Game}, playerA);
			const identityB = await enterGame({...fixtures, Game}, playerB);

			// Both players commit to the SAME cell, blind to each other, and each
			// also takes a cell of their own. The private cells are what make the
			// zone LISTING order-sensitive if anything is: they are claimed for
			// the first time by different reveals, so whichever lands first is
			// indexed first.
			const contested = cellAt(7, 7);
			const onlyA = cellAt(6, 7);
			const onlyB = cellAt(5, 7);
			const placementsA: Placement[] = [{cellID: contested}, {cellID: onlyA}];
			const placementsB: Placement[] = [{cellID: contested}, {cellID: onlyB}];

			await env.execute(Game, {
				account: playerA,
				functionName: 'makeCommitment',
				args: [
					identityA,
					commitmentHashFor(placementsA, SECRET_A, actionsPerReveal),
					0n,
					zeroAddress,
				],
			});
			await env.execute(Game, {
				account: playerB,
				functionName: 'makeCommitment',
				args: [
					identityB,
					commitmentHashFor(placementsB, SECRET_B, actionsPerReveal),
					0n,
					zeroAddress,
				],
			});

			await openRevealPhase();

			const revealA = () =>
				revealTurn(
					{env, Game},
					{
						account: playerA,
						identity: identityA,
						placements: placementsA,
						secret: SECRET_A,
						actionsPerReveal,
					},
				);
			const revealB = () =>
				revealTurn(
					{env, Game},
					{
						account: playerB,
						identity: identityB,
						placements: placementsB,
						secret: SECRET_B,
						actionsPerReveal,
					},
				);

			if (revealFirst === 'A') {
				await revealA();
				await revealB();
			} else {
				await revealB();
				await revealA();
			}

			const cell = (await env.read(Game, {
				functionName: 'getCell',
				args: [contested],
			})) as {totalStake: bigint; numClaimants: number};

			// The same zone as the client reads it. Sorted, because the ORDER of
			// this list is allowed to depend on arrival (see _place: the zone
			// index is appended to by whichever reveal claims a cell first) while
			// its CONTENT is not. Sorting is what separates the two, so this
			// assertion says what it means to.
			// All three cells are in zone 0, which spans -8..7 on both axes.
			const [listed] = (await env.read(Game, {
				functionName: 'getCellsInZone',
				args: [0n],
			})) as [
				{cellID: bigint; totalStake: bigint; numClaimants: number}[],
				bigint,
			];

			return {
				contested: cell,
				listed: listed
					.map((c) => `${c.cellID}:${c.totalStake}:${c.numClaimants}`)
					.sort(),
			};
		}

		for (const policy of [
			CYCLE_POLICY.Timed,
			CYCLE_POLICY.Manual,
			CYCLE_POLICY.TimedWithEarlyAdvance,
		] as CyclePolicy[]) {
			const aFirst = await boardAfterRevealsInOrder('A', policy);
			const bFirst = await boardAfterRevealsInOrder('B', policy);

			// Same final board either way: the cell is shared, not won.
			expect(aFirst.contested.totalStake).toEqual(bFirst.contested.totalStake);
			expect(aFirst.contested.numClaimants).toEqual(
				bFirst.contested.numClaimants,
			);

			// And it really is shared, rather than both reveals failing.
			expect(aFirst.contested.numClaimants).toEqual(2);
			// Nothing is bonded on this branch: a placement costs zero, because
			// what is at stake is custody of the avatar rather than a reserve.
			expect(aFirst.contested.totalStake).toEqual(0n);

			// The board a client READS is the same board too. This is a separate
			// claim from the one above: the cells are listed out of a per-zone
			// index that reveals append to, so an index that indexed only what
			// the first reveal saw, or that indexed a cell twice, would leave
			// the stakes identical and still show two different boards.
			expect(aFirst.listed).toEqual(bFirst.listed);
			expect(aFirst.listed.length).toEqual(3);
		}
	});

	it('counts a member per AVATAR, because that is what plays here', async function () {
		const fixtures = await networkHelpers.loadFixture(deployAll);
		const {env, Game, GameAvatarSale, unnamedAccounts} = fixtures;
		const player = unnamedAccounts[0];

		// THE MIRROR OF UPSTREAM'S TEST, AND IT ASSERTS THE OPPOSITE NUMBER,
		// which is why it could not simply be inherited. There a member is an
		// account with a funded reserve, so topping up twice must still be one
		// member; here a member is an AVATAR IN CUSTODY, so an owner who buys
		// two avatars really is two of the things the cycle waits for - each
		// one commits and reveals for itself. The hazard upstream found by
		// mutation (one member counted twice makes unanimity unreachable) does
		// not arise here at all, because a token cannot be deposited twice.
		await enterGame({env, Game, GameAvatarSale}, player);
		await enterGame({env, Game, GameAvatarSale}, player);

		const attendance = (await env.read(Game, {
			functionName: 'getAttendance',
		})) as {waitedFor: bigint};
		expect(attendance.waitedFor).toEqual(2n);
	});

	it('seizes the avatar of a player who never reveals', async function () {
		const {
			env,
			Game,
			GameAvatarSale,
			actionsPerReveal,
			unnamedAccounts,
			advanceToCycleNumber,
			getCycleNumber,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const player = unnamedAccounts[0];
		const {cycleNumber: startCycleNumber} = getCycleNumber(
			await getTimestamp(),
		);
		await advanceToCycleNumber(startCycleNumber + 2, true);

		const identity = await enterGame({env, Game, GameAvatarSale}, player);

		const placements: Placement[] = [{cellID: cellAt(1, 1)}];
		await env.execute(Game, {
			account: player,
			functionName: 'makeCommitment',
			args: [
				identity,
				commitmentHashFor(placements, SECRET_A, actionsPerReveal),
				0n,
				zeroAddress,
			],
		});

		// Let the cycle pass without revealing.
		const {cycleNumber} = getCycleNumber(await getTimestamp());
		await advanceToCycleNumber(cycleNumber + 1, true);

		await env.execute(Game, {
			account: unnamedAccounts[1],
			functionName: 'acknowledgeMissedReveal',
			args: [identity],
		});

		// THE WHOLE AVATAR IS GONE, which is what this branch puts at stake in
		// place of a bond. The NFT stays in the game contract for good: nobody
		// owns it, so nobody can play it and nobody can take it out.
		expect(await avatarOwner(env, Game, identity)).toEqual(zeroAddress);

		await expect(
			env.execute(Game, {
				account: player,
				functionName: 'withdrawAvatar',
				args: [identity, player],
				gas: 1000000n,
			}),
		).toBeRejected();
	});

	it('will not let a player walk away from a commitment', async function () {
		// THE COSTLESS EXIT, refused. Custody is only a stake while the game
		// holds the avatar, so a player who dislikes what they have committed to
		// must not be able to take it home before the reveal window shuts - and
		// must not be able to rescue it afterwards either, because by then it is
		// forfeit and `acknowledgeMissedReveal` is what makes that so.
		//
		// Reading `ownerOf` instead of holding the token would have exactly this
		// hole with an extra step: sell the avatar inside the window and let the
		// buyer be seized from.
		const {
			env,
			Game,
			GameAvatars,
			GameAvatarSale,
			actionsPerReveal,
			unnamedAccounts,
			advanceToCycleNumber,
			getCycleNumber,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const player = unnamedAccounts[0];
		const {cycleNumber: startCycleNumber} = getCycleNumber(
			await getTimestamp(),
		);
		await advanceToCycleNumber(startCycleNumber + 2, true);

		const identity = await enterGame({env, Game, GameAvatarSale}, player);

		// Nothing committed yet, so leaving is allowed - and it really leaves.
		const second = await enterGame({env, Game, GameAvatarSale}, player);
		await env.execute(Game, {
			account: player,
			functionName: 'withdrawAvatar',
			args: [second, player],
		});
		expect(
			String(
				await env.read(GameAvatars, {functionName: 'ownerOf', args: [second]}),
			).toLowerCase(),
		).toEqual(player);

		await env.execute(Game, {
			account: player,
			functionName: 'makeCommitment',
			args: [
				identity,
				commitmentHashFor([{cellID: cellAt(4, 4)}], SECRET_A, actionsPerReveal),
				0n,
				zeroAddress,
			],
		});

		// Committed: the avatar is pinned for as long as the commitment is open.
		await expect(
			env.execute(Game, {
				account: player,
				functionName: 'withdrawAvatar',
				args: [identity, player],
				gas: 1000000n,
			}),
		).toBeRejectedWith(`custom error 'AvatarIsCommitted(`);

		// And still pinned once the window has shut, when it is forfeit.
		const {cycleNumber} = getCycleNumber(await getTimestamp());
		await advanceToCycleNumber(cycleNumber + 1, true);
		await expect(
			env.execute(Game, {
				account: player,
				functionName: 'withdrawAvatar',
				args: [identity, player],
				gas: 1000000n,
			}),
		).toBeRejectedWith(`custom error 'AvatarIsCommitted(`);
	});

	it('lets one address pay for an avatar and another play it', async function () {
		// The split the whole client architecture depends on: a player's moves are
		// signed by a local key that holds no funds, while the stake is paid from
		// the wallet that does. Without this, a wallet prompt would be required for
		// every commit and every reveal, and an email/social account (which has no
		// wallet provider at all) could not play.
		const {
			env,
			Game,
			GameAvatarSale,
			actionsPerReveal,
			unnamedAccounts,
			advanceToCycleNumber,
			advanceToRevealPhase,
			getCycleNumber,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const payer = unnamedAccounts[0]; // the wallet, holds the money
		const player = unnamedAccounts[1]; // the signing key, holds nothing

		const {cycleNumber: startCycleNumber} = getCycleNumber(
			await getTimestamp(),
		);
		await advanceToCycleNumber(startCycleNumber + 2, true);

		const identity = await enterGame({env, Game, GameAvatarSale}, player, {
			payer,
		});

		expect(await avatarOwner(env, Game, identity)).toEqual(player);
		// The payer bought something and owns nothing: an avatar belongs to whoever
		// it was bought FOR. `idOf` is what an address game would have keyed this
		// address by, which is the only way to ask "is this address a player" on a
		// game where players are avatars.
		expect(
			(
				(await env.read(Game, {
					functionName: 'getCommitment',
					args: [idOf(payer)],
				})) as {cycleNumber: bigint}
			).cycleNumber,
		).toEqual(0n);

		// And the player, who never held a token, can now play on it.
		const placements: Placement[] = [{cellID: cellAt(5, 5)}];
		await env.execute(Game, {
			account: player,
			functionName: 'makeCommitment',
			args: [
				identity,
				commitmentHashFor(placements, SECRET_A, actionsPerReveal),
				0n,
				zeroAddress,
			],
		});

		const {cycleNumber} = getCycleNumber(await getTimestamp());
		await advanceToRevealPhase(cycleNumber, true);
		await revealTurn(
			{env, Game},
			{
				account: player,
				identity,
				placements,
				secret: SECRET_A,
				actionsPerReveal,
			},
		);

		const cell = (await env.read(Game, {
			functionName: 'getCell',
			args: [cellAt(5, 5)],
		})) as {totalStake: bigint; numClaimants: number};
		expect(cell.numClaimants).toEqual(1);

		// Still at stake, and still the player's rather than the payer's.
		expect(await avatarOwner(env, Game, identity)).toEqual(player);
	});

	it('lists placed cells in a zone', async function () {
		const {
			env,
			Game,
			GameAvatarSale,
			actionsPerReveal,
			unnamedAccounts,
			advanceToCycleNumber,
			advanceToRevealPhase,
			getCycleNumber,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const player = unnamedAccounts[0];
		const {cycleNumber: startCycleNumber} = getCycleNumber(
			await getTimestamp(),
		);
		await advanceToCycleNumber(startCycleNumber + 2, true);

		const identity = await enterGame({env, Game, GameAvatarSale}, player);

		// Two cells inside zone 0 (which spans -8..7 on both axes).
		const placements: Placement[] = [
			{cellID: cellAt(0, 0)},
			{cellID: cellAt(2, -3)},
		];
		await env.execute(Game, {
			account: player,
			functionName: 'makeCommitment',
			args: [
				identity,
				commitmentHashFor(placements, SECRET_A, actionsPerReveal),
				0n,
				zeroAddress,
			],
		});

		const {cycleNumber} = getCycleNumber(await getTimestamp());
		await advanceToRevealPhase(cycleNumber, true);
		await revealTurn(
			{env, Game},
			{
				account: player,
				identity,
				placements,
				secret: SECRET_A,
				actionsPerReveal,
			},
		);

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
 * A TURN MAY BE BIGGER THAN A TRANSACTION.
 *
 * Every chain has a gas ceiling, so a turn longer than that ceiling has to
 * arrive in pieces. The commitment is therefore the head of a HASH CHAIN: each
 * reveal opens one chunk and rewrites the head to the hash of the next, and the
 * commitment stays open until a chunk arrives declaring no further actions.
 *
 * The chunk is a MECHANISM and belongs to the framework, because every game on
 * this template needs it. It is not a cap on a TURN, which is a game rule, only
 * binds where identity is scarce, and is nobody's business here.
 *
 * Three things in here are load-bearing rather than tidy, and each has its own
 * test below because each fails silently and expensively:
 *
 * - a non-final chunk must be EXACTLY full, or a turn spreads over unbounded
 *   reveals;
 * - the cycle's tally counts TURNS and not transactions, or somebody else's
 *   advance strands the rest of a half-revealed turn;
 * - a half-revealed turn must still SETTLE, or the player is blocked forever.
 */
describe('a turn bigger than a transaction', function () {
	/** A row of cells, all in one zone, distinct from every other suite's. */
	function row(count: number, y: number): Placement[] {
		return Array.from({length: count}, (_, i) => ({cellID: cellAt(i, y)}));
	}

	/**
	 * The zone a cell is indexed under. Mirrors `PositionUtils.zoneCoord`.
	 *
	 * Written out rather than asked of the contract, and used rather than a zone
	 * id spelled as a literal: a literal that was wrong simply read an empty
	 * zone, so an assertion about the listing would have compared nothing with
	 * nothing and passed.
	 */
	function zoneOfCell(placement: Placement): bigint {
		const coord = (a: bigint) =>
			a >= 0n ? (a + 8n) / 16n : -((-a + 7n) / 16n);
		const x = BigInt.asIntN(32, placement.cellID & 0xffffffffn);
		const y = BigInt.asIntN(32, placement.cellID >> 32n);
		return (BigInt.asUintN(32, coord(y)) << 32n) + BigInt.asUintN(32, coord(x));
	}

	/**
	 * A game in its reveal phase, with one player in it and a turn committed.
	 *
	 * NOTHING IS BONDED, and that is this branch in one argument. A placement
	 * costs nothing here because custody of the AVATAR is the stake, so the
	 * reserve is never funded and a commitment bonds zero. Everything the chunk
	 * does is unaffected - it bounds a transaction, not a payment - which is
	 * exactly the claim worth making on a branch with no bond at all.
	 */
	async function committed(turn: Placement[], bond = 0n) {
		const fixtures = await networkHelpers.loadFixture(deployAll);
		const {
			env,
			Game,
			GameAvatarSale,
			actionsPerReveal,
			unnamedAccounts,
			advanceToCycleNumber,
			advanceToRevealPhase,
			getCycleNumber,
			getTimestamp,
		} = fixtures;

		const player = unnamedAccounts[0];
		const {cycleNumber: startCycleNumber} = getCycleNumber(
			await getTimestamp(),
		);
		await advanceToCycleNumber(startCycleNumber + 2, true);

		const identity = await enterGame({env, Game, GameAvatarSale}, player);
		const {chunks} = commitmentChain(turn, SECRET_A, actionsPerReveal);

		await env.execute(Game, {
			account: player,
			functionName: 'makeCommitment',
			args: [
				identity,
				commitmentHashFor(turn, SECRET_A, actionsPerReveal),
				bond,
				zeroAddress,
			],
		});

		const {cycleNumber} = getCycleNumber(await getTimestamp());
		await advanceToRevealPhase(cycleNumber, true);

		function revealChunk(index: number) {
			return env.execute(Game, {
				account: player,
				functionName: 'reveal',
				args: [
					identity,
					chunks[index].placements,
					SECRET_A,
					chunks[index].furtherActions,
					zeroAddress,
				],
			});
		}

		async function commitment() {
			return (await env.read(Game, {
				functionName: 'getCommitment',
				args: [identity],
			})) as {hash: `0x${string}`; cycleNumber: bigint; bond: bigint};
		}

		/**
		 * Whether this cell has been claimed, which is what a landed placement
		 * LOOKS LIKE here.
		 *
		 * `main` reads the cell's total stake, because there a placement moves a
		 * token out of the reserve and onto the board. A placement costs nothing
		 * on this branch, so the stake stays zero however much of a turn has
		 * landed, and reading it would be an assertion that passes whether or not
		 * the reveal did anything at all.
		 */
		async function claimantsOn(cellID: bigint): Promise<number> {
			const cell = (await env.read(Game, {
				functionName: 'getCell',
				args: [cellID],
			})) as {numClaimants: number};
			return cell.numClaimants;
		}

		return {
			...fixtures,
			player,
			identity,
			chunks,
			cycleNumber,
			revealChunk,
			commitment,
			claimantsOn,
		};
	}

	it('reveals a turn across as many transactions as it takes', async function () {
		const turn = row(6, 20);
		const game = await committed(turn);

		// Six actions at four per reveal is two chunks, and the SECOND one is
		// short. Asserted rather than assumed, because a chunking that produced
		// one chunk would make everything below pass while testing nothing.
		expect(game.chunks.length).toEqual(2);
		expect(game.chunks[0].placements.length).toEqual(game.actionsPerReveal);
		expect(game.chunks[1].furtherActions).toEqual(NO_FURTHER_ACTIONS);

		await game.revealChunk(0);
		await game.revealChunk(1);

		for (const placement of turn) {
			expect(await game.claimantsOn(placement.cellID)).toEqual(1);
		}
		// The turn is closed, and the avatar is still at stake: playing a turn
		// neither spends the stake nor releases it. On `main` this is where the
		// reserve goes down and the surplus bond is released.
		expect((await game.commitment()).cycleNumber).toEqual(0n);
		expect((await game.commitment()).bond).toEqual(0n);
		expect(await avatarOwner(game.env, game.Game, game.identity)).toEqual(
			game.player,
		);
	});

	it('advances the head and keeps the commitment open between chunks', async function () {
		const turn = row(6, 21);
		const game = await committed(turn);

		await game.revealChunk(0);

		const open = await game.commitment();
		// THE HEAD MOVED. This is what a client resumes from: which chunk is due
		// next is a fact on chain rather than something a browser remembers.
		expect(open.hash).toEqual(game.chunks[0].furtherActions);
		expect(open.cycleNumber).toEqual(BigInt(game.cycleNumber));
		// NOTHING WAS EVER BONDED, so there is nothing for a chunk to take out of
		// the bond. On `main` this is where it falls by what the chunk cost; here
		// what is still at stake for the unopened half is the avatar, and the
		// avatar is indivisible - which is why the settlement below takes all of
		// it however far the chain got.
		expect(open.bond).toEqual(0n);

		// Half the turn is on the board; the other half is still hidden.
		expect(await game.claimantsOn(turn[0].cellID)).toEqual(1);
		expect(await game.claimantsOn(turn[5].cellID)).toEqual(0);
	});

	it('refuses a chunk that promises more but is not full', async function () {
		// LOAD-BEARING. Without it a player dribbles one action per transaction
		// and spreads a turn across an unbounded number of reveals, which is a
		// denial of service on the reveal phase and on everyone else's reads.
		const game = await committed(row(6, 22));
		const {env, Game, player, identity, chunks} = game;

		await expect(
			env.execute(Game, {
				account: player,
				functionName: 'reveal',
				args: [
					identity,
					chunks[0].placements.slice(0, 1),
					SECRET_A,
					chunks[0].furtherActions,
					zeroAddress,
				],
				gas: 1000000n,
			}),
		).toBeRejectedWith(`custom error 'InvalidFurtherActions(`);

		// Nothing was applied, so the turn is exactly where it was.
		expect((await game.commitment()).hash).not.toEqual(
			chunks[0].furtherActions,
		);
	});

	it('refuses a chunk carrying more than one transaction may', async function () {
		// The rule the ported design does NOT have, and the reason to add it: the
		// chunk exists to make a reveal's worst case calculable, and a final chunk
		// allowed to be any length would give that back for the last transaction
		// of every single turn.
		const fixtures = await networkHelpers.loadFixture(deployAll);
		const {
			env,
			Game,
			GameAvatarSale,
			actionsPerReveal,
			unnamedAccounts,
			advanceToCycleNumber,
			advanceToRevealPhase,
			getCycleNumber,
			getTimestamp,
		} = fixtures;

		const player = unnamedAccounts[0];
		const {cycleNumber: startCycleNumber} = getCycleNumber(
			await getTimestamp(),
		);
		await advanceToCycleNumber(startCycleNumber + 2, true);
		const identity = await enterGame({env, Game, GameAvatarSale}, player);

		// A turn hashed as ONE oversized chunk, which is what a client that had
		// not read the deployment's chunk size would build.
		//
		// THE RULE MATTERS MORE ON THIS BRANCH THAN ON `main`. There a turn is
		// bounded economically - the reserve buys ten placements and no more - so
		// even before chunking a reveal could not be enormous. A placement costs
		// nothing here, so this parameter is the ONLY thing that bounds one, and
		// without the length check a single reveal could walk an unbounded number
		// of cells into the per-zone index every other player then reads.
		const oversized = row(actionsPerReveal + 1, 23);
		const head = commitmentHashFor(oversized, SECRET_A, oversized.length);
		await env.execute(Game, {
			account: player,
			functionName: 'makeCommitment',
			args: [identity, head, 0n, zeroAddress],
		});

		const {cycleNumber} = getCycleNumber(await getTimestamp());
		await advanceToRevealPhase(cycleNumber, true);

		await expect(
			env.execute(Game, {
				account: player,
				functionName: 'reveal',
				args: [identity, oversized, SECRET_A, NO_FURTHER_ACTIONS, zeroAddress],
				gas: 1000000n,
			}),
		).toBeRejectedWith(`custom error 'TooManyActions(`);
	});

	it('will not let the cycle close on a half-revealed turn', async function () {
		// THE TALLY COUNTS TURNS, NOT TRANSACTIONS. Counting a partial reveal
		// would let unanimity close the cycle while a player still owed chunks,
		// and those chunks would then be unrevealable: half a turn applied and the
		// rest lost, by somebody else's advance rather than by anything the player
		// did.
		const fixtures = await networkHelpers.loadFixture(deployAll);
		const {env, unnamedAccounts} = fixtures;

		const Game = await deployGameWith(fixtures, {
			name: 'Game_chunked_advance',
			cyclePolicy: CYCLE_POLICY.Manual,
			commitPhaseDuration: 0n,
			revealPhaseDuration: 0n,
		});
		const actionsPerReveal = Number(DEFAULT_ACTIONS_PER_REVEAL);

		const player = unnamedAccounts[0];
		const identity = await enterGame({...fixtures, Game}, player);

		const turn = row(6, 24);
		const {chunks} = commitmentChain(turn, SECRET_A, actionsPerReveal);
		await env.execute(Game, {
			account: player,
			functionName: 'makeCommitment',
			args: [
				identity,
				commitmentHashFor(turn, SECRET_A, actionsPerReveal),
				0n,
				zeroAddress,
			],
		});
		// Everyone has committed, so the reveal phase may be opened.
		await env.execute(Game, {
			account: player,
			functionName: 'advanceCycle',
			args: [],
		});

		await env.execute(Game, {
			account: player,
			functionName: 'reveal',
			args: [
				identity,
				chunks[0].placements,
				SECRET_A,
				chunks[0].furtherActions,
				zeroAddress,
			],
		});

		await expect(
			env.execute(Game, {
				account: player,
				functionName: 'advanceCycle',
				args: [],
				gas: 1000000n,
			}),
		).toBeRejectedWith(`custom error 'StillWaitingToReveal(`);

		// The last chunk lands, and only now is the cycle over.
		await env.execute(Game, {
			account: player,
			functionName: 'reveal',
			args: [
				identity,
				chunks[1].placements,
				SECRET_A,
				chunks[1].furtherActions,
				zeroAddress,
			],
		});
		await env.execute(Game, {
			account: player,
			functionName: 'advanceCycle',
			args: [],
		});
	});

	it('settles a half-revealed turn in ONE call, and frees the next cycle', async function () {
		// THE PART WITH A PLAYER'S STAKE IN IT. A commitment left open with its
		// head pointing at a chunk nobody will ever submit blocks every later
		// commitment that player makes, forever, and nothing else can resolve it.
		//
		// It settles here without the secret and without the chunk, which is a
		// deliberate departure from the design this chaining is ported from. There
		// the penalty is computed FROM the revealed moves, so the settlement has
		// to walk the chain too; here the penalty is whatever this game puts at
		// stake, the contract already knows what that is, and requiring the secret
		// would make settling depend on the very thing that failed.
		//
		// WHAT IS LOST IS DIFFERENT ON THIS BRANCH, and the difference is worth
		// reading before trusting the assertions below. `main` forfeits the bond,
		// which falls as each chunk lands, so a half-revealed turn there loses
		// exactly the part that was never opened. The stake here is CUSTODY OF THE
		// AVATAR, which is indivisible: half a turn revealed loses the whole
		// avatar just as no turn revealed would. That is not the chunk being
		// unfair, it is what a stake that cannot be divided means, and a game that
		// wants proportionality has to put something divisible at stake.
		const turn = row(6, 25);
		const game = await committed(turn);
		const {
			env,
			Game,
			GameAvatarSale,
			player,
			identity,
			unnamedAccounts,
			advanceToCycleNumber,
			actionsPerReveal,
		} = game;

		await game.revealChunk(0);
		expect(await avatarOwner(env, Game, identity)).toEqual(player);

		// The rest of the turn never arrives and the cycle passes.
		await advanceToCycleNumber(game.cycleNumber + 1, true);

		// ONE call, by anybody, with nothing but the identity.
		await env.execute(Game, {
			account: unnamedAccounts[1],
			functionName: 'acknowledgeMissedReveal',
			args: [identity],
		});

		const settled = await game.commitment();
		expect(settled.cycleNumber).toEqual(0n);
		expect(settled.bond).toEqual(0n);

		// The half that landed stays on the board; the half that did not never
		// arrives; the avatar is gone.
		expect(await game.claimantsOn(turn[0].cellID)).toEqual(1);
		expect(await game.claimantsOn(turn[5].cellID)).toEqual(0);
		expect(await avatarOwner(env, Game, identity)).toEqual(
			'0x0000000000000000000000000000000000000000',
		);

		// AND THE PLAYER IS PLAYING AGAIN. Without this the settlement would have
		// been a formality: what it has to undo is the block on the next turn.
		// With a new avatar, because the old one is what the silence cost.
		const replacement = await enterGame({env, Game, GameAvatarSale}, player);
		const next = row(1, 26);
		await env.execute(Game, {
			account: player,
			functionName: 'makeCommitment',
			args: [
				replacement,
				commitmentHashFor(next, SECRET_B, actionsPerReveal),
				0n,
				zeroAddress,
			],
		});
		const reopened = (await env.read(Game, {
			functionName: 'getCommitment',
			args: [replacement],
		})) as {cycleNumber: bigint};
		expect(reopened.cycleNumber).not.toEqual(0n);
	});

	it('reaches the same board however chunked reveals interleave', async function () {
		// The order-independence property, at the resolution chunking introduces:
		// two players now produce FOUR transactions, and the mempool may deliver
		// them interleaved. Nothing about the board may depend on that.
		async function boardAfter(
			order: 'blocked' | 'interleaved',
		): Promise<string[]> {
			const fixtures = await networkHelpers.loadFixture(deployAll);
			const {
				env,
				Game,
				GameAvatarSale,
				actionsPerReveal,
				unnamedAccounts,
				advanceToCycleNumber,
				advanceToRevealPhase,
				getCycleNumber,
				getTimestamp,
			} = fixtures;

			const playerA = unnamedAccounts[0];
			const playerB = unnamedAccounts[1];
			const {cycleNumber: startCycleNumber} = getCycleNumber(
				await getTimestamp(),
			);
			await advanceToCycleNumber(startCycleNumber + 2, true);

			const identityA = await enterGame({env, Game, GameAvatarSale}, playerA);
			const identityB = await enterGame({env, Game, GameAvatarSale}, playerB);

			// Overlapping turns, both longer than one transaction, so the shared
			// cells are claimed by different chunks of different turns.
			const turnA = row(6, 27);
			const turnB = [...row(3, 27), ...row(3, 28)];
			const chainA = commitmentChain(turnA, SECRET_A, actionsPerReveal);
			const chainB = commitmentChain(turnB, SECRET_B, actionsPerReveal);

			for (const [account, identity, head] of [
				[playerA, identityA, chainA.head],
				[playerB, identityB, chainB.head],
			] as const) {
				await env.execute(Game, {
					account,
					functionName: 'makeCommitment',
					args: [identity, head, 0n, zeroAddress],
				});
			}

			const {cycleNumber} = getCycleNumber(await getTimestamp());
			await advanceToRevealPhase(cycleNumber, true);

			const a = (i: number) =>
				env.execute(Game, {
					account: playerA,
					functionName: 'reveal',
					args: [
						identityA,
						chainA.chunks[i].placements,
						SECRET_A,
						chainA.chunks[i].furtherActions,
						zeroAddress,
					],
				});
			const b = (i: number) =>
				env.execute(Game, {
					account: playerB,
					functionName: 'reveal',
					args: [
						identityB,
						chainB.chunks[i].placements,
						SECRET_B,
						chainB.chunks[i].furtherActions,
						zeroAddress,
					],
				});

			if (order === 'blocked') {
				await a(0);
				await a(1);
				await b(0);
				await b(1);
			} else {
				await b(0);
				await a(0);
				await b(1);
				await a(1);
			}

			// Sorted, because the ORDER of a zone listing may depend on arrival and
			// its CONTENT may not. See the single-chunk version of this test above.
			const listings: string[] = [];
			for (const zone of new Set([...turnA, ...turnB].map(zoneOfCell))) {
				const [cells] = (await env.read(Game, {
					functionName: 'getCellsInZone',
					args: [zone],
				})) as [
					{cellID: bigint; totalStake: bigint; numClaimants: number}[],
					bigint,
				];
				for (const cell of cells) {
					listings.push(
						`${cell.cellID}:${cell.totalStake}:${cell.numClaimants}`,
					);
				}
			}
			return listings.sort();
		}

		const blocked = await boardAfter('blocked');
		const interleaved = await boardAfter('interleaved');

		expect(blocked).toEqual(interleaved);
		// And something actually happened: nine distinct cells, three of them
		// shared by both players.
		expect(blocked.length).toEqual(9);
		expect(blocked.filter((entry) => entry.endsWith(':2')).length).toEqual(3);
	});

	it('chunks to whatever the DEPLOYMENT says, not to a number in the code', async function () {
		// The parameter is what keeps a client and a contract agreeing about how a
		// turn is cut up, so this changes it and watches the rule follow. A test
		// that spelled the number out would go on passing while the deployment
		// said something else, which is the exact failure the parameter exists to
		// make impossible.
		const fixtures = await networkHelpers.loadFixture(deployAll);
		const {env, unnamedAccounts} = fixtures;

		const Game = await deployGameWith(fixtures, {
			name: 'Game_chunk_of_two',
			cyclePolicy: CYCLE_POLICY.Manual,
			commitPhaseDuration: 0n,
			revealPhaseDuration: 0n,
			actionsPerReveal: 2n,
		});

		const config = (await env.read(Game, {functionName: 'getConfig'})) as {
			actionsPerReveal: bigint;
		};
		expect(config.actionsPerReveal).toEqual(2n);

		const player = unnamedAccounts[0];
		const identity = await enterGame({...fixtures, Game}, player);

		const turn = row(3, 29);
		// Cut for THIS game rather than for the shipped one: three actions at two
		// per reveal is two chunks, where at four per reveal it would be one.
		const {chunks} = commitmentChain(turn, SECRET_A, 2);
		expect(chunks.length).toEqual(2);

		await env.execute(Game, {
			account: player,
			functionName: 'makeCommitment',
			args: [identity, commitmentHashFor(turn, SECRET_A, 2), 0n, zeroAddress],
		});
		await env.execute(Game, {
			account: player,
			functionName: 'advanceCycle',
			args: [],
		});

		// A client that had kept the SHIPPED game's chunk size would build one
		// chunk of three and be refused here, after the stake was already bonded.
		await expect(
			env.execute(Game, {
				account: player,
				functionName: 'reveal',
				args: [identity, turn, SECRET_A, NO_FURTHER_ACTIONS, zeroAddress],
				gas: 1000000n,
			}),
		).toBeRejectedWith(`custom error 'TooManyActions(`);

		for (const chunk of chunks) {
			await env.execute(Game, {
				account: player,
				functionName: 'reveal',
				args: [
					identity,
					chunk.placements,
					SECRET_A,
					chunk.furtherActions,
					zeroAddress,
				],
			});
		}

		for (const placement of turn) {
			// Claimed rather than staked on: a placement costs nothing here, so the
			// total stake stays zero however much of the turn has landed. See
			// `claimantsOn` in the fixture above.
			const cell = (await env.read(Game, {
				functionName: 'getCell',
				args: [placement.cellID],
			})) as {numClaimants: number};
			expect(cell.numClaimants).toEqual(1);
		}
	});

	it('refuses a deployment whose turns could never be revealed', async function () {
		// Same class as a zero phase duration and refused in the same place. A
		// chunk of zero makes every reveal revert, so every commitment is made and
		// none can be opened: the cost is the first player's stake rather than a
		// revert anybody reads.
		const fixtures = await networkHelpers.loadFixture(deployAll);

		await expect(
			deployGameWith(fixtures, {
				name: 'Game_chunk_of_none',
				cyclePolicy: CYCLE_POLICY.Timed,
				commitPhaseDuration: 30n,
				revealPhaseDuration: 10n,
				actionsPerReveal: 0n,
			}),
		).toBeRejected();
	});
});

/**
 * Playing without holding the stake.
 *
 * A player's moves are sent by a key their browser generated, which they never
 * see and which holds nothing. That key must be able to COMMIT, because a
 * wallet prompt twice a cycle is not a game, and it must not be able to take
 * the money, because it is one cleared site away from being gone and anything
 * that gets hold of it has whatever authority it was given.
 *
 * So the account is the player and the key merely acts for it. These tests pin
 * both halves: what the delegate may do, and what it may not.
 */
describe('Game delegation', function () {
	it("lets an authorised key commit for the account's AVATAR", async function () {
		const {
			env,
			Game,
			GameAvatarSale,
			actionsPerReveal,
			unnamedAccounts,
			advanceToCycleNumber,
			getCycleNumber,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const account = unnamedAccounts[0];
		// Stands in for the browser's local signer: it holds no tokens and has no
		// reserve of its own, which is the whole point.
		const signer = unnamedAccounts[1];
		const {cycleNumber: startCycleNumber} = getCycleNumber(
			await getTimestamp(),
		);
		await advanceToCycleNumber(startCycleNumber + 2, true);

		const identity = await enterGame({env, Game, GameAvatarSale}, account);

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
				identity,
				commitmentHashFor(placements, SECRET_A, actionsPerReveal),
				0n,
				zeroAddress,
			],
		});

		// The commitment is the AVATAR'S, not the sender's. If it were filed
		// under the signer, losing the browser would lose the submission - and here
		// it could not be filed there at all, because the signer owns no avatar,
		// which is the identity model doing the same work the reserve did.
		const commitment = (await env.read(Game, {
			functionName: 'getCommitment',
			args: [identity],
		})) as {hash: `0x${string}`; cycleNumber: bigint};
		expect(commitment.cycleNumber > 0n).toEqual(true);

		// And the signer is not a player at all: `idOf` is the identity an
		// address game would have given it, and nothing here answers to it.
		const signerCommitment = (await env.read(Game, {
			functionName: 'getCommitment',
			args: [idOf(signer)],
		})) as {hash: `0x${string}`; cycleNumber: bigint};
		expect(signerCommitment.cycleNumber).toEqual(0n);
	});

	it('refuses a key the account never authorised', async function () {
		const {
			env,
			Game,
			GameAvatarSale,
			actionsPerReveal,
			unnamedAccounts,
			advanceToCycleNumber,
			getCycleNumber,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const account = unnamedAccounts[0];
		const stranger = unnamedAccounts[2];
		const {cycleNumber: startCycleNumber} = getCycleNumber(
			await getTimestamp(),
		);
		await advanceToCycleNumber(startCycleNumber + 2, true);

		const identity = await enterGame({env, Game, GameAvatarSale}, account);

		// Without the check this succeeds, and that is the theft: a stranger bonds
		// someone else's reserve to a commitment only they know the secret for, so
		// it can never be revealed and the bond is simply lost.
		await expect(
			env.execute(Game, {
				account: stranger,
				functionName: 'makeCommitment',
				args: [
					identity,
					commitmentHashFor(
						[{cellID: cellAt(1, 1)}],
						SECRET_A,
						actionsPerReveal,
					),
					0n,
					zeroAddress,
				],
			}),
		).toBeRejected();

		const commitment = (await env.read(Game, {
			functionName: 'getCommitment',
			args: [identity],
		})) as {bond: bigint};
		expect(commitment.bond).toEqual(0n);
	});

	it('refuses a player of zero rather than reading it as the caller', async function () {
		// THE SHORTHAND `main` HAS AND THIS BRANCH MUST NOT. Upstream, a player of
		// zero means "commit as whoever is calling", because there an identity is
		// an account and zero is not one. Here zero is a token id like any other,
		// so letting it mean the caller would make one avatar behave unlike every
		// other avatar - and it would do so silently, on the one id a fresh
		// counter is most likely to hand out.
		//
		// Refused twice over, deliberately: `GameAvatarSale` allocates from 1, and
		// `_playerOf` rejects an undeposited id anyway. Two independent reasons
		// is what a silent aliasing bug is worth.
		const {
			env,
			Game,
			GameAvatarSale,
			actionsPerReveal,
			unnamedAccounts,
			advanceToCycleNumber,
			getCycleNumber,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const account = unnamedAccounts[0];
		const {cycleNumber: startCycleNumber} = getCycleNumber(
			await getTimestamp(),
		);
		await advanceToCycleNumber(startCycleNumber + 2, true);

		const identity = await enterGame({env, Game, GameAvatarSale}, account);

		await expect(
			env.execute(Game, {
				account,
				functionName: 'makeCommitment',
				args: [
					0n,
					commitmentHashFor(
						[{cellID: cellAt(9, 9)}],
						SECRET_A,
						actionsPerReveal,
					),
					0n,
					zeroAddress,
				],
				gas: 1000000n,
			}),
		).toBeRejectedWith(`custom error 'InvalidPlayer(`);

		// The avatar this account really does own is untouched.
		const commitment = (await env.read(Game, {
			functionName: 'getCommitment',
			args: [identity],
		})) as {cycleNumber: bigint};
		expect(commitment.cycleNumber).toEqual(0n);
	});

	it('refuses an identity nobody has put at stake', async function () {
		// THE SAME TEST NAME'S JOB, ANSWERED DIFFERENTLY. Upstream this is an
		// aliasing guard: an identity has to BE an account there, and an id above
		// 2^160 would truncate onto somebody else's. Here any id is well-formed
		// and the question is instead whether the avatar is in custody, which is
		// what makes it a player at all.
		//
		// The id used is deliberately one an address game would have accepted
		// (`account` widened, plus the aliasing offset), so the assertion is
		// about custody rather than about arithmetic.
		//
		// It is checked at the one place authority is granted, which is why a
		// reveal needs no such check: it opens a commitment that only a checked
		// call could ever have made.
		const {
			env,
			Game,
			GameAvatarSale,
			actionsPerReveal,
			unnamedAccounts,
			advanceToCycleNumber,
			getCycleNumber,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const account = unnamedAccounts[0];
		const {cycleNumber: startCycleNumber} = getCycleNumber(
			await getTimestamp(),
		);
		await advanceToCycleNumber(startCycleNumber + 2, true);

		const identity = await enterGame({env, Game, GameAvatarSale}, account);

		const aliased = idOf(account) + (1n << 160n);
		await expect(
			env.execute(Game, {
				account,
				functionName: 'makeCommitment',
				args: [
					aliased,
					commitmentHashFor(
						[{cellID: cellAt(2, 2)}],
						SECRET_A,
						actionsPerReveal,
					),
					0n,
					zeroAddress,
				],
				gas: 1000000n,
			}),
		).toBeRejectedWith(`custom error 'InvalidPlayer(`);

		// And the account it would have aliased onto is untouched.
		const commitment = (await env.read(Game, {
			functionName: 'getCommitment',
			args: [identity],
		})) as {bond: bigint};
		expect(commitment.bond).toEqual(0n);
	});

	it('never lets the delegate take the avatar out', async function () {
		// THE LINE THAT MAKES A DISPOSABLE KEY SAFE TO HOLD, and this branch has
		// to draw it in a different place from `main`. There the delegate may
		// spend the reserve on playing and may never withdraw it; here the
		// equivalent is that it may play the avatar and may never take it out of
		// custody, because taking it out ends the stake.
		//
		// `withdrawAvatar` checks `msg.sender` against the recorded owner rather
		// than going through `_playerOf`, which is exactly what makes this true:
		// authority to PLAY is delegable and authority to LEAVE is not.
		const {
			env,
			Game,
			GameAvatarSale,
			actionsPerReveal,
			unnamedAccounts,
			advanceToCycleNumber,
			getCycleNumber,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const account = unnamedAccounts[0];
		const signer = unnamedAccounts[1];
		const {cycleNumber: startCycleNumber} = getCycleNumber(
			await getTimestamp(),
		);
		await advanceToCycleNumber(startCycleNumber + 2, true);

		const identity = await enterGame({env, Game, GameAvatarSale}, account);
		await env.execute(Game, {
			account,
			functionName: 'registerDelegate',
			args: [signer, zeroAddress],
		});

		await expect(
			env.execute(Game, {
				account: signer,
				functionName: 'withdrawAvatar',
				args: [identity, signer],
				gas: 1000000n,
			}),
		).toBeRejectedWith(`custom error 'NotAvatarOwner(`);

		expect(await avatarOwner(env, Game, identity)).toEqual(account);
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
