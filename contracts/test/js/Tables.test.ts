import {expect} from 'earl';
import {describe, it} from 'node:test'; // using node:test as hardhat v3 do not support vitest
import {network} from 'hardhat';
import {parseEventLogs, zeroAddress, type Abi} from 'viem';
import {setupFixtures} from './utils/index.js';
import {commitmentHash, ActionType, type Action} from '../../js/commitment.js';
import {avatarIDFor, purchaseArgs} from '../../js/avatar-id.js';

/**
 * TABLES IN REVEAL-OR-DIE (stratagems' plan, step R1b, R1b-1 to R1b-17).
 *
 * A table is a clone of `GameTableImplementation`, created by
 * `GameTableFactory`, in one of two modes chosen by its options: AVATAR mode,
 * where a seat is an avatar deposited and its stake is the avatar's own, and
 * ETH mode, where a seat is `join()` for the same stake in ETH and the
 * character is the account's. There is no exit: a table ends at its last cycle
 * or as soon as at most one seat is alive, is closed by anyone, and then each
 * survivor takes its stake, what it collected, and its share of the bodies
 * nobody claimed. The dead get nothing.
 */

const {provider, networkHelpers} = await network.connect();
const {deployAll} = setupFixtures(provider);

/**
 * What the world's reveal of 3 collects and 10 moves cost BEFORE the tables
 * (measured on reveal-or-die main 070176ee): the world's routes are
 * byte-identical but for the metadata hash since the tables' `virtual`
 * keywords, and this pins it. THIS REPO'S NUMBER: a descendant whose world
 * differs (bomber-world's bombs) pins its own here.
 */
const WORLD_REVEAL_GAS_BEFORE_TABLES = 560_811n;

const AVATAR_MODE = 0;
const ETH_MODE = 1;

const pos = (x: bigint, y: bigint) => (y << 32n) | x;
const enter = (x: bigint, y: bigint): Action => ({
	actionType: ActionType.Enter,
	data: pos(x, y),
});
const move = (x: bigint, y: bigint): Action => ({
	actionType: ActionType.Move,
	data: pos(x, y),
});
const collect = (body: bigint): Action => ({
	actionType: ActionType.Collect,
	data: body,
});
const exit = (): Action => ({actionType: ActionType.Exit, data: 0n});

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

type Who = string;
type Cycle = {
	cycleNumber: bigint;
	commiting: boolean;
	phaseStart: bigint;
	phaseEnd: bigint;
};

const options = (mode: number) =>
	`0x${mode.toString(16).padStart(64, '0')}` as `0x${string}`;

/**
 * A table of named seats, each an account of its own, the first its creator,
 * every seat taken (not started unless `start` is left true).
 */
