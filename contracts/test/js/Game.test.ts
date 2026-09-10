import {expect} from 'earl';
import {describe, it} from 'node:test'; // using node:test as hardhat v3 do not support vitest
import {network} from 'hardhat';
import {setupFixtures, idOf, enterGame, avatarOwner} from './utils/index.js';
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
			AvatarSale,
			unnamedAccounts,
			advanceToEpoch,
			advanceToRevealPhase,
			getEpoch,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const player = unnamedAccounts[0];
		const {epoch: startEpoch} = getEpoch(await getTimestamp());
		await advanceToEpoch(startEpoch + 2, true);

		// Buy an avatar, which puts it at stake in the same transaction.
		const identity = await enterGame({env, Game, AvatarSale}, player);

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
			args: [identity, commitmentHash(placements, SECRET_A), 0n, zeroAddress],
		});

		// Reveal.
		const {epoch} = getEpoch(await getTimestamp());
		await advanceToRevealPhase(epoch, true);
		await env.execute(Game, {
			account: player,
			functionName: 'reveal',
			args: [identity, placements, SECRET_A, zeroAddress],
		});

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
	 */
	it('reaches the same board whichever order the reveals arrive in', async function () {
		async function boardAfterRevealsInOrder(revealFirst: 'A' | 'B'): Promise<{
			contested: {totalStake: bigint; numClaimants: number};
			listed: string[];
		}> {
			const {
				env,
				Game,
				AvatarSale,
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

			const identityA = await enterGame({env, Game, AvatarSale}, playerA);
			const identityB = await enterGame({env, Game, AvatarSale}, playerB);

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
					commitmentHash(placementsA, SECRET_A),
					0n,
					zeroAddress,
				],
			});
			await env.execute(Game, {
				account: playerB,
				functionName: 'makeCommitment',
				args: [
					identityB,
					commitmentHash(placementsB, SECRET_B),
					0n,
					zeroAddress,
				],
			});

			const {epoch} = getEpoch(await getTimestamp());
			await advanceToRevealPhase(epoch, true);

			const revealA = () =>
				env.execute(Game, {
					account: playerA,
					functionName: 'reveal',
					args: [identityA, placementsA, SECRET_A, zeroAddress],
				});
			const revealB = () =>
				env.execute(Game, {
					account: playerB,
					functionName: 'reveal',
					args: [identityB, placementsB, SECRET_B, zeroAddress],
				});

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

		const aFirst = await boardAfterRevealsInOrder('A');
		const bFirst = await boardAfterRevealsInOrder('B');

		// Same final board either way: the cell is shared, not won.
		expect(aFirst.contested.totalStake).toEqual(bFirst.contested.totalStake);
		expect(aFirst.contested.numClaimants).toEqual(
			bFirst.contested.numClaimants,
		);

		// And it really is shared, rather than both reveals failing.
		expect(aFirst.contested.numClaimants).toEqual(2);
		expect(aFirst.contested.totalStake).toEqual(0n);

		// The board a client READS is the same board too. This is a separate
		// claim from the one above: the cells are listed out of a per-zone index
		// that reveals append to, so an index that indexed only what the first
		// reveal saw, or that indexed a cell twice, would leave the stakes
		// identical and still show two different boards.
		expect(aFirst.listed).toEqual(bFirst.listed);
		expect(aFirst.listed.length).toEqual(3);
	});

	it('seizes the avatar of a player who never reveals', async function () {
		const {
			env,
			Game,
			AvatarSale,
			unnamedAccounts,
			advanceToEpoch,
			getEpoch,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const player = unnamedAccounts[0];
		const {epoch: startEpoch} = getEpoch(await getTimestamp());
		await advanceToEpoch(startEpoch + 2, true);

		const identity = await enterGame({env, Game, AvatarSale}, player);

		const placements: Placement[] = [{cellID: cellAt(1, 1)}];
		await env.execute(Game, {
			account: player,
			functionName: 'makeCommitment',
			args: [identity, commitmentHash(placements, SECRET_A), 0n, zeroAddress],
		});

		// Let the epoch pass without revealing.
		const {epoch} = getEpoch(await getTimestamp());
		await advanceToEpoch(epoch + 1, true);

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
			AvatarSale,
			unnamedAccounts,
			advanceToEpoch,
			getEpoch,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const player = unnamedAccounts[0];
		const {epoch: startEpoch} = getEpoch(await getTimestamp());
		await advanceToEpoch(startEpoch + 2, true);

		const identity = await enterGame({env, Game, AvatarSale}, player);

		// Nothing committed yet, so leaving is allowed - and it really leaves.
		const second = await enterGame({env, Game, AvatarSale}, player);
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
				commitmentHash([{cellID: cellAt(4, 4)}], SECRET_A),
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
		const {epoch} = getEpoch(await getTimestamp());
		await advanceToEpoch(epoch + 1, true);
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
			AvatarSale,
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

		const identity = await enterGame({env, Game, AvatarSale}, player, {
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
				})) as {epoch: bigint}
			).epoch,
		).toEqual(0n);

		// And the player, who never held a token, can now play on it.
		const placements: Placement[] = [{cellID: cellAt(5, 5)}];
		await env.execute(Game, {
			account: player,
			functionName: 'makeCommitment',
			args: [identity, commitmentHash(placements, SECRET_A), 0n, zeroAddress],
		});

		const {epoch} = getEpoch(await getTimestamp());
		await advanceToRevealPhase(epoch, true);
		await env.execute(Game, {
			account: player,
			functionName: 'reveal',
			args: [identity, placements, SECRET_A, zeroAddress],
		});

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
			AvatarSale,
			unnamedAccounts,
			advanceToEpoch,
			advanceToRevealPhase,
			getEpoch,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const player = unnamedAccounts[0];
		const {epoch: startEpoch} = getEpoch(await getTimestamp());
		await advanceToEpoch(startEpoch + 2, true);

		const identity = await enterGame({env, Game, AvatarSale}, player);

		// Two cells inside zone 0 (which spans -8..7 on both axes).
		const placements: Placement[] = [
			{cellID: cellAt(0, 0)},
			{cellID: cellAt(2, -3)},
		];
		await env.execute(Game, {
			account: player,
			functionName: 'makeCommitment',
			args: [identity, commitmentHash(placements, SECRET_A), 0n, zeroAddress],
		});

		const {epoch} = getEpoch(await getTimestamp());
		await advanceToRevealPhase(epoch, true);
		await env.execute(Game, {
			account: player,
			functionName: 'reveal',
			args: [identity, placements, SECRET_A, zeroAddress],
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
	it("lets an authorised key commit for the account's AVATAR", async function () {
		const {
			env,
			Game,
			AvatarSale,
			unnamedAccounts,
			advanceToEpoch,
			getEpoch,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const account = unnamedAccounts[0];
		// Stands in for the browser's local signer: it holds no tokens and has no
		// reserve of its own, which is the whole point.
		const signer = unnamedAccounts[1];
		const {epoch: startEpoch} = getEpoch(await getTimestamp());
		await advanceToEpoch(startEpoch + 2, true);

		const identity = await enterGame({env, Game, AvatarSale}, account);

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
			args: [identity, commitmentHash(placements, SECRET_A), 0n, zeroAddress],
		});

		// The commitment is the AVATAR'S, not the sender's. If it were filed
		// under the signer, losing the browser would lose the round - and here it
		// could not be filed there at all, because the signer owns no avatar,
		// which is the identity model doing the same work the reserve did.
		const commitment = (await env.read(Game, {
			functionName: 'getCommitment',
			args: [identity],
		})) as {hash: `0x${string}`; epoch: bigint};
		expect(commitment.epoch > 0n).toEqual(true);

		// And the signer is not a player at all: `idOf` is the identity an
		// address game would have given it, and nothing here answers to it.
		const signerCommitment = (await env.read(Game, {
			functionName: 'getCommitment',
			args: [idOf(signer)],
		})) as {hash: `0x${string}`; epoch: bigint};
		expect(signerCommitment.epoch).toEqual(0n);
	});

	it('refuses a key the account never authorised', async function () {
		const {
			env,
			Game,
			AvatarSale,
			unnamedAccounts,
			advanceToEpoch,
			getEpoch,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const account = unnamedAccounts[0];
		const stranger = unnamedAccounts[2];
		const {epoch: startEpoch} = getEpoch(await getTimestamp());
		await advanceToEpoch(startEpoch + 2, true);

		const identity = await enterGame({env, Game, AvatarSale}, account);

		// Without the check this succeeds, and that is the theft: a stranger bonds
		// someone else's reserve to a commitment only they know the secret for, so
		// it can never be revealed and the bond is simply lost.
		await expect(
			env.execute(Game, {
				account: stranger,
				functionName: 'makeCommitment',
				args: [
					identity,
					commitmentHash([{cellID: cellAt(1, 1)}], SECRET_A),
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
		// Refused twice over, deliberately: `AvatarSale` allocates from 1, and
		// `_playerOf` rejects an undeposited id anyway. Two independent reasons
		// is what a silent aliasing bug is worth.
		const {
			env,
			Game,
			AvatarSale,
			unnamedAccounts,
			advanceToEpoch,
			getEpoch,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const account = unnamedAccounts[0];
		const {epoch: startEpoch} = getEpoch(await getTimestamp());
		await advanceToEpoch(startEpoch + 2, true);

		const identity = await enterGame({env, Game, AvatarSale}, account);

		await expect(
			env.execute(Game, {
				account,
				functionName: 'makeCommitment',
				args: [
					0n,
					commitmentHash([{cellID: cellAt(9, 9)}], SECRET_A),
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
		})) as {epoch: bigint};
		expect(commitment.epoch).toEqual(0n);
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
			AvatarSale,
			unnamedAccounts,
			advanceToEpoch,
			getEpoch,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const account = unnamedAccounts[0];
		const {epoch: startEpoch} = getEpoch(await getTimestamp());
		await advanceToEpoch(startEpoch + 2, true);

		const identity = await enterGame({env, Game, AvatarSale}, account);

		const aliased = idOf(account) + (1n << 160n);
		await expect(
			env.execute(Game, {
				account,
				functionName: 'makeCommitment',
				args: [
					aliased,
					commitmentHash([{cellID: cellAt(2, 2)}], SECRET_A),
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
			AvatarSale,
			unnamedAccounts,
			advanceToEpoch,
			getEpoch,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const account = unnamedAccounts[0];
		const signer = unnamedAccounts[1];
		const {epoch: startEpoch} = getEpoch(await getTimestamp());
		await advanceToEpoch(startEpoch + 2, true);

		const identity = await enterGame({env, Game, AvatarSale}, account);
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
