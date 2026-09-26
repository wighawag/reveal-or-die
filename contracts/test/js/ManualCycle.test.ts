import {expect} from 'earl';
import {describe, it} from 'node:test'; // using node:test as hardhat v3 do not support vitest
import {network} from 'hardhat';
import {zeroAddress} from 'viem';
import {setupFixtures, deployGameWith, CYCLE_POLICY} from './utils/index.js';
import {commitmentHash, type Action} from '../../js/commitment.js';
import {avatarIDFor, purchaseArgs} from '../../js/avatar-id.js';

const {provider, networkHelpers} = await network.connect();
const {deployAll} = setupFixtures(provider);

/**
 * A CYCLE THAT IS PUSHED BY HAND, which this game could not run until now.
 *
 * WHAT WAS BROKEN, because it is the reason every assertion here exists. The
 * cycle policy used to be INFERRED from the two phase durations, and the same
 * derivation also set `SKIP_COMMIT` - one expression standing for two unrelated
 * things, with `TODO allow to specify it separately` beside it. So a deployment
 * that asked for a cycle pushed by hand silently also asked for a game with NO
 * COMMIT PHASE: `getCycleNumber` answered `commiting: false` forever, `commit`
 * reverted `InRevealPhase`, and `moveToNextPhase` reverted
 * `CommitPhaseIsSkipped`. A commit-reveal game that cannot commit, and nothing
 * anywhere refused the configuration.
 *
 * `SKIP_COMMIT` IS DELETED RATHER THAN SPLIT OUT, which is what the template
 * did with its own copy of this bug and is why there is no `skipCommit` to
 * test. It had no consumer: every environment declared it false, and its only
 * reads were the manual-cycle machinery the derivation had entangled it with.
 * Formalising it would have left a knob nobody turns and given this repo a
 * concept its parent deliberately removed.
 *
 * It was found by trying to build an offline world on it - a chain in a browser
 * tab, where the manual policy is the only honest one because an automined
 * chain has no clock between transactions - and it is worth knowing that
 * NOTHING ELSE WOULD HAVE FOUND IT. Every deployment of this game is timed, so
 * every test, the whole client and both live chains exercised the other branch.
 *
 * So these tests are the manual branch's first exercise, and they assert the
 * property the offline world actually depends on: a full round, in the order a
 * round happens. Commit, push, reveal, push.
 */
