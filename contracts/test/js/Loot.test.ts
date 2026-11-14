import {expect} from 'earl';
import {describe, it} from 'node:test'; // using node:test as hardhat v3 do not support vitest
import {network} from 'hardhat';
import {zeroAddress} from 'viem';
import {setupFixtures} from './utils/index.js';
import {commitmentHash, ActionType, MAX_COLLECTS, type Action} from '../../js/commitment.js';
import {avatarIDFor, purchaseArgs} from '../../js/avatar-id.js';
import {REVEAL_GAS} from '../../js/gas.js';

/**
 * THE STAKE IN THE AVATAR, AND THE BODIES (reveal-or-die `work`:
 * `stake-in-the-avatar`; stratagems' plan, step R1a).
 *
 * Every avatar carries a fixed stake in ETH, put there by the sale at mint and
 * paid out only by burning it, by whoever holds it. A dead avatar is a body in
 * the world; an avatar standing on it names it (`Collect`), and the avatars
 * that collect it in the FIRST cycle it is collected in share it, each pulling
 * its share later (`settleClaim`). The body's share is its stake plus whatever
 * it had collected itself, and the game releases the stake by burning the body
 * it holds: `Avatars` trusts no game. What an avatar collected is paid when it
 * is withdrawn, and the avatar leaves with exactly the stake it came with.
 *
 * No loop here is longer than `MAX_COLLECTS`.
 */

const {provider, networkHelpers} = await network.connect();
const {deployAll} = setupFixtures(provider);

const pos = (x: bigint, y: bigint) => (y << 32n) | x;
const enter = (x: bigint, y: bigint): Action => ({actionType: ActionType.Enter, data: pos(x, y)});
const move = (x: bigint, y: bigint): Action => ({actionType: ActionType.Move, data: pos(x, y)});
const collect = (body: bigint): Action => ({actionType: ActionType.Collect, data: body});
const exit = (): Action => ({actionType: ActionType.Exit, data: 0n});

type Who = string;

/** From (0,2) to the exit tile at (3,5), and out: eight steps, then Exit. */
const TO_THE_EXIT: Action[] = [
	move(0n, 3n),
	move(1n, 3n),
	move(2n, 3n),
	move(3n, 3n),
	move(4n, 3n),
	move(4n, 4n),
	move(4n, 5n),
	move(3n, 5n),
	exit(),
];

/** A world of named avatars, each bought by an account of its own. */
async function world(names: Who[]) {
	const fixture = await networkHelpers.loadFixture(deployAll);
	const {env, Game, Avatars, AvatarsSale, unnamedAccounts, advanceToCycle, advanceToRevealPhase, getCycleNumber, getTimestamp} =
		fixture;
	const sale = AvatarsSale.linkedData as {paymentAmount: string; stakeAmount: string};
	const price = BigInt(sale.paymentAmount) + BigInt(sale.stakeAmount);
	const stake = BigInt(sale.stakeAmount);

	const avatars: Record<Who, {account: `0x${string}`; id: bigint; secret: `0x${string}`}> = {};
	for (const [i, name] of names.entries()) {
		const account = unnamedAccounts[i] as `0x${string}`;
		await env.execute(AvatarsSale, {
			account,
			functionName: 'purchase',
			args: purchaseArgs({gameAddress: Game.address, owner: account, subID: 0n}),
			value: price,
		});
		avatars[name] = {
			account,
			id: avatarIDFor(account, 0n),
			secret: `0x${(i + 1).toString(16).padStart(64, '0')}`,
		};
	}

	let {cycleNumber} = getCycleNumber(await getTimestamp());

	/** One cycle: each named avatar commits and reveals its actions, in `order`. */
	async function cycle(turns: Record<Who, Action[]>, order?: Who[]) {
		cycleNumber += 1;
		await advanceToCycle(cycleNumber);
		const who = Object.keys(turns);
		for (const name of who) {
			const a = avatars[name];
			await env.execute(Game, {
				account: a.account,
				functionName: 'commit',
				args: [a.id, commitmentHash(a.secret, turns[name]), zeroAddress],
			});
		}
		await advanceToRevealPhase(cycleNumber);
		const receipts: Record<Who, {gasUsed: bigint}> = {};
		for (const name of order ?? who) {
			const a = avatars[name];
			receipts[name] = await env.execute(Game, {
				account: a.account,
				functionName: 'reveal',
				args: [a.id, turns[name], a.secret, zeroAddress],
			});
		}
		return receipts;
	}

	/** Into the commit phase of the next cycle, mined, with nobody playing. */
	async function quiet() {
		cycleNumber += 1;
		await advanceToCycle(cycleNumber, true);
	}

	const balance = async (account: `0x${string}`) =>
		BigInt((await provider.request({method: 'eth_getBalance', params: [account, 'latest']})) as string);

	return {
		...fixture,
		avatars,
		price,
		stake,
		cycle,
		quiet,
		balance,
		id: (name: Who) => avatars[name].id,
		cycleNumber: () => cycleNumber,
		avatar: (name: Who) => env.read(Game, {functionName: 'getAvatar', args: [avatars[name].id]}),
		body: (name: Who) => env.read(Game, {functionName: 'getBody', args: [avatars[name].id]}),
		carried: (name: Who) => env.read(Game, {functionName: 'getCarried', args: [avatars[name].id]}),
		settle: (collector: Who, body: Who, account?: `0x${string}`) =>
			env.execute(Game, {
				account: account ?? avatars[collector].account,
				functionName: 'settleClaim',
				args: [avatars[collector].id, avatars[body].id],
			}),
		withdraw: (name: Who) =>
			env.execute(Game, {
				account: avatars[name].account,
				functionName: 'withdraw',
				args: [avatars[name].id, avatars[name].account],
			}),
		stakeOf: (name: Who) => env.read(Avatars, {functionName: 'stakeOf', args: [avatars[name].id]}),
	};
}