async function table(
	mode: number,
	names: Who[],
	params: {
		cycles?: number;
		seats?: number;
		start?: boolean;
		raw?: `0x${string}`;
	} = {},
) {
	const fixture = await networkHelpers.loadFixture(deployAll);
	const {env, AvatarsSale, Avatars, unnamedAccounts} = fixture;
	const Factory = env.get<Abi>('GameTableFactory');
	const Implementation = env.get<Abi>('GameTableImplementation');
	const linked = Factory.linkedData as {
		stake: string;
		numMissesAllowed: string;
	};
	const stake = BigInt(linked.stake);
	const sale = AvatarsSale.linkedData as {
		paymentAmount: string;
		stakeAmount: string;
	};
	const price = BigInt(sale.paymentAmount) + BigInt(sale.stakeAmount);

	const accounts: Record<Who, `0x${string}`> = {};
	for (const [i, name] of names.entries()) {
		accounts[name] = unnamedAccounts[i] as `0x${string}`;
	}
	const creator = accounts[names[0]] ?? (unnamedAccounts[0] as `0x${string}`);
	const receipt = await env.execute(Factory, {
		account: creator,
		functionName: 'createGame',
		args: [
			params.seats ?? Math.max(2, names.length),
			params.cycles ?? 100,
			params.raw ?? options(mode),
		],
	});
	const [created] = parseEventLogs({
		abi: Factory.abi,
		logs: receipt.logs as Parameters<typeof parseEventLogs>[0]['logs'],
		eventName: 'GameCreated',
	}) as unknown as {args: {game: `0x${string}`}}[];
	const Table = {address: created.args.game, abi: Implementation.abi};

	const ids: Record<Who, bigint> = {};
	const secrets: Record<Who, `0x${string}`> = {};
	const id = (name: Who) => ids[name];

	/** Take a seat the mode's way. */
	async function sit(
		name: Who,
		how: 'avatar' | 'eth' = mode === ETH_MODE ? 'eth' : 'avatar',
	) {
		const account = accounts[name];
		if (how === 'eth') {
			await env.execute(Table, {
				account,
				functionName: 'join',
				args: [zeroAddress, 0n],
				value: stake,
			});
			ids[name] = BigInt(account);
		} else {
			await env.execute(AvatarsSale, {
				account,
				functionName: 'purchase',
				args: purchaseArgs({
					gameAddress: Table.address,
					owner: account,
					subID: 0n,
				}),
				value: price,
			});
			ids[name] = avatarIDFor(account, 0n);
		}
		secrets[name] =
			`0x${(names.indexOf(name) + 1).toString(16).padStart(64, '0')}`;
	}

	const read = {
		cycle: async () =>
			(await env.read(Table, {functionName: 'getCycle'})) as Cycle,
		table: async () =>
			(await env.read(Table, {functionName: 'getTable'})) as {
				mode: number;
				stake: bigint;
				started: boolean;
				closed: boolean;
				endCycle: bigint;
				seated: bigint;
				alive: bigint;
				survivors: bigint;
				leftovers: bigint;
				leftoverPot: bigint;
			},
		avatar: async (name: Who) =>
			(await env.read(Table, {
				functionName: 'getAvatar',
				args: [id(name)],
			})) as {
				inGame: boolean;
				life: number;
				position: bigint;
			},
		body: async (name: Who) =>
			(await env.read(Table, {functionName: 'getBody', args: [id(name)]})) as {
				claimants: number;
				released: boolean;
				pot: bigint;
				value: bigint;
			},
		carried: async (name: Who) =>
			(await env.read(Table, {
				functionName: 'getCarried',
				args: [id(name)],
			})) as bigint,
	};

	const balance = async (address: `0x${string}`) =>
		BigInt(
			(await provider.request({
				method: 'eth_getBalance',
				params: [address, 'latest'],
			})) as string,
		);

	async function setTime(time: bigint) {
		const block = (await provider.request({
			method: 'eth_getBlockByNumber',
			params: ['latest', false],
		})) as {timestamp: string};
		const now = BigInt(block.timestamp);
		await provider.request({
			method: 'evm_setNextBlockTimestamp',
			params: [Number(time > now ? time : now + 1n)],
		});
		await provider.request({method: 'evm_mine'});
	}

	/** To the reveal phase if in a commit phase, to the next commit phase otherwise. */
	async function nextPhase() {
		await setTime((await read.cycle()).phaseEnd);
	}

	async function toCommitPhase() {
		if (!(await read.cycle()).commiting) await nextPhase();
	}

	/** One cycle: each named seat commits and reveals its actions, in `order`. */
	async function cycle(turns: Record<Who, Action[]>, order?: Who[]) {
		await toCommitPhase();
		const who = Object.keys(turns);
		for (const name of who) {
			await env.execute(Table, {
				account: accounts[name],
				functionName: 'commit',
				args: [
					id(name),
					commitmentHash(secrets[name], turns[name]),
					zeroAddress,
				],
			});
		}
		await nextPhase();
		const receipts: Record<Who, {gasUsed: unknown}> = {};
		for (const name of order ?? who) {
			receipts[name] = await env.execute(Table, {
				account: accounts[name],
				functionName: 'reveal',
				args: [id(name), turns[name], secrets[name], zeroAddress],
			});
		}
		await nextPhase();
		return receipts;
	}

	/** A cycle with nobody playing, ending in the next commit phase. */
	async function quiet() {
		await toCommitPhase();
		await nextPhase();
		await nextPhase();
	}

	const start = () =>
		env.execute(Table, {account: creator, functionName: 'start'});
	const close = (account?: `0x${string}`) =>
		env.execute(Table, {
			account: account ?? creator,
			functionName: 'closeTable',
		});
	const release = (name: Who, account?: `0x${string}`) =>
		env.execute(Table, {
			account: account ?? creator,
			functionName: 'releaseLeftover',
			args: [id(name)],
		});
	const withdraw = (name: Who) =>
		env.execute(Table, {
			account: accounts[name],
			functionName: 'withdraw',
			args: [id(name), accounts[name]],
		});
	const settle = (collector: Who, body: Who) =>
		env.execute(Table, {
			account: creator,
			functionName: 'settleClaim',
			args: [id(collector), id(body)],
		});

	/** What `name`'s account gained from one transaction, gas put back. */
	async function gained(
		name: Who,
		send: () => Promise<{gasUsed: unknown; effectiveGasPrice: unknown}>,
	) {
		const before = await balance(accounts[name]);
		const receipt = await send();
		const after = await balance(accounts[name]);
		return (
			after -
			before +
			BigInt(receipt.gasUsed as bigint) *
				BigInt(receipt.effectiveGasPrice as bigint)
		);
	}

	const w = {
		...fixture,
		Factory,
		Table,
		stake,
		price,
		accounts,
		creator,
		id,
		sit,
		read,
		balance,
		cycle,
		quiet,
		nextPhase,
		start,
		close,
		release,
		withdraw,
		settle,
		gained,
		Avatars,
		numMissesAllowed: Number(linked.numMissesAllowed),
	};

	if (params.start !== false && names.length > 0) {
		for (const name of names) await sit(name);
		await start();
	}
	return w;
}

