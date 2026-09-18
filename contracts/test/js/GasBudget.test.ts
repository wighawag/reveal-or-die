import {describe, it} from 'node:test';
import assert from 'node:assert';
import {network} from 'hardhat';
import {
	setupFixtures,
	enterGame,
	commitmentChain,
	commitmentHashFor,
	type Placement,
} from './utils/index.js';
import {parseEther, zeroAddress} from 'viem';

/**
 * THE DECLARED GAS BUDGET IS A CLAIM ABOUT THESE CONTRACTS, so these contracts
 * are what checks it.
 *
 * `commitGas` and `revealGas` are declared by the deploy
 * (`rocketh/config.ts`), recorded in the Game's `linkedData`, and read by the
 * client to size the gas stipend a new player is given. They used to be
 * constants in `web/src/lib/placement/config.ts`, which is INHERITED down this
 * template tree while contracts are NOT - so a descendant budgeted with figures
 * measured against a game it does not run, in a file whose text did not differ.
 *
 * Moving them to the deployment fixes whose numbers they are. This test is what
 * stops them rotting: a contract change that makes a commit or a reveal more
 * expensive than the deployment claims fails HERE, in the suite that ships with
 * the contracts, rather than in a player's wallet a release later.
 *
 * IT ASSERTS THE WORST CASE, NOT A TYPICAL ONE. For the reveal that is a FULL
 * chunk of cells claimed for the first time, each in a different zone, because
 * `_place` appends to a per-zone index only on a cell's first claim: four first
 * claims across four zones is four new dynamic arrays and there is no more
 * expensive shape a single reveal can take. For the commit it is the FIRST one
 * a player makes, when every slot it writes is cold.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is require the budget to be tight. Over
 * declaring costs a slightly larger stipend; under declaring costs a player
 * their gas mid-turn, and if these figures are ever passed as gas LIMITS it
 * costs them the stake, because a reveal that runs out of gas is a missed
 * reveal. So the assertion is one-sided on purpose. The companion assertion -
 * that the budget has not drifted into meaninglessness - is a loose ceiling
 * rather than a tight one.
 */

const {provider, networkHelpers} = await network.connect();
const {deployAll} = setupFixtures(provider);

function cellAt(x: number, y: number): bigint {
	const ux = BigInt.asUintN(32, BigInt(x));
	const uy = BigInt.asUintN(32, BigInt(y));
	return (uy << 32n) + ux;
}

const SECRET =
	'0x00000000000000000000000000000000000000000000000000000000000000a1';

/** How far above the measured worst case a declared figure may sit. */
const GENEROSITY_CEILING = 3n;

describe('the declared gas budget', function () {
	it('covers the worst commit and the worst reveal these contracts can produce', async function () {
		const fixtures = await networkHelpers.loadFixture(deployAll);
		const {
			env,
			Game,
			GameToken,
			linkedData,
			actionsPerReveal,
			unnamedAccounts,
			advanceToCycleNumber,
			advanceToRevealPhase,
			getCycleNumber,
			getTimestamp,
		} = fixtures;

		const declaredCommit = BigInt(linkedData.commitGas);
		const declaredReveal = BigInt(linkedData.revealGas);

		const player = unnamedAccounts[0];
		const {cycleNumber: start} = getCycleNumber(await getTimestamp());
		await advanceToCycleNumber(start + 2, true);
		const identity = await enterGame({env, Game, GameToken}, player, {
			amount: parseEther('100'),
		});

		// The worst case a chunk can reach: every cell fresh, every cell in a
		// different zone.
		const turn: Placement[] = Array.from(
			{length: actionsPerReveal},
			(_, i) => ({cellID: cellAt(i * 40, 100)}),
		);
		const {chunks} = commitmentChain(turn, SECRET, actionsPerReveal);

		// A FIRST commit, which is the cold-slot case.
		const commitReceipt = await env.execute(Game, {
			account: player,
			functionName: 'makeCommitment',
			args: [
				identity,
				commitmentHashFor(turn, SECRET, actionsPerReveal),
				parseEther('10'),
				zeroAddress,
			],
		});
		const commitUsed = BigInt(commitReceipt.gasUsed);

		const {cycleNumber} = getCycleNumber(await getTimestamp());
		await advanceToRevealPhase(cycleNumber, true);
		const revealReceipt = await env.execute(Game, {
			account: player,
			functionName: 'reveal',
			args: [
				identity,
				chunks[0].placements,
				SECRET,
				chunks[0].furtherActions,
				zeroAddress,
			],
		});
		const revealUsed = BigInt(revealReceipt.gasUsed);

		assert.ok(
			commitUsed <= declaredCommit,
			`a first commit costs ${commitUsed} gas and the deployment declares commitGas ${declaredCommit}. ` +
				`Raise it in contracts/rocketh/config.ts: the client sizes a new player's gas stipend from it, ` +
				`and if it is ever passed as a LIMIT this is a missed reveal rather than a slow one.`,
		);
		assert.ok(
			revealUsed <= declaredReveal,
			`a full fresh chunk of ${actionsPerReveal} costs ${revealUsed} gas and the deployment declares revealGas ${declaredReveal}. ` +
				`Raise it in contracts/rocketh/config.ts, and note that a chunk is what this bounds: ` +
				`raising actionsPerReveal raises this figure roughly in proportion.`,
		);

		// AND THE OTHER DIRECTION, loosely. A budget that has drifted far above
		// what the contracts cost is not dangerous, but it over-funds every
		// stipend and it means nobody has re-measured in a long time.
		assert.ok(
			declaredCommit <= commitUsed * GENEROSITY_CEILING,
			`commitGas is declared at ${declaredCommit} against a measured ${commitUsed}, more than ${GENEROSITY_CEILING}x. Re-measure it.`,
		);
		assert.ok(
			declaredReveal <= revealUsed * GENEROSITY_CEILING,
			`revealGas is declared at ${declaredReveal} against a measured ${revealUsed}, more than ${GENEROSITY_CEILING}x. Re-measure it.`,
		);

		console.log(
			`gas budget: commit ${commitUsed}/${declaredCommit}, reveal ${revealUsed}/${declaredReveal} at ${actionsPerReveal} actions per reveal`,
		);
	});

	it('is what the credits multiplier is derived from, so the two cannot drift apart', async function () {
		const fixtures = await networkHelpers.loadFixture(deployAll);
		const {linkedData} = fixtures;

		// `creditsGasMultiplier` prices ONE user action, which since the reveal
		// became chunked is a commit plus one reveal STEP. It is derived from
		// these two in `rocketh/config.ts` rather than typed out again, because
		// the last time it was a second copy it merged cleanly into a branch
		// whose contracts cost 30% less and priced a credit 58% too high.
		const sum = BigInt(linkedData.commitGas) + BigInt(linkedData.revealGas);
		assert.ok(sum > 0n, 'the deployment declares no gas budget at all');
	});
});