/**
 * `dead` enters at (0,2) and goes quiet; the others enter at (0,1) and (0,3)
 * and play empty turns until it is dead (more than `numMissesAllowed` cycles
 * behind), so they are alive and next to the body.
 */
async function aBodyBetween(collectors: Who[]) {
	const w = await world(['dead', ...collectors]);
	const starts: [bigint, bigint][] = [
		[0n, 1n],
		[0n, 3n],
		[0n, 1n],
	];
	await w.cycle({
		dead: [enter(0n, 2n)],
		...Object.fromEntries(collectors.map((c, i) => [c, [enter(...starts[i])]])),
	});
	const missesAllowed = Number(w.Game.linkedData!.numMissesAllowed);
	for (let i = 0; i < missesAllowed + 1; i++) {
		await w.cycle(Object.fromEntries(collectors.map((c) => [c, []])));
	}
	expect((await w.avatar('dead')).life).toEqual(0);
	return w;
}

describe('the stake in an avatar', () => {
	it('is fixed by the sale at mint, and paid to whoever holds the avatar when they burn it', async () => {
		const w = await world(['a']);
		expect(w.stake > 0n).toEqual(true);
		expect(await w.stakeOf('a')).toEqual(w.stake);

		// the avatar is in the game's custody: its owner does not hold it
		const {account, id} = w.avatars.a;
		await expect(
			w.env.execute(w.Avatars, {account, functionName: 'burn', args: [id]}),
		).toBeRejectedWith('NotHolder');

		await w.withdraw('a');
		const before = await w.balance(account);
		const receipt = await w.env.execute(w.Avatars, {account, functionName: 'burn', args: [id]});
		const after = await w.balance(account);
		const gas = receipt.gasUsed * receipt.effectiveGasPrice;
		expect(after - before + gas).toEqual(w.stake);

		// and that id can never be minted again
		await expect(
			w.env.execute(w.AvatarsSale, {
				account,
				functionName: 'purchase',
				args: purchaseArgs({gameAddress: w.Game.address, owner: account, subID: 0n}),
				value: w.price,
			}),
		).toBeRejectedWith('TokenCannotBeReminted');
	});

	it('is paid whatever the free-list waives: the fee, never the stake', async () => {
		const w = await world([]);
		const {admin} = w.namedAccounts;
		const buyer = w.unnamedAccounts[5] as `0x${string}`;
		await w.env.execute(w.AvatarsSale, {account: admin, functionName: 'addToFreeMap', args: [[buyer]]});
		await expect(
			w.env.execute(w.AvatarsSale, {
				account: buyer,
				functionName: 'purchase',
				args: purchaseArgs({gameAddress: w.Game.address, owner: buyer, subID: 1n}),
				value: 0n,
			}),
		).toBeRejectedWith('WrongPaymentAmount');
		await w.env.execute(w.AvatarsSale, {
			account: buyer,
			functionName: 'purchase',
			args: purchaseArgs({gameAddress: w.Game.address, owner: buyer, subID: 1n}),
			value: w.stake,
		});
		expect(await w.env.read(w.Avatars, {functionName: 'stakeOf', args: [avatarIDFor(buyer, 1n)]})).toEqual(w.stake);
	});

	it('cannot be sent to the game by anyone but the avatars, which send it only by a burn', async () => {
		const w = await world([]);
		const sender = w.unnamedAccounts[3] as `0x${string}`;
		await expect(
			w.env.execute(w.Game, {account: sender, functionName: 'settleClaim', args: [1n, 2n], value: 1n} as never),
		).toBeRejected();
		await expect(
			provider.request({
				method: 'eth_sendTransaction',
				params: [{from: sender, to: w.Game.address, value: '0x1'}],
			}),
		).toBeRejected();
	});
});