/**
 * `dead` enters at (0,2) and goes quiet; the others enter beside it and play
 * empty turns until it is dead (two cycles missed in a row at a table).
 */
async function aBodyAt(mode: number, collectors: Who[], extra: Who[] = []) {
	const w = await table(mode, ['dead', ...collectors, ...extra]);
	const starts: [bigint, bigint][] = [
		[0n, 1n],
		[0n, 3n],
		[0n, 1n],
	];
	await w.cycle({
		dead: [enter(0n, 2n)],
		...Object.fromEntries(collectors.map((c, i) => [c, [enter(...starts[i])]])),
		...Object.fromEntries(extra.map((c) => [c, [enter(1n, 1n)]])),
	});
	for (let i = 0; i < w.numMissesAllowed + 1; i++) {
		await w.cycle(
			Object.fromEntries([...collectors, ...extra].map((c) => [c, []])),
		);
	}
	expect((await w.read.avatar('dead')).life).toEqual(0);
	return w;
}

describe('a table, its mode and its stake', () => {
	it('is refused a seat where its options are read, when they are not a mode', async () => {
		// a mode that does not exist, and a known mode with another byte set
		for (const raw of [options(2), `0x01${'0'.repeat(62)}` as `0x${string}`]) {
			const w = await table(AVATAR_MODE, ['a', 'b'], {start: false, raw});
			await expect(w.sit('a', 'avatar')).toBeRejectedWith(
				'InvalidTableOptions',
			);
			await expect(w.sit('a', 'eth')).toBeRejectedWith('InvalidTableOptions');
		}
	});

	it("takes a seat only the mode's way", async () => {
		const avatars = await table(AVATAR_MODE, ['a', 'b'], {start: false});
		await expect(avatars.sit('a', 'eth')).toBeRejectedWith('WrongTableMode');
		const eth = await table(ETH_MODE, ['a', 'b'], {start: false});
		await expect(eth.sit('a', 'avatar')).toBeRejectedWith('WrongTableMode');
	});

	it("asks every seat to risk exactly the table's stake", async () => {
		const w = await table(AVATAR_MODE, ['a', 'b'], {start: false});
		expect(w.stake > 0n).toEqual(true);
		// an avatar minted with another stake is refused
		const {admin} = w.namedAccounts;
		await w.env.execute(w.Avatars, {
			account: admin,
			functionName: 'setMinter',
			args: [admin],
		});
		await expect(
			w.env.execute(w.Avatars, {
				account: admin,
				functionName: 'mint',
				args: [
					w.Table.address,
					avatarIDFor(admin as `0x${string}`, 7n),
					`0x${(admin as string).slice(2).toLowerCase().padStart(64, '0')}`,
				],
				value: w.stake * 2n,
			}),
		).toBeRejectedWith('TableStakeMismatch');

		const eth = await table(ETH_MODE, ['a', 'b'], {start: false});
		await expect(
			eth.env.execute(eth.Table, {
				account: eth.accounts.a,
				functionName: 'join',
				args: [zeroAddress, 0n],
				value: eth.stake - 1n,
			}),
		).toBeRejectedWith('TableStakeMismatch');
		await eth.sit('a');
		await expect(eth.sit('a')).toBeRejectedWith('AlreadySeated');
	});

	it('forwards a stipend to the key that plays an ETH seat, in the same transaction', async () => {
		const w = await table(ETH_MODE, ['a', 'b'], {start: false});
		const key = w.unnamedAccounts[9] as `0x${string}`;
		const stipend = 12345n;
		// a stipend must be paid for, and must have somewhere to go
		await expect(
			w.env.execute(w.Table, {
				account: w.accounts.a,
				functionName: 'join',
				args: [key, stipend],
				value: w.stake,
			}),
		).toBeRejectedWith('TableStakeMismatch');
		await expect(
			w.env.execute(w.Table, {
				account: w.accounts.a,
				functionName: 'join',
				args: [zeroAddress, stipend],
				value: w.stake + stipend,
			}),
		).toBeRejectedWith('NoStipendRecipient');
		const before = await w.balance(key);
		await w.env.execute(w.Table, {
			account: w.accounts.a,
			functionName: 'join',
			args: [key, stipend],
			value: w.stake + stipend,
		});
		expect((await w.balance(key)) - before).toEqual(stipend);
		// the table keeps exactly the stake
		expect(await w.balance(w.Table.address)).toEqual(w.stake);
		expect((await w.read.table()).seated).toEqual(1n);
	});

	it('lets a seat leave before the start, with its stake, and frees the seat', async () => {
		const w = await table(ETH_MODE, ['a', 'b', 'c'], {start: false, seats: 2});
		await w.sit('a');
		await w.sit('b');
		await expect(w.sit('c')).toBeRejectedWith('GameFull');
		expect(await w.gained('a', () => w.withdraw('a'))).toEqual(w.stake);
		expect((await w.read.table()).seated).toEqual(1n);
		await w.sit('c');
		await w.start();
		await expect(w.withdraw('b')).toBeRejectedWith('TableNotClosed');

		const avatars = await table(AVATAR_MODE, ['a', 'b'], {start: false});
		await avatars.sit('a');
		await avatars.withdraw('a');
		expect(
			(
				(await avatars.env.read(avatars.Avatars, {
					functionName: 'ownerOf',
					args: [avatars.id('a')],
				})) as string
			).toLowerCase(),
		).toEqual(avatars.accounts.a.toLowerCase());
	});
});