describe('a cycle pushed by hand', function () {
	it('refuses a configuration whose durations disagree with its policy', async function () {
		const {env, Avatars} = await networkHelpers.loadFixture(deployAll);

		// THE GUARD THAT REPLACES THE DERIVATION. Splitting the policy from the
		// durations means they can now be declared inconsistently, so the
		// constructor refuses it - which is strictly better than the inference it
		// replaced, because the inference could not be wrong and could not be
		// asked for either.
		await expect(
			deployGameWith(env, 'Game_ManualWithAClock', {
				avatars: Avatars.address,
				cyclePolicy: CYCLE_POLICY.Manual,
				commitPhaseDuration: 30n,
				revealPhaseDuration: 10n,
			}),
		).toBeRejected();

		// And the other way: a timed cycle of length zero would divide by it.
		await expect(
			deployGameWith(env, 'Game_TimedWithNoClock', {
				avatars: Avatars.address,
				cyclePolicy: CYCLE_POLICY.Timed,
				commitPhaseDuration: 0n,
				revealPhaseDuration: 0n,
			}),
		).toBeRejected();
	});

	it('opens in a COMMIT phase, which is what skip-commit used to take away', async function () {
		const {env, Avatars} = await networkHelpers.loadFixture(deployAll);
		const Game = await deployGameWith(env, 'Game_Manual_Opening', {
			avatars: Avatars.address,
			cyclePolicy: CYCLE_POLICY.Manual,
		});

		const [cycleNumber, committing] = (await env.read(Game, {
			functionName: 'getCycleNumber',
		})) as readonly [bigint, boolean];

		// The `+ 2` is the framework's, so that the hypothetical reveal phase
		// before the first commit phase can be cycle 1.
		expect(cycleNumber).toEqual(2n);
		// THE WHOLE BUG, in one assertion. This was `false`, and everything
		// downstream followed from it.
		expect(committing).toEqual(true);
	});

	it('plays a whole round: commit, push, reveal, push', async function () {
		const {env, Avatars, AvatarsSale, unnamedAccounts} =
			await networkHelpers.loadFixture(deployAll);
		const Game = await deployGameWith(env, 'Game_Manual_Round', {
			avatars: Avatars.address,
			cyclePolicy: CYCLE_POLICY.Manual,
		});

		const subID = 0n;
		const avatarID = avatarIDFor(unnamedAccounts[0], subID);
		await env.execute(AvatarsSale, {
			account: env.unnamedAccounts[0],
			functionName: 'purchase',
			args: purchaseArgs({
				gameAddress: Game.address,
				owner: unnamedAccounts[0],
				subID,
			}),
			value: BigInt(AvatarsSale.linkedData!.paymentAmount as string),
		});

		const secret =
			'0x0000000000000000000000000000000000000000000000000000000000000001' as const;
		const enter: Action[] = [{actionType: 0, data: 0n}];

		// COMMIT, in a phase that did not exist before this change.
		await env.execute(Game, {
			account: env.unnamedAccounts[0],
			functionName: 'commit',
			args: [avatarID, commitmentHash(secret, enter), zeroAddress],
		});

		// PUSH. One call covers both of the framework's outcomes: from the commit
		// phase it opens the reveal phase at the SAME cycle number, which is what
		// keeps the commitment openable.
		await env.execute(Game, {
			account: env.unnamedAccounts[0],
			functionName: 'moveToNextPhase',
			args: [],
		});
		const [afterPush, stillCommitting] = (await env.read(Game, {
			functionName: 'getCycleNumber',
		})) as readonly [bigint, boolean];
		expect(afterPush).toEqual(2n);
		expect(stillCommitting).toEqual(false);

		// REVEAL. If the push above had moved the CYCLE rather than the phase,
		// this is where it would fail, with `InvalidCycle` and a stranded
		// commitment - which is what the since-removed `moveToNextEpoch` did.
		// See `web/src/lib/world/advance.ts`.
		await env.execute(Game, {
			account: env.unnamedAccounts[0],
			functionName: 'reveal',
			args: [avatarID, enter, secret, zeroAddress],
		});

		const avatar = (await env.read(Game, {
			functionName: 'getAvatar',
			args: [avatarID],
		})) as {inGame: boolean; lastCycleNumber: bigint};
		expect(avatar.inGame).toEqual(true);
		// `lastCycleNumber` IS HOW ATTENDANCE COUNTS REVEALS, because `reveal`
		// zeroes the commitment when it is done - so a member that has revealed
		// is otherwise indistinguishable from one that never committed.
		// `_attendance` depends on exactly this, and this is where it is pinned.
		expect(avatar.lastCycleNumber).toEqual(2n);

		// PUSH AGAIN, which closes the cycle and opens the next one's commit
		// phase.
		await env.execute(Game, {
			account: env.unnamedAccounts[0],
			functionName: 'moveToNextPhase',
			args: [],
		});
		const [nextCycle, committingAgain] = (await env.read(Game, {
			functionName: 'getCycleNumber',
		})) as readonly [bigint, boolean];
		expect(nextCycle).toEqual(3n);
		expect(committingAgain).toEqual(true);
	});

	it('waits for EVERY member before either push, and the contract is the judge', async function () {
		// The guard `_moveToNextPhase` lacked: a push used to open the reveal
		// phase on a player who had not committed, or close a cycle on one who
		// had not revealed, and anyone may send one. Two members, each push tried
		// while one of them is still owed and refused, then allowed.
		const {env, Avatars, AvatarsSale, unnamedAccounts} =
			await networkHelpers.loadFixture(deployAll);
		const Game = await deployGameWith(env, 'Game_Manual_Unanimity', {
			avatars: Avatars.address,
			cyclePolicy: CYCLE_POLICY.Manual,
		});
		const [a, b] = [unnamedAccounts[0], unnamedAccounts[1]];
		for (const owner of [a, b]) {
			await env.execute(AvatarsSale, {
				account: owner,
				functionName: 'purchase',
				args: purchaseArgs({gameAddress: Game.address, owner, subID: 0n}),
				value: BigInt(AvatarsSale.linkedData!.paymentAmount as string),
			});
		}
		const id = {A: avatarIDFor(a, 0n), B: avatarIDFor(b, 0n)};
		const account = {A: a, B: b};
		const secret =
			'0x0000000000000000000000000000000000000000000000000000000000000001' as const;
		const enter = {
			A: [{actionType: 0, data: (1n << 32n) | 0n}] as Action[],
			B: [{actionType: 0, data: (3n << 32n) | 0n}] as Action[],
		};

		const attendance = async () =>
			(await env.read(Game, {functionName: 'getAttendance'})) as {
				waitedFor: bigint;
				committed: bigint;
				revealed: bigint;
			};
		const push = () =>
			env.execute(Game, {
				account: a,
				functionName: 'moveToNextPhase',
				args: [],
			});
		async function refused(name: string) {
			let message = '';
			try {
				await push();
			} catch (error) {
				message = String(error);
			}
			expect(message.includes(name)).toEqual(true);
		}
		const commit = (who: 'A' | 'B') =>
			env.execute(Game, {
				account: account[who],
				functionName: 'commit',
				args: [id[who], commitmentHash(secret, enter[who]), zeroAddress],
			});
		const reveal = (who: 'A' | 'B') =>
			env.execute(Game, {
				account: account[who],
				functionName: 'reveal',
				args: [id[who], enter[who], secret, zeroAddress],
			});

		// Both were enrolled when they entered custody: membership is setup.
		expect(await attendance()).toEqual({
			waitedFor: 2n,
			committed: 0n,
			revealed: 0n,
		});

		await commit('A');
		await refused('StillWaitingToCommit');
		await commit('B');
		await push();

		await reveal('A');
		expect(await attendance()).toEqual({
			waitedFor: 2n,
			committed: 2n,
			revealed: 1n,
		});
		await refused('StillWaitingToReveal');
		await reveal('B');
		await push();

		const [cycleNumber, commiting] = (await env.read(Game, {
			functionName: 'getCycleNumber',
		})) as readonly [bigint, boolean];
		expect(cycleNumber).toEqual(3n);
		expect(commiting).toEqual(true);
		// and last cycle's reveals do not count towards this one's
		expect(await attendance()).toEqual({
			waitedFor: 2n,
			committed: 0n,
			revealed: 0n,
		});
	});

	it('stops waiting for an avatar that leaves custody, and refuses with nobody left', async function () {
		const {env, Avatars, AvatarsSale, unnamedAccounts} =
			await networkHelpers.loadFixture(deployAll);
		const Game = await deployGameWith(env, 'Game_Manual_Leaving', {
			avatars: Avatars.address,
			cyclePolicy: CYCLE_POLICY.Manual,
		});
		const owner = unnamedAccounts[0];
		await env.execute(AvatarsSale, {
			account: owner,
			functionName: 'purchase',
			args: purchaseArgs({gameAddress: Game.address, owner, subID: 0n}),
			value: BigInt(AvatarsSale.linkedData!.paymentAmount as string),
		});
		const attendance = async () =>
			(
				(await env.read(Game, {functionName: 'getAttendance'})) as {
					waitedFor: bigint;
				}
			).waitedFor;
		expect(await attendance()).toEqual(1n);

		await env.execute(Game, {
			account: owner,
			functionName: 'withdraw',
			args: [avatarIDFor(owner, 0n), owner],
		});
		expect(await attendance()).toEqual(0n);

		// Nobody to wait for is not "everybody has acted": an empty table must
		// not let one caller spin the cycle forward on their own.
		let message = '';
		try {
			await env.execute(Game, {
				account: owner,
				functionName: 'moveToNextPhase',
				args: [],
			});
		} catch (error) {
			message = String(error);
		}
		expect(message.includes('NoOneToWaitFor')).toEqual(true);
	});

	it('enrols nobody when the clock decides', async function () {
		// The shipped deployment is timed: a purchase puts the avatar in custody
		// and waits for nobody, so a timed game pays nothing for this.
		const {env, Game, AvatarsSale, unnamedAccounts} =
			await networkHelpers.loadFixture(deployAll);
		const owner = unnamedAccounts[0];
		await env.execute(AvatarsSale, {
			account: owner,
			functionName: 'purchase',
			args: purchaseArgs({gameAddress: Game.address, owner, subID: 0n}),
			value: BigInt(AvatarsSale.linkedData!.paymentAmount as string),
		});
		const {waitedFor} = (await env.read(Game, {
			functionName: 'getAttendance',
		})) as {waitedFor: bigint};
		expect(waitedFor).toEqual(0n);
	});

	it('will not be pushed when the clock is the one deciding', async function () {
		// The other half of the policy being declared: the framework's advance
		// client never pushes a timed deployment, and the contract refuses one
		// anyway. This is the shipped configuration, so it is the branch every
		// other test in this suite is already running.
		const {env, Game} = await networkHelpers.loadFixture(deployAll);
		await expect(
			env.execute(Game, {
				account: env.unnamedAccounts[0],
				functionName: 'moveToNextPhase',
				args: [],
			}),
		).toBeRejected();
	});

	it('has no way to skip a phase, because the one that did is gone', async function () {
		// `moveToNextEpoch` opened the next cycle's commit phase from anywhere,
		// so during a commit phase it skipped the reveal and stranded every
		// commitment in it. Removed rather than guarded; this pins that nothing
		// behind the proxy answers to it any more, which a revert-on-timed test
		// could not tell apart from a guarded copy.
		const {Game} = await networkHelpers.loadFixture(deployAll);
		const names = (Game.abi as readonly {type: string; name?: string}[])
			.filter((item) => item.type === 'function')
			.map((item) => item.name);
		expect(names.includes('moveToNextEpoch')).toEqual(false);
		expect(names.includes('moveToNextPhase')).toEqual(true);
	});
});