describe('a body', () => {
	it('is shared by the avatars that collect it in the first cycle it is collected in', async () => {
		const w = await aBodyBetween(['a', 'b']);
		const body = w.id('dead');
		await w.cycle({a: [move(0n, 2n), collect(body)], b: [move(0n, 2n), collect(body)]});
		let state = await w.body('dead');
		expect(state.claimants).toEqual(2);
		expect(state.firstClaimCycle).toEqual(BigInt(w.cycleNumber()));
		expect(state.released).toEqual(false);

		// not before that cycle is over: the count is not final yet
		await expect(w.settle('a', 'dead')).toBeRejectedWith('ClaimNotFinal');

		await w.quiet();
		await w.settle('a', 'dead');
		state = await w.body('dead');
		expect(state.released).toEqual(true);
		expect(state.pot).toEqual(w.stake);
		// the body was burned: its stake is in the game now, not in the avatar
		expect(await w.stakeOf('dead')).toEqual(0n);
		await expect(w.env.read(w.Avatars, {functionName: 'ownerOf', args: [body]})).toBeRejected();

		// anyone may settle a claim for its collector
		await w.settle('b', 'dead', w.avatars.a.account);
		expect(await w.carried('a')).toEqual(w.stake / 2n);
		expect(await w.carried('b')).toEqual(w.stake / 2n);

		// a claim settles once
		await expect(w.settle('a', 'dead')).toBeRejectedWith('NoClaim');
	});

	it('gives nothing to a claim made after the first cycle it was collected in', async () => {
		const w = await aBodyBetween(['a', 'b']);
		const body = w.id('dead');
		await w.cycle({a: [move(0n, 2n), collect(body)], b: []});
		// b arrives a cycle later: its Collect is dropped, and everything after it
		const receipts = await w.cycle({a: [], b: [move(0n, 2n), collect(body), move(0n, 3n)]});
		expect(receipts.b).toBeTruthy();
		expect((await w.avatar('b')).position).toEqual(pos(0n, 2n));
		expect((await w.body('dead')).claimants).toEqual(1);
		await w.settle('a', 'dead');
		expect(await w.carried('a')).toEqual(w.stake);
		await expect(w.settle('b', 'dead')).toBeRejectedWith('NoClaim');
	});

	it('cannot be collected from another cell, nor while alive', async () => {
		const w = await aBodyBetween(['a', 'b']);
		await w.cycle({a: [collect(w.id('dead'))], b: [collect(w.id('a'))]});
		expect((await w.body('dead')).claimants).toEqual(0);
		expect((await w.body('a')).claimants).toEqual(0);
	});

	it(`takes at most ${MAX_COLLECTS} collects a turn`, async () => {
		const names = ['d1', 'd2', 'd3', 'd4'];
		const w = await world([...names, 'a']);
		// four bodies on one cell, then one collector beside them
		await w.cycle({...Object.fromEntries(names.map((n) => [n, [enter(0n, 2n)]])), a: [enter(0n, 1n)]});
		const missesAllowed = Number(w.Game.linkedData!.numMissesAllowed);
		for (let i = 0; i < missesAllowed + 1; i++) await w.cycle({a: []});
		await w.cycle({a: [move(0n, 2n), ...names.map((n) => collect(w.id(n)))]});
		const claimed = await Promise.all(names.map(async (n) => (await w.body(n)).claimants));
		expect(claimed).toEqual([1, 1, 1, 0]);
	});

	it("is not released while it has claims of its own unsettled, and then carries what it collected", async () => {
		const w = await aBodyBetween(['carrier', 'b']);
		// the carrier collects the dead, then goes quiet and dies with the claim open
		await w.cycle({carrier: [move(0n, 2n), collect(w.id('dead'))], b: []});
		const missesAllowed = Number(w.Game.linkedData!.numMissesAllowed);
		for (let i = 0; i < missesAllowed + 1; i++) await w.cycle({b: []});
		expect((await w.avatar('carrier')).life).toEqual(0);

		// b collects the carrier's body where it fell
		await w.cycle({b: [move(0n, 2n), collect(w.id('carrier'))]});
		await w.quiet();
		await expect(w.settle('b', 'carrier')).toBeRejectedWith('BodyHasOpenClaims');

		// the chain is settled from the bottom up
		await w.settle('carrier', 'dead', w.avatars.b.account);
		expect(await w.carried('carrier')).toEqual(w.stake);
		await w.settle('b', 'carrier');
		expect((await w.body('carrier')).pot).toEqual(2n * w.stake);
		expect(await w.carried('b')).toEqual(2n * w.stake);
		expect(await w.carried('carrier')).toEqual(0n);
	});

	it('pays what was collected when the avatar is withdrawn, and the avatar keeps exactly its stake', async () => {
		const w = await aBodyBetween(['a']);
		await w.cycle({a: [move(0n, 2n), collect(w.id('dead'))]});
		await w.cycle({a: TO_THE_EXIT});
		expect((await w.avatar('a')).inGame).toEqual(false);
		await w.settle('a', 'dead');
		expect(await w.carried('a')).toEqual(w.stake);

		const {account} = w.avatars.a;
		const before = await w.balance(account);
		const receipt = await w.withdraw('a');
		const after = await w.balance(account);
		expect(after - before + receipt.gasUsed * receipt.effectiveGasPrice).toEqual(w.stake);
		expect(await w.carried('a')).toEqual(0n);
		expect(await w.stakeOf('a')).toEqual(w.stake);
	});

	it('pays a claim settled after its collector was withdrawn to the owner directly', async () => {
		const w = await aBodyBetween(['a']);
		await w.cycle({a: [move(0n, 2n), collect(w.id('dead'))]});
		await w.cycle({a: TO_THE_EXIT});
		await w.withdraw('a');
		const {account} = w.avatars.a;
		const before = await w.balance(account);
		await w.settle('a', 'dead', w.unnamedAccounts[7] as `0x${string}`);
		expect((await w.balance(account)) - before).toEqual(w.stake);
		expect(await w.carried('a')).toEqual(0n);
	});

	it('is shared the same whichever order the reveals arrive in', async () => {
		async function inOrder(order: Who[]) {
			const w = await aBodyBetween(['a', 'b']);
			const body = w.id('dead');
			await w.cycle({a: [move(0n, 2n), collect(body)], b: [move(0n, 2n), collect(body)]}, order);
			await w.quiet();
			await w.settle('a', 'dead');
			await w.settle('b', 'dead');
			return {
				body: await w.body('dead'),
				a: await w.carried('a'),
				b: await w.carried('b'),
			};
		}
		const ab = await inOrder(['a', 'b']);
		const ba = await inOrder(['b', 'a']);
		expect(ba).toEqual(ab);
		expect(ab.body.claimants).toEqual(2);
	});

	it(`keeps a reveal with ${MAX_COLLECTS} collects under the declared reveal gas`, async () => {
		const names = ['d1', 'd2', 'd3'];
		const w = await world([...names, 'a']);
		await w.cycle({...Object.fromEntries(names.map((n) => [n, [enter(0n, 2n)]])), a: [enter(0n, 1n)]});
		const missesAllowed = Number(w.Game.linkedData!.numMissesAllowed);
		for (let i = 0; i < missesAllowed + 1; i++) await w.cycle({a: []});
		const numMoves = Number(w.Game.linkedData!.numMoves);
		const back: Action[] = Array.from({length: numMoves - 1}, (_, i) => move(0n, i % 2 === 0 ? 1n : 2n));
		const receipts = await w.cycle({a: [move(0n, 2n), ...names.map((n) => collect(w.id(n))), ...back]});
		expect(receipts.a.gasUsed < REVEAL_GAS).toEqual(true);
		expect((await w.body('d3')).claimants).toEqual(1);
	});
});