describe('playing at a table', () => {
	it('kills a seat that never enters, after the same allowance as one that went quiet', async () => {
		const w = await table(AVATAR_MODE, ['a', 'hiding']);
		await w.cycle({a: [enter(0n, 1n)]});
		expect((await w.read.avatar('hiding')).life).toEqual(1);
		await w.cycle({a: []});
		expect((await w.read.avatar('hiding')).life).toEqual(0);
		// it cannot enter now
		await expect(w.cycle({hiding: [enter(0n, 2n)]})).toBeRejectedWith(
			'AvatarIsDead',
		);
	});

	it('drops an exit', async () => {
		const w = await table(AVATAR_MODE, ['a', 'b']);
		await w.cycle({a: [enter(0n, 2n)], b: [enter(0n, 1n)]});
		await w.cycle({a: TO_THE_EXIT, b: []});
		const a = await w.read.avatar('a');
		expect(a.inGame).toEqual(true);
		expect(a.position).toEqual(pos(3n, 5n));
		await expect(w.withdraw('a')).toBeRejectedWith('TableNotClosed');
	});

	it('shares a body the same whichever order the reveals arrive in', async () => {
		async function inOrder(order: Who[]) {
			const w = await aBodyAt(AVATAR_MODE, ['a', 'b']);
			const body = w.id('dead');
			await w.cycle(
				{a: [move(0n, 2n), collect(body)], b: [move(0n, 2n), collect(body)]},
				order,
			);
			await w.settle('a', 'dead');
			await w.settle('b', 'dead');
			// the cycle numbers are the clock's, which differ between the runs
			const {claimants, released, pot, value} = await w.read.body('dead');
			return {
				body: {claimants, released, pot, value},
				a: await w.read.carried('a'),
				b: await w.read.carried('b'),
			};
		}
		const ab = await inOrder(['a', 'b']);
		const ba = await inOrder(['b', 'a']);
		expect(ba).toEqual(ab);
		expect(ab.body.claimants).toEqual(2);
	});
});

