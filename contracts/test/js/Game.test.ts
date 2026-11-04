import {expect} from 'earl';
import {describe, it} from 'node:test'; // using node:test as hardhat v3 do not support vitest
import {network} from 'hardhat';
import {setupFixtures, deployGameWith, CYCLE_POLICY} from './utils/index.js';
import {zoneID, isObstacle, isValidMove} from '../../js/zones.js';
import {commitmentHash, type Action} from '../../js/commitment.js';
import {
	avatarIDFor,
	purchaseArgs,
	purchaseValue,
} from '../../js/avatar-id.js';
import {decodeEventLog, encodeAbiParameters, zeroAddress} from 'viem';

const {provider, networkHelpers, viem} = await network.connect();
const {deployAll} = setupFixtures(provider);

/** A packed board position, as the contract stores it: `y << 32 | x`. */
const pos = (x: bigint, y: bigint) => (y << 32n) | x;

describe('Game', function () {
	it('basic test', async function () {
		const {
			env,
			Game,
			Avatars,
			AvatarsSale,
			unnamedAccounts,
			advanceToCycle,
			advanceToRevealPhase,
			getCycleNumber,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const before_avatars = await env.read(Game, {
			functionName: 'getAvatarsInZone',
			args: [0n, 0n, 100n],
		});

		// console.log(before_avatars);

		const timestamp = await getTimestamp();
		const {cycleNumber: initialCycleNumber, commiting: initialCommiting} =
			getCycleNumber(timestamp);

		const subID = 0n;
		const avatarID = avatarIDFor(unnamedAccounts[0], subID);
		await env.execute(AvatarsSale, {
			account: env.unnamedAccounts[0],
			functionName: 'purchase',
			// The SAME function the app calls (web/src/lib/world/purchase.ts), so
			// this test is what pins the argument order and the mint-to-game
			// payload against a real chain. The payload is just the OWNER: who may
			// play is delegation, account-wide, granted by the owner's signature
			// rather than fixed at deposit time.
			args: purchaseArgs({
				gameAddress: Game.address,
				owner: unnamedAccounts[0],
				subID,
			}),
			value: BigInt(AvatarsSale.linkedData!.paymentAmount as string),
		});

		await advanceToCycle(initialCycleNumber + 2);
		const entrancePosition = 0n;
		const secret =
			'0x0000000000000000000000000000000000000000000000000000000000000000';

		const enterActions: Action[] = [{actionType: 0, data: entrancePosition}];
		await env.execute(Game, {
			account: env.unnamedAccounts[0],
			functionName: 'commit',
			args: [avatarID, commitmentHash(secret, enterActions), zeroAddress],
		});

		await advanceToRevealPhase(initialCycleNumber + 2);

		await env.execute(Game, {
			account: env.unnamedAccounts[0],
			functionName: 'reveal',
			args: [avatarID, enterActions, secret, zeroAddress],
		});

		await advanceToCycle(initialCycleNumber + 3);

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

		await advanceToRevealPhase(initialCycleNumber + 3);

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
		const {
			env,
			Game,
			AvatarsSale,
			unnamedAccounts,
			advanceToCycle,
			getCycleNumber,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const owner = unnamedAccounts[0];
		const delegate = unnamedAccounts[1];

		const {cycleNumber: initialCycleNumber} = getCycleNumber(await getTimestamp());
		const subID = 0n;
		const avatarID = avatarIDFor(owner, subID);

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

		await advanceToCycle(initialCycleNumber + 2);

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
				advanceToCycle,
				advanceToRevealPhase,
				getCycleNumber,
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

			async function round(cycleNumber: number, actions: {A: Action[]; B: Action[]}) {
				await advanceToCycle(cycleNumber);
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
				await advanceToRevealPhase(cycleNumber);
				for (const who of order) {
					await env.execute(Game, {
						account: account[who],
						functionName: 'reveal',
						args: [avatar[who], actions[who], secret[who], zeroAddress],
					});
				}
			}

			const {cycleNumber: start} = getCycleNumber(await getTimestamp());

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
		const {
			env,
			Game,
			AvatarsSale,
			unnamedAccounts,
			advanceToCycle,
			advanceToRevealPhase,
			getCycleNumber,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const player = unnamedAccounts[0];
		const avatarID = avatarIDFor(player, 0n);
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

		// far enough west and north to land outside the origin zone, which is
		// what makes both packed halves negative
		const entryX = -20;
		const entryY = -20;
		const entry =
			(BigInt.asUintN(32, BigInt(entryY)) << 32n) |
			BigInt.asUintN(32, BigInt(entryX));

		const {cycleNumber: start} = getCycleNumber(await getTimestamp());
		const secret =
			'0x00000000000000000000000000000000000000000000000000000000000000cc' as const;
		const actions: Action[] = [{actionType: 0, data: entry}];

		await advanceToCycle(start + 2);
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

	/**
	 * The client's walkability check must agree with the contract's.
	 *
	 * It matters more than it looks. `_isValidMove` refusing a move sets
	 * `stopProcessing`, which DROPS every remaining action in the same reveal, so
	 * one unwalkable step planned by mistake silently discards the rest of the
	 * turn and says nothing. The client refuses to plan such a step, and that
	 * refusal is only as good as this agreement.
	 *
	 * Asserted by having the CHAIN judge the same moves, rather than against
	 * hand-computed constants.
	 */
	it('agrees with the contract about what can be stood on', async function () {
		const {
			env,
			Game,
			AvatarsSale,
			unnamedAccounts,
			advanceToCycle,
			advanceToRevealPhase,
			getCycleNumber,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const player = unnamedAccounts[0];
		const avatarID = avatarIDFor(player, 0n);
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

		// what the js believes about the cells around the origin
		expect(isObstacle(0, 0)).toEqual(true);
		expect(isObstacle(0, 1)).toEqual(false);
		expect(isValidMove({x: 0, y: 1}, {x: 0, y: 2})).toEqual(true);
		expect(isValidMove({x: 0, y: 1}, {x: 1, y: 0})).toEqual(false); // diagonal
		expect(isValidMove({x: 0, y: 1}, {x: 0, y: 0})).toEqual(false); // obstacle

		const secret =
			'0x00000000000000000000000000000000000000000000000000000000000000dd' as const;
		const {cycleNumber: start} = getCycleNumber(await getTimestamp());

		async function round(cycleNumber: number, actions: Action[]) {
			await advanceToCycle(cycleNumber);
			await env.execute(Game, {
				account: player,
				functionName: 'commit',
				args: [avatarID, commitmentHash(secret, actions), zeroAddress],
			});
			await advanceToRevealPhase(cycleNumber);
			await env.execute(Game, {
				account: player,
				functionName: 'reveal',
				args: [avatarID, actions, secret, zeroAddress],
			});
			const a = await env.read(Game, {
				functionName: 'getAvatar',
				args: [avatarID],
			});
			return a.position;
		}

		// enter at (0,1), which the js says is walkable
		await round(start + 2, [{actionType: 0, data: pos(0n, 1n)}]);

		// the chain accepts the step the js calls valid
		expect(
			await round(start + 3, [{actionType: 1, data: pos(0n, 2n)}]),
		).toEqual(pos(0n, 2n));

		// and refuses the one it calls invalid: (0,1) -> (0,0) is an obstacle, so
		// the avatar does not move
		expect(
			await round(start + 4, [
				{actionType: 1, data: pos(0n, 1n)},
				{actionType: 1, data: pos(0n, 0n)},
			]),
		).toEqual(pos(0n, 1n));
	});

	it('only lets an avatar leave from the exit tile', async function () {
		/**
		 * The exit tile has been drawn on the map since before anything checked
		 * for one: `_exit` ignored its action data entirely and set `left`
		 * unconditionally, so leaving worked from any cell and the one goal on the
		 * board was decoration. Both halves are asserted here, because a check
		 * that only ever refuses is as broken as one that only ever allows.
		 *
		 * `!` is at (3,5) in the single generated area, which is also what
		 * `cellTypeAt` says in js/zones.ts - the same agreement between the two
		 * implementations that the test above pins for obstacles.
		 */
		const {
			env,
			Game,
			AvatarsSale,
			unnamedAccounts,
			advanceToCycle,
			advanceToRevealPhase,
			getCycleNumber,
			getTimestamp,
		} = await networkHelpers.loadFixture(deployAll);

		const player = unnamedAccounts[0];
		const secret =
			'0x00000000000000000000000000000000000000000000000000000000000000ee' as const;

		async function buy(subID: bigint) {
			await env.execute(AvatarsSale, {
				account: player,
				functionName: 'purchase',
				args: purchaseArgs({
					gameAddress: Game.address,
					owner: player,
					subID,
				}),
				value: BigInt(AvatarsSale.linkedData!.paymentAmount as string),
			});
			return avatarIDFor(player, subID);
		}

		const commit = (avatarID: bigint, actions: Action[]) =>
			env.execute(Game, {
				account: player,
				functionName: 'commit',
				args: [avatarID, commitmentHash(secret, actions), zeroAddress],
			});
		const reveal = (avatarID: bigint, actions: Action[]) =>
			env.execute(Game, {
				account: player,
				functionName: 'reveal',
				args: [avatarID, actions, secret, zeroAddress],
			});
		const avatar = (avatarID: bigint) =>
			env.read(Game, {functionName: 'getAvatar', args: [avatarID]});

		const onTheExit = await buy(0n);
		const onTheFloor = await buy(1n);
		const {cycleNumber: start} = getCycleNumber(await getTimestamp());

		// `_enter` checks nothing, so both can be put exactly where they are
		// wanted: one standing on the exit, one on plain floor. Both in ONE cycle,
		// because a commitment can only be made in the commit phase and the first
		// avatar's reveal has already taken the cycle into the second half.
		const enterExit: Action[] = [{actionType: 0, data: pos(3n, 5n)}];
		const enterFloor: Action[] = [{actionType: 0, data: pos(0n, 1n)}];
		await advanceToCycle(start + 2);
		await commit(onTheExit, enterExit);
		await commit(onTheFloor, enterFloor);
		await advanceToRevealPhase(start + 2);
		await reveal(onTheExit, enterExit);
		await reveal(onTheFloor, enterFloor);

		// Both try to leave in the same cycle, from the two kinds of cell.
		const leaveExit: Action[] = [{actionType: 2, data: pos(3n, 5n)}];
		const leaveFloor: Action[] = [{actionType: 2, data: pos(0n, 1n)}];
		await advanceToCycle(start + 3);
		await commit(onTheExit, leaveExit);
		await commit(onTheFloor, leaveFloor);
		await advanceToRevealPhase(start + 3);
		await reveal(onTheExit, leaveExit);
		await reveal(onTheFloor, leaveFloor);

		// The one on plain floor is refused, and the refusal costs it nothing
		// else: it is still in the world, where it was.
		const stayed = await avatar(onTheFloor);
		expect(stayed.inGame).toEqual(true);
		expect(stayed.position).toEqual(pos(0n, 1n));

		// The one on the exit leaves: out of the world, and its position cleared.
		const left = await avatar(onTheExit);
		expect(left.inGame).toEqual(false);
		expect(left.position).toEqual(0n);

		// And leaving takes it off the board, rather than leaving a body behind in
		// the zone listing.
		const [inZone] = await env.read(Game, {
			functionName: 'getAvatarsInZone',
			args: [zoneID(3, 5), 0n, 100n],
		});
		expect(inZone.some((a) => a.avatarID === onTheExit)).toEqual(false);
	});

	/**
	 * One avatar's life, driven through the public routes: buy it, put it in
	 * the world, take a turn, let the clock run, take it home, bring it back (if it may).
	 * The tests below are the ways that story can end.
	 */
	async function oneAvatar(secretByte: string) {
		const fixture = await networkHelpers.loadFixture(deployAll);
		const {
			env,
			Game,
			Avatars,
			AvatarsSale,
			unnamedAccounts,
			advanceToCycle,
			advanceToRevealPhase,
			getCycleNumber,
			getTimestamp,
		} = fixture;
		const player = unnamedAccounts[0];
		const secret = `0x${secretByte.padStart(64, '0')}` as const;

		await env.execute(AvatarsSale, {
			account: player,
			functionName: 'purchase',
			args: purchaseArgs({gameAddress: Game.address, owner: player, subID: 0n}),
			value: BigInt(AvatarsSale.linkedData!.paymentAmount as string),
		});
		const avatarID = avatarIDFor(player, 0n);
		let {cycleNumber} = getCycleNumber(await getTimestamp());

		const commit = (actions: Action[]) =>
			env.execute(Game, {
				account: player,
				functionName: 'commit',
				args: [avatarID, commitmentHash(secret, actions), zeroAddress],
			});
		return {
			...fixture,
			player,
			avatarID,
			secret,
			commit,
			/**
			 * Commit `actions` as the next cycle's turn and never reveal them: the
			 * clock is left in the commit phase of the cycle after, mined.
			 */
			async commitAndGoQuiet(actions: Action[]) {
				cycleNumber += 1;
				await advanceToCycle(cycleNumber);
				await commit(actions);
				cycleNumber += 1;
				await advanceToCycle(cycleNumber, true);
			},
			/** Commit and reveal `actions` as the next cycle's whole turn. */
			async turn(actions: Action[]) {
				cycleNumber += 1;
				await advanceToCycle(cycleNumber);
				await commit(actions);
				await advanceToRevealPhase(cycleNumber);
				await env.execute(Game, {
					account: player,
					functionName: 'reveal',
					args: [avatarID, actions, secret, zeroAddress],
				});
			},
			/** Go quiet until the misses allowed have run out, and one more. */
			async goQuietUntilDead() {
				cycleNumber += Number(Game.linkedData!.numMissesAllowed) + 2;
				await advanceToCycle(cycleNumber, true);
			},
			/** Into the commit phase of the next cycle, mined. */
			async nextCycle() {
				cycleNumber += 1;
				await advanceToCycle(cycleNumber, true);
			},
			avatar: () => env.read(Game, {functionName: 'getAvatar', args: [avatarID]}),
			withdraw: () =>
				env.execute(Game, {
					account: player,
					functionName: 'withdraw',
					args: [avatarID, player],
				}),
			async depositAgain() {
				await env.execute(Avatars, {
					account: player,
					functionName: 'approve',
					args: [Game.address, avatarID],
				});
				await env.execute(Game, {
					account: player,
					functionName: 'deposit',
					args: [avatarID, zeroAddress],
				});
			},
		};
	}

	it('keeps a dead avatar in the game, for good', async function () {
		/**
		 * The avatar is the stake, and losing it means losing the token too
		 * (the maintainer, 2026-11-05). This reverses 9aaf42cd, which let a dead
		 * avatar be withdrawn so the NFT would not be locked in here forever, and
		 * which had a hole: out of the world an avatar reads as alive, so
		 * withdraw, deposit and enter brought a dead one back.
		 *
		 * Both halves are asserted, because a check that only ever refuses is
		 * as broken as one that only ever allows: refused while alive in the
		 * world, refused once dead, and the body is still where it fell.
		 */
		const a = await oneAvatar('e0');
		await a.turn([{actionType: 0, data: pos(0n, 1n)}]);
		await expect(a.withdraw()).toBeRejectedWith('AvatarStillInGame');

		await a.goQuietUntilDead();
		const dead = await a.avatar();
		expect(dead.life).toEqual(0);
		expect(dead.inGame).toEqual(true);
		await expect(a.withdraw()).toBeRejectedWith('AvatarIsDead');

		// Still the game's, and still lying where it fell.
		const holder = await a.env.read(a.Avatars, {
			functionName: 'ownerOf',
			args: [a.avatarID],
		});
		expect(holder.toLowerCase()).toEqual(a.Game.address.toLowerCase());
		const [inZone] = await a.env.read(a.Game, {
			functionName: 'getAvatarsInZone',
			args: [zoneID(0, 1), 0n, 100n],
		});
		expect(inZone.some((x) => x.avatarID === a.avatarID)).toEqual(true);

		// And it cannot act: no commitment, so no exit and no way out.
		await expect(a.commit([{actionType: 2, data: pos(0n, 1n)}])).toBeRejectedWith(
			'AvatarIsDead',
		);
	});

	it('lets an avatar that never entered be withdrawn', async function () {
		/**
		 * Bought, never put in the world, so never at risk: taking it home costs
		 * the game nothing.
		 */
		const a = await oneAvatar('e3');
		await a.withdraw();
		const holder = await a.env.read(a.Avatars, {
			functionName: 'ownerOf',
			args: [a.avatarID],
		});
		expect(holder.toLowerCase()).toEqual(a.player.toLowerCase());
	});

	it('lets an avatar that LEFT alive come back, as it always could', async function () {
		/**
		 * The other half of the rule above. Leaving by the exit is the way home
		 * the game offers, so retiring has to be about dying, not about having
		 * been withdrawn.
		 */
		const a = await oneAvatar('e1');
		await a.turn([{actionType: 0, data: pos(3n, 5n)}]); // onto the exit
		await a.turn([{actionType: 2, data: pos(3n, 5n)}]); // and out
		await a.withdraw();
		await a.depositAgain();
		expect((await a.avatar()).life).toEqual(1);

		await a.turn([{actionType: 0, data: pos(0n, 1n)}]);
		const back = await a.avatar();
		expect(back.inGame).toEqual(true);
		expect(back.life).toEqual(1);
		expect(back.position).toEqual(pos(0n, 1n));
	});

	it('refuses an Enter from an avatar already in the world', async function () {
		/**
		 * `_enter` checked nothing about the avatar, so one already standing in
		 * the world could commit an Enter and be put wherever it named: a
		 * teleport past every wall (and, in bomber-world, out of any blast),
		 * which also left its old entry behind in the zone it came from. An
		 * Enter is for an avatar outside the world, and from one inside it is
		 * dropped like any other action the rules refuse, without a revert.
		 */
		const a = await oneAvatar('e2');
		await a.turn([{actionType: 0, data: pos(0n, 1n)}]);
		await a.turn([{actionType: 0, data: pos(3n, 5n)}]);

		const stayed = await a.avatar();
		expect(stayed.inGame).toEqual(true);
		expect(stayed.position).toEqual(pos(0n, 1n));

		// Listed once in its zone (both cells are in zone (0, 0)), not twice.
		const [inZone] = await a.env.read(a.Game, {
			functionName: 'getAvatarsInZone',
			args: [zoneID(0, 1), 0n, 100n],
		});
		expect(inZone.filter((x) => x.avatarID === a.avatarID).length).toEqual(1);
	});

	/**
	 * A MISSED REVEAL, SETTLED ON THE FIRST OF THE BASE'S TWO ROUTES: shown the
	 * actions that were committed. Anyone may send it, because nothing in it can
	 * hurt the player more than their own silence did.
	 *
	 * WHAT IT COSTS IS THE MISS AND NOTHING ELSE, which is this game's
	 * `_forfeit` today (the maintainer, 2026-11-04: missed reveals do not kill
	 * until the front end is well tested). The miss is already counted, lazily,
	 * by `lastCycleNumber` not moving; the settlement only clears the slot so
	 * the avatar can commit again.
	 *
	 * AND IT RESOLVES NOTHING. The actions are checked against the commitment
	 * and then dropped: a settlement runs in a LATER cycle, so resolving there
	 * would write the board after its own cycle has closed (in bomber-world, a
	 * bomb landing in a cycle whose reveals have already been read).
	 */
	it('settles a missed reveal shown its actions, from anyone, and resolves none of them', async function () {
		const a = await oneAvatar('f0');
		const stranger = a.unnamedAccounts[3];
		await a.turn([{actionType: 0, data: pos(0n, 1n)}]);
		const missed: Action[] = [{actionType: 1, data: pos(0n, 2n)}];
		await a.commitAndGoQuiet(missed);

		// Blocked until it is settled: going quiet is not a way to start over.
		await expect(a.commit([])).toBeRejectedWith('PreviousCommitmentNotRevealed');

		// Shown anything else, it refuses: the chain checks what is settled.
		await expect(
			a.env.execute(a.Game, {
				account: stranger,
				functionName: 'acknowledgeMissedReveal',
				args: [a.avatarID, [{actionType: 1, data: pos(1n, 1n)}], a.secret],
			}),
		).toBeRejectedWith('CommitmentHashNotMatching');

		await a.env.execute(a.Game, {
			account: stranger,
			functionName: 'acknowledgeMissedReveal',
			args: [a.avatarID, missed, a.secret],
		});

		const after = await a.avatar();
		expect(after.life).toEqual(1);
		expect(after.position).toEqual(pos(0n, 1n));
		const commitment = await a.env.read(a.Game, {
			functionName: 'getCommitment',
			args: [a.avatarID],
		});
		expect(commitment.cycleNumber).toEqual(0n);
		await a.commit([]);
	});

	/**
	 * THE SECOND ROUTE: no actions, so only the owner or their delegate. A
	 * stranger could otherwise settle a commitment its owner could have
	 * settled on better terms; here both routes cost the same (the miss), but
	 * that is this game's `_forfeit` today and not a property of the route.
	 */
	it('settles a missed reveal without its actions, only for its owner', async function () {
		const a = await oneAvatar('f1');
		const stranger = a.unnamedAccounts[3];
		await a.turn([{actionType: 0, data: pos(0n, 1n)}]);
		await a.commitAndGoQuiet([{actionType: 1, data: pos(0n, 2n)}]);

		await expect(
			a.env.execute(a.Game, {
				account: stranger,
				functionName: 'forfeitMissedReveal',
				args: [a.avatarID],
			}),
		).toBeRejectedWith('NotDelegate');

		await a.env.execute(a.Game, {
			account: a.player,
			functionName: 'forfeitMissedReveal',
			args: [a.avatarID],
		});

		const after = await a.avatar();
		expect(after.life).toEqual(1);
		expect(after.position).toEqual(pos(0n, 1n));
		await a.commit([]);
	});

	/**
	 * The cycle's tally counts a commitment when it is made, so an avatar that
	 * could leave custody with one open would leave a commit counted for a
	 * member who no longer is one, and a SUBSET could then reach unanimity.
	 * The old looped attendance could not see a non-member's commitment; the
	 * base's O(1) tally can, so the door is closed here.
	 */
	it('refuses to withdraw an avatar with an open commitment', async function () {
		const a = await oneAvatar('f2');
		await a.nextCycle();
		await a.commit([{actionType: 0, data: pos(0n, 1n)}]);
		await expect(a.withdraw()).toBeRejectedWith('CommitmentStillOpen');
	});

	/**
	 * ONE CHUNK PER TURN, sized for the longest turn that can resolve: every
	 * move the game allows, then an exit (an Enter stops processing on its
	 * own). That turn reveals; one action more is refused by the base with
	 * `TooManyActions`, so the client must never commit one (and refuses to).
	 */
	it('reveals the longest turn that can resolve, and refuses a longer one', async function () {
		const a = await oneAvatar('f3');
		await a.turn([{actionType: 0, data: pos(0n, 1n)}]);
		const numMoves = Number(a.Game.linkedData!.numMoves);
		expect(Number(a.Game.linkedData!.actionsPerReveal)).toEqual(numMoves + 1);

		const steps: Action[] = Array.from({length: numMoves}, () => ({
			actionType: 1,
			data: pos(0n, 1n),
		}));
		await a.turn([...steps, {actionType: 2, data: 0n}]);

		await expect(
			a.turn([...steps, {actionType: 2, data: 0n}, {actionType: 2, data: 0n}]),
		).toBeRejectedWith('TooManyActions');
	});

	it('refuses a configuration whose reveal cannot carry its longest turn', async function () {
		const {env, Avatars} = await networkHelpers.loadFixture(deployAll);
		await expect(
			deployGameWith(env, 'Game_TooShortAReveal', {
				avatars: Avatars.address,
				cyclePolicy: CYCLE_POLICY.Timed,
				numMoves: 10n,
				actionsPerReveal: 10n,
			}),
		).toBeRejected();
	});
});

describe('buying an avatar', () => {
	/**
	 * The stipend is what makes onboarding ONE transaction.
	 *
	 * `SaleViaNativePayment.purchase` forwards `extraNativeTokenAmount` to
	 * `extraNativeTokenRecipient` before it checks the price, so the same call
	 * that puts an avatar in the game puts gas in the key that will play it.
	 * Without it a new player has an avatar they cannot move, and funding the
	 * signer separately means a second transaction from a wallet the first one
	 * just emptied.
	 *
	 * Pinned here rather than only in the app because the failure is arithmetic
	 * against a contract: the price check runs on `msg.value` MINUS the stipend
	 * and demands the remainder match exactly, so `purchaseArgs` and
	 * `purchaseValue` have to agree or nothing is bought at all.
	 */
	it('funds the signer in the same transaction', async () => {
		const {env, Game, AvatarsSale} = await deployAll();
		const owner = env.unnamedAccounts[0];
		// Stands in for the local signer: an address that holds nothing yet.
		const signer = env.unnamedAccounts[1];
		const price = BigInt(AvatarsSale.linkedData!.paymentAmount as string);
		const stipend = 12345678901234n;

		const before = await env.network.provider.request({
			method: 'eth_getBalance',
			params: [signer, 'latest'],
		});

		const subID = 7n;
		await env.execute(AvatarsSale, {
			account: owner,
			functionName: 'purchase',
			args: purchaseArgs({
				gameAddress: Game.address,
				owner,
				subID,
				stipendTo: signer,
				stipend,
			}),
			value: purchaseValue({price, stipend}),
		});

		const after = await env.network.provider.request({
			method: 'eth_getBalance',
			params: [signer, 'latest'],
		});

		// The signer pays no gas here (the owner sent the transaction), so the
		// whole stipend arrives.
		expect(BigInt(after as string) - BigInt(before as string)).toEqual(stipend);

		// And the avatar is in the game, under the id the client computed before
		// sending anything.
		const avatar = await env.read(Game, {
			functionName: 'getAvatar',
			args: [avatarIDFor(owner, subID)],
		});
		expect(avatar.owner.toLowerCase()).toEqual(owner.toLowerCase());
	});
});
