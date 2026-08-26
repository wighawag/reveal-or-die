import {expect} from 'earl';
import {describe, it} from 'node:test'; // using node:test as hardhat v3 do not support vitest
import {network} from 'hardhat';
import {setupFixtures} from './utils/index.js';
import {zoneID} from '../../js/zones.js';
import {
	decodeEventLog,
	encodeAbiParameters,
	keccak256,
	zeroAddress,
} from 'viem';

const {provider, networkHelpers, viem} = await network.connect();
const {deployAll} = setupFixtures(provider);

type Action = {actionType: number; data: bigint};

/** A packed board position, as the contract stores it: `y << 32 | x`. */
const pos = (x: bigint, y: bigint) => (y << 32n) | x;

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
				// The mint-to-game payload is just the OWNER now. There is no
				// controller to name: who may play is delegation, account-wide,
				// granted by the owner's signature rather than at deposit time.
				encodeAbiParameters([{type: 'address'}], [unnamedAccounts[0]]),
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

		// A Move's `data` is an ABSOLUTE packed position (y << 32 | x), not a
		// direction and not a distance, and _isValidMove only accepts a target
		// that is ORTHOGONALLY ADJACENT to where the avatar currently is and is
		// not an obstacle. A rejected move sets stopProcessing, so the rest of
		// the actions in the same reveal are dropped too.
		//
		// The avatar entered at (0,0). Zones are centred (ZONE_OFFSET 8), so
		// (0,0) is local (8,8) of the single generated area, which is an 'x'
		// obstacle - _enter does not check the destination (`TODO check valid
		// entry`), so an avatar can stand inside a wall. Of its four
		// neighbours, only (0,1) is free.
		const moveActions: Action[] = [
			{actionType: 1, data: pos(0n, 1n)},
			{actionType: 1, data: pos(0n, 2n)},
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

		expect(after_avatars[0][0].position).toEqual(pos(0n, 2n));
		// console.log(after_avatars);
	});

	it('lets a delegate play, and only after the owner says so', async function () {
		const {env, Game, AvatarsSale, unnamedAccounts, advanceToEpoch, getEpoch, getTimestamp} =
			await networkHelpers.loadFixture(deployAll);

		const owner = unnamedAccounts[0];
		const delegate = unnamedAccounts[1];

		const {epoch: initialEpoch} = getEpoch(await getTimestamp());
		const subID = 0n;
		const avatarID = (BigInt(owner) << 96n) + subID;

		await env.execute(AvatarsSale, {
			account: owner,
			functionName: 'purchase',
			args: [
				Game.address,
				subID,
				encodeAbiParameters([{type: 'address'}], [owner]),
				zeroAddress,
				0n,
				zeroAddress,
			],
			value: BigInt(AvatarsSale.linkedData!.paymentAmount as string),
		});

		await advanceToEpoch(initialEpoch + 2);

		const secret =
			'0x0000000000000000000000000000000000000000000000000000000000000000';
		const actions: Action[] = [{actionType: 0, data: 0n}];
		const hash = commitmentHash(secret, actions);

		// A stranger cannot move someone else's avatar. This is the whole point
		// of the check: without it, anyone could commit on an avatar they do not
		// own and strand it with a commitment only they can reveal.
		let rejection = '';
		try {
			await env.execute(Game, {
				account: delegate,
				functionName: 'commit',
				args: [avatarID, hash, zeroAddress],
			});
		} catch (e) {
			rejection = String(e);
		}
		// the REASON matters: any thrown error would satisfy a bare `threw`
		// check, including one caused by getting the arguments wrong, which
		// would leave this asserting nothing at all.
		expect(rejection.includes('NotDelegate')).toEqual(true);

		// The owner authorises the delegate. Note what is NOT passed: no avatar
		// id. Authority is ACCOUNT-WIDE, so this one grant covers every avatar
		// this owner holds, now and later.
		await env.execute(Game, {
			account: owner,
			functionName: 'registerDelegate',
			args: [delegate, zeroAddress],
		});

		// It is recorded on the PROXY, which is also what proves the Delegation
		// route is actually routed - a missing route would fail here rather than
		// at some later, stranger point.
		const status = await env.read(Game, {
			functionName: 'delegationStatus',
			args: [owner, delegate],
		});
		expect(status[0]).toEqual(true);

		// and now the same call the stranger could not make.
		await env.execute(Game, {
			account: delegate,
			functionName: 'commit',
			args: [avatarID, hash, zeroAddress],
		});

		const commitment = await env.read(Game, {
			functionName: 'getCommitment',
			args: [avatarID],
		});
		expect(commitment.hash).toEqual(hash);
	});

	/**
	 * The property that makes commit-reveal worth doing.
	 *
	 * Reveals arrive in whatever order the mempool delivers them, so the board
	 * after a set of commitments must not depend on that order. If it does,
	 * whoever pays the most gas decides the outcome and committing bought
	 * nothing.
	 *
	 * It is easy to break by accident. "The first to arrive takes the cell" and
	 * "reject a cell that is already occupied" both read as reasonable movement
	 * rules and both violate this. Today _isValidMove consults only walls and
	 * adjacency, never another avatar, which is why two avatars may share a
	 * cell; that is the property, not an oversight, so it is asserted rather
	 * than trusted to survive the next rule change.
	 *
	 * The zone listing is compared as a SET on purpose. _addToZone appends to a
	 * per-zone array, so the ORDER of that array does depend on which reveal
	 * landed first. What must not differ is its membership, or any avatar's
	 * position.
	 */
	it('reaches the same board whichever order the reveals arrive in', async function () {
		async function boardAfterRevealsInOrder(revealFirst: 'A' | 'B') {
			const {
				env,
				Game,
				AvatarsSale,
				unnamedAccounts,
				advanceToEpoch,
				advanceToRevealPhase,
				getEpoch,
				getTimestamp,
			} = await networkHelpers.loadFixture(deployAll);

			const playerA = unnamedAccounts[0];
			const playerB = unnamedAccounts[1];
			const avatarA = (BigInt(playerA) << 96n) + 0n;
			const avatarB = (BigInt(playerB) << 96n) + 0n;
			const secretA =
				'0x00000000000000000000000000000000000000000000000000000000000000aa' as const;
			const secretB =
				'0x00000000000000000000000000000000000000000000000000000000000000bb' as const;

			for (const player of [playerA, playerB]) {
				await env.execute(AvatarsSale, {
					account: player,
					functionName: 'purchase',
					args: [
						Game.address,
						0n,
						encodeAbiParameters([{type: 'address'}], [player]),
						zeroAddress,
						0n,
						zeroAddress,
					],
					value: BigInt(AvatarsSale.linkedData!.paymentAmount as string),
				});
			}

			const order: ('A' | 'B')[] =
				revealFirst === 'A' ? ['A', 'B'] : ['B', 'A'];
			const account = {A: playerA, B: playerB};
			const avatar = {A: avatarA, B: avatarB};
			const secret = {A: secretA, B: secretB};

			async function round(
				epoch: number,
				actions: {A: Action[]; B: Action[]},
			) {
				await advanceToEpoch(epoch);
				for (const who of ['A', 'B'] as const) {
					await env.execute(Game, {
						account: account[who],
						functionName: 'commit',
						args: [
							avatar[who],
							commitmentHash(secret[who], actions[who]),
							zeroAddress,
						],
					});
				}
				await advanceToRevealPhase(epoch);
				for (const who of order) {
					await env.execute(Game, {
						account: account[who],
						functionName: 'reveal',
						args: [avatar[who], actions[who], secret[who], zeroAddress],
					});
				}
			}

			const {epoch: start} = getEpoch(await getTimestamp());

			// They enter either side of the cell they will contest. (0,1), (0,2)
			// and (0,3) are all walkable in the single generated area; (0,0) is
			// not, which is why nobody starts there.
			await round(start + 2, {
				A: [{actionType: 0, data: pos(0n, 1n)}],
				B: [{actionType: 0, data: pos(0n, 3n)}],
			});

			// and now both step onto the SAME cell, blind to each other.
			await round(start + 3, {
				A: [{actionType: 1, data: pos(0n, 2n)}],
				B: [{actionType: 1, data: pos(0n, 2n)}],
			});

			const [a, b] = [
				await env.read(Game, {functionName: 'getAvatar', args: [avatarA]}),
				await env.read(Game, {functionName: 'getAvatar', args: [avatarB]}),
			];
			const inZone = await env.read(Game, {
				functionName: 'getAvatarsInZone',
				args: [0n, 0n, 100n],
			});

			return {
				positionA: a.position,
				positionB: b.position,
				lifeA: a.life,
				lifeB: b.life,
				listed: inZone[0]
					.map((x: {avatarID: bigint}) => x.avatarID.toString())
					.sort(),
			};
		}

		const aFirst = await boardAfterRevealsInOrder('A');
		const bFirst = await boardAfterRevealsInOrder('B');

		// the contest actually happened: both are on the cell they both asked for
		expect(aFirst.positionA).toEqual(pos(0n, 2n));
		expect(aFirst.positionB).toEqual(pos(0n, 2n));

		expect(bFirst.positionA).toEqual(aFirst.positionA);
		expect(bFirst.positionB).toEqual(aFirst.positionB);
		expect(bFirst.lifeA).toEqual(aFirst.lifeA);
		expect(bFirst.lifeB).toEqual(aFirst.lifeB);
		expect(bFirst.listed).toEqual(aFirst.listed);
	});

	/**
	 * The JS zone encoding must agree with PositionUtils.getZone, including west
	 * and north of the origin.
	 *
	 * Solidity packs the zone as `(uint32(zoneY) << 32) + uint32(zoneX)`, and
	 * casting a negative int32 is two's complement, so zone -1 is 0xFFFFFFFF
	 * rather than -1. A JS helper that treats it as a signed number agrees with
	 * the contract for every positive coordinate and disagrees for every
	 * negative one, which means the board looks correct until a player walks off
	 * the origin zone and then goes silently empty.
	 *
	 * Asserted against the chain rather than against a hand-computed constant,
	 * because a constant would only prove the helper matches whatever I believed
	 * when writing it.
	 */
	it('computes the same zone id as the contract, west of the origin', async function () {
		const {env, Game, AvatarsSale, unnamedAccounts, advanceToEpoch, advanceToRevealPhase, getEpoch, getTimestamp} =
			await networkHelpers.loadFixture(deployAll);

		const player = unnamedAccounts[0];
		const avatarID = (BigInt(player) << 96n) + 0n;
		await env.execute(AvatarsSale, {
			account: player,
			functionName: 'purchase',
			args: [Game.address, 0n, encodeAbiParameters([{type: 'address'}], [player]), zeroAddress, 0n, zeroAddress],
			value: BigInt(AvatarsSale.linkedData!.paymentAmount as string),
		});

		// far enough west and north to land outside the origin zone, which is
		// what makes both packed halves negative
		const entryX = -20;
		const entryY = -20;
		const entry = (BigInt.asUintN(32, BigInt(entryY)) << 32n) |
			BigInt.asUintN(32, BigInt(entryX));

		const {epoch: start} = getEpoch(await getTimestamp());
		const secret = '0x00000000000000000000000000000000000000000000000000000000000000cc' as const;
		const actions: Action[] = [{actionType: 0, data: entry}];

		await advanceToEpoch(start + 2);
		await env.execute(Game, {
			account: player,
			functionName: 'commit',
			args: [avatarID, commitmentHash(secret, actions), zeroAddress],
		});
		await advanceToRevealPhase(start + 2);
		await env.execute(Game, {
			account: player,
			functionName: 'reveal',
			args: [avatarID, actions, secret, zeroAddress],
		});

		const listed = await env.read(Game, {
			functionName: 'getAvatarsInZone',
			args: [zoneID(entryX, entryY), 0n, 100n],
		});
		expect(listed[0].map((a: {avatarID: bigint}) => a.avatarID)).toEqual([
			avatarID,
		]);

		// and it is NOT in the origin zone, which is what a signed-number helper
		// would have produced
		const origin = await env.read(Game, {
			functionName: 'getAvatarsInZone',
			args: [zoneID(0, 0), 0n, 100n],
		});
		expect(origin[0].length).toEqual(0);
	});
});