describe('the close', () => {
	it('closes early once at most one seat is alive, and then nobody commits', async () => {
		const w = await table(AVATAR_MODE, ['a', 'b']);
		await w.cycle({a: [enter(0n, 1n)], b: [enter(0n, 2n)]});
		await expect(w.close()).toBeRejectedWith('TableStillPlaying');
		await w.cycle({a: []});
		await w.cycle({a: []});
		expect((await w.read.avatar('b')).life).toEqual(0);
		// not in a reveal phase
		await w.nextPhase();
		await expect(w.close()).toBeRejectedWith('InRevealPhase');
		await w.nextPhase();
		// not while the one alive has committed in this cycle: it reveals first
		const secret = `0x${'ab'.repeat(32)}` as `0x${string}`;
		await w.env.execute(w.Table, {
			account: w.accounts.a,
			functionName: 'commit',
			args: [w.id('a'), commitmentHash(secret, []), zeroAddress],
		});
		await expect(w.close()).toBeRejectedWith('TableCommitmentOpen');
		await w.nextPhase();
		await w.env.execute(w.Table, {
			account: w.accounts.a,
			functionName: 'reveal',
			args: [w.id('a'), [], secret, zeroAddress],
		});
		await w.nextPhase();
		// anyone may close it
		await w.close(w.namedAccounts.deployer as `0x${string}`);
		const state = await w.read.table();
		expect(state.closed).toEqual(true);
		expect(state.survivors).toEqual(1n);
		expect(state.leftovers).toEqual(1n);
		await expect(w.cycle({a: []})).toBeRejectedWith('TableIsClosed');
		await expect(w.close()).toBeRejectedWith('TableIsClosed');
		// the survivor stays one, whatever the clock says now
		await w.quiet();
		await w.quiet();
		expect((await w.read.avatar('a')).life).toEqual(1);
	});

	it('closes after the last cycle with every seat alive then', async () => {
		const w = await table(ETH_MODE, ['a', 'b'], {cycles: 3});
		await w.cycle({a: [enter(0n, 1n)], b: [enter(0n, 2n)]});
		await w.cycle({a: [], b: []});
		await expect(w.close()).toBeRejectedWith('TableStillPlaying');
		await w.cycle({a: [], b: []});
		await w.close();
		const state = await w.read.table();
		expect(state.survivors).toEqual(2n);
		expect(state.leftovers).toEqual(0n);
		expect(await w.gained('a', () => w.withdraw('a'))).toEqual(w.stake);
		expect(await w.gained('b', () => w.withdraw('b'))).toEqual(w.stake);
		await expect(w.withdraw('a')).toBeRejectedWith('NothingToWithdraw');
	});

	it("counts a forfeited member's body as a leftover", async () => {
		const w = await table(ETH_MODE, ['a', 'b', 'gone']);
		await w.cycle({
			a: [enter(0n, 1n)],
			b: [enter(0n, 2n)],
			gone: [enter(0n, 3n)],
		});
		// `gone` stops: the creator forfeits it in a commit phase it has not acted in
		await w.env.execute(w.Table, {
			account: w.creator,
			functionName: 'forfeitMember',
			args: [w.id('gone')],
		});
		await w.cycle({a: [], b: []});
		await w.cycle({a: [], b: []});
		expect((await w.read.avatar('gone')).life).toEqual(0);
		await w.cycle({a: []});
		await w.cycle({a: []});
		await w.close();
		const state = await w.read.table();
		expect(state.survivors).toEqual(1n);
		expect(state.leftovers).toEqual(2n);
		await w.release('gone');
		await w.release('b');
		expect(await w.gained('a', () => w.withdraw('a'))).toEqual(3n * w.stake);
	});
});

describe('the leftovers and the payouts', () => {
	it('pays the survivor in avatar mode: its avatar back, and the dead seat’s stake', async () => {
		const w = await table(AVATAR_MODE, ['a', 'b']);
		await w.cycle({a: [enter(0n, 1n)], b: [enter(0n, 2n)]});
		await w.cycle({a: []});
		await w.cycle({a: []});
		await w.close();
		await expect(w.withdraw('a')).toBeRejectedWith('LeftoversPending');
		await expect(w.release('a')).toBeRejectedWith('NotALeftover');
		await w.release('b');
		await expect(w.release('b')).toBeRejectedWith('NotALeftover');
		// the dead get nothing
		await expect(w.withdraw('b')).toBeRejectedWith('AvatarIsDead');
		expect(await w.gained('a', () => w.withdraw('a'))).toEqual(w.stake);
		expect(
			(
				(await w.env.read(w.Avatars, {
					functionName: 'ownerOf',
					args: [w.id('a')],
				})) as string
			).toLowerCase(),
		).toEqual(w.accounts.a.toLowerCase());
		expect(
			await w.env.read(w.Avatars, {functionName: 'stakeOf', args: [w.id('a')]}),
		).toEqual(w.stake);
		// the dead seat's avatar was burned for its stake
		await expect(
			w.env.read(w.Avatars, {functionName: 'ownerOf', args: [w.id('b')]}),
		).toBeRejected();
		expect(await w.balance(w.Table.address)).toEqual(0n);
	});

	it('pays the survivor in ETH mode twice the stake', async () => {
		const w = await table(ETH_MODE, ['a', 'b']);
		await w.cycle({a: [enter(0n, 1n)], b: [enter(0n, 2n)]});
		await w.cycle({a: []});
		await w.cycle({a: []});
		await w.close();
		await w.release('b');
		await expect(w.withdraw('b')).toBeRejectedWith('AvatarIsDead');
		expect(await w.gained('a', () => w.withdraw('a'))).toEqual(2n * w.stake);
		expect(await w.balance(w.Table.address)).toEqual(0n);
	});

	it('refuses a leftover with claims of its own open, and releases it once they are settled', async () => {
		const w = await aBodyAt(AVATAR_MODE, ['carrier', 's']);
		await w.cycle({carrier: [move(0n, 2n), collect(w.id('dead'))], s: []});
		await w.cycle({s: []});
		await w.cycle({s: []});
		expect((await w.read.avatar('carrier')).life).toEqual(0);
		await w.close();
		const state = await w.read.table();
		// the dead body was claimed, so it is not a leftover; the carrier's is
		expect(state.leftovers).toEqual(1n);
		await expect(w.release('dead')).toBeRejectedWith('NotALeftover');
		await expect(w.release('carrier')).toBeRejectedWith('BodyHasOpenClaims');
		await w.settle('carrier', 'dead');
		await w.release('carrier');
		expect((await w.read.table()).leftoverPot).toEqual(2n * w.stake);
		expect(await w.gained('s', () => w.withdraw('s'))).toEqual(2n * w.stake);
	});

	it('divides the pot among the survivors, and leaves the remainder in the game', async () => {
		const w = await table(ETH_MODE, ['a', 'b', 'c', 'hiding'], {cycles: 3});
		await w.cycle({a: [enter(0n, 1n)], b: [enter(0n, 2n)], c: [enter(0n, 3n)]});
		await w.cycle({a: [], b: [], c: []});
		await w.cycle({a: [], b: [], c: []});
		await w.close();
		const state = await w.read.table();
		expect(state.survivors).toEqual(3n);
		await w.release('hiding');
		const share = w.stake / 3n;
		for (const name of ['a', 'b', 'c']) {
			expect(await w.gained(name, () => w.withdraw(name))).toEqual(
				w.stake + share,
			);
		}
		expect(await w.balance(w.Table.address)).toEqual(w.stake - 3n * share);
	});

	it('returns every leftover to its owner when nobody survives', async () => {
		for (const mode of [AVATAR_MODE, ETH_MODE]) {
			const w = await table(mode, ['a', 'b']);
			await w.quiet();
			await w.quiet();
			expect((await w.read.avatar('a')).life).toEqual(0);
			await w.close();
			expect((await w.read.table()).survivors).toEqual(0n);
			// released by somebody else, so each owner's gain is exactly what it was paid
			const other = w.namedAccounts.deployer as `0x${string}`;
			for (const name of ['a', 'b']) {
				const before = await w.balance(w.accounts[name]);
				await w.release(name, other);
				expect((await w.balance(w.accounts[name])) - before).toEqual(w.stake);
			}
			expect(await w.balance(w.Table.address)).toEqual(0n);
		}
	});
});

describe('the world beside the tables', () => {
	it('reveals at the gas it did before the tables (3 collects and 10 moves)', async () => {
		// The same turn as Loot.test.ts' gas case, on the world: its routes are
		// byte-identical to before R1b but for the metadata hash, and this pins it.
		const fixture = await networkHelpers.loadFixture(deployAll);
		const {
			env,
			Game,
			AvatarsSale,
			unnamedAccounts,
			advanceToCycle,
			advanceToRevealPhase,
			getCycleNumber,
			getTimestamp,
		} = fixture;
		const sale = AvatarsSale.linkedData as {
			paymentAmount: string;
			stakeAmount: string;
		};
		const price = BigInt(sale.paymentAmount) + BigInt(sale.stakeAmount);
		const names = ['d1', 'd2', 'd3', 'a'];
		const av: Record<
			string,
			{account: `0x${string}`; id: bigint; secret: `0x${string}`}
		> = {};
		for (const [i, name] of names.entries()) {
			const account = unnamedAccounts[i] as `0x${string}`;
			await env.execute(AvatarsSale, {
				account,
				functionName: 'purchase',
				args: purchaseArgs({
					gameAddress: Game.address,
					owner: account,
					subID: 0n,
				}),
				value: price,
			});
			av[name] = {
				account,
				id: avatarIDFor(account, 0n),
				secret: `0x${(i + 1).toString(16).padStart(64, '0')}`,
			};
		}
		let {cycleNumber} = getCycleNumber(await getTimestamp());
		async function cycle(turns: Record<string, Action[]>) {
			cycleNumber += 1;
			await advanceToCycle(cycleNumber);
			for (const name of Object.keys(turns)) {
				await env.execute(Game, {
					account: av[name].account,
					functionName: 'commit',
					args: [
						av[name].id,
						commitmentHash(av[name].secret, turns[name]),
						zeroAddress,
					],
				});
			}
			await advanceToRevealPhase(cycleNumber);
			const gas: Record<string, bigint> = {};
			for (const name of Object.keys(turns)) {
				gas[name] = BigInt(
					(
						await env.execute(Game, {
							account: av[name].account,
							functionName: 'reveal',
							args: [av[name].id, turns[name], av[name].secret, zeroAddress],
						})
					).gasUsed,
				);
			}
			return gas;
		}
		await cycle({
			d1: [enter(0n, 2n)],
			d2: [enter(0n, 2n)],
			d3: [enter(0n, 2n)],
			a: [enter(0n, 1n)],
		});
		const missesAllowed = Number(Game.linkedData!.numMissesAllowed);
		for (let i = 0; i < missesAllowed + 2; i++) await cycle({a: []});
		const back: Action[] = Array.from({length: 9}, (_, i) =>
			move(0n, i % 2 === 0 ? 1n : 2n),
		);
		const gas = await cycle({
			a: [
				move(0n, 2n),
				...['d1', 'd2', 'd3'].map((n) => collect(av[n].id)),
				...back,
			],
		});
		expect(gas.a).toEqual(WORLD_REVEAL_GAS_BEFORE_TABLES);
	});
});
