import {expect} from 'earl';
import {describe, it} from 'node:test'; // using node:test as hardhat v3 do not support vitest
import {network} from 'hardhat';
import {parseEventLogs, zeroAddress, type Abi} from 'viem';
import {loadAndExecuteDeploymentsFromFiles} from '../../rocketh/environment.js';
import {CYCLE_POLICY} from '../../rocketh/config.js';
import {commitmentHash, ActionType, type Action} from '../../js/commitment.js';
import {avatarIDFor, purchaseArgs} from '../../js/avatar-id.js';

/**
 * A TABLE IN THE OFFLINE WORLD (stratagems' plan, step OT3, OT3-1, OT3-3,
 * OT3-4, OT3-8, OT3-12).
 *
 * The deploy the tab makes, under the `offline` environment itself (its data
 * is the contracts config's `offline` entries, which `web/src/lib/offline.ts`
 * reads), so a table runs the world's clock: the Manual cycle with both
 * durations zero, every phase closed by its members and nobody waiting on a
 * clock. Its seats are taken by the offline rails: in avatar mode the deployer
 * buys each seat's avatar into the table through the sale, as the offline
 * world buys its own; in ETH mode each seat's own account joins, since a
 * seat's id is the caller's address.
 *
 * WHO DIES OFFLINE (OT3-8): under the Manual cycle a phase waits for every
 * living member, so nobody misses a reveal. A seat dies only by never entering
 * (R1b-5's clock) or once its creator forfeits it (its missed cycles then
 * count), and the creator's forfeit is also what stops the cycle waiting for a
 * seat that never entered and can no longer commit.
 */

const {provider, networkHelpers} = await network.connect();

const AVATAR_MODE = 0;
const ETH_MODE = 1;

const pos = (x: bigint, y: bigint) => (y << 32n) | x;
const enter = (x: bigint, y: bigint): Action => ({
	actionType: ActionType.Enter,
	data: pos(x, y),
});

type Who = string;
const options = (mode: number) =>
	`0x${mode.toString(16).padStart(64, '0')}` as `0x${string}`;

async function deployOffline() {
	// `saveDeployments: false`: an `offline` deploy is the tab's, and its records
	// belong in no checkout
	return loadAndExecuteDeploymentsFromFiles({
		provider,
		environment: 'offline',
		saveDeployments: false,
	});
}

/** A table of named seats as the tab seats it, the first its creator, started. */
async function offlineTable(
	mode: number,
	names: Who[],
	params: {cycles?: number} = {},
) {
	const env = await networkHelpers.loadFixture(deployOffline);
	const Factory = env.get<Abi>('GameTableFactory');
	const Implementation = env.get<Abi>('GameTableImplementation');
	const AvatarsSale = env.get<Abi>('AvatarsSale');
	const Avatars = env.get<Abi>('Avatars');
	const stake = BigInt((Factory.linkedData as {stake: string}).stake);
	const sale = AvatarsSale.linkedData as {
		paymentAmount: string;
		stakeAmount: string;
	};
	const price = BigInt(sale.paymentAmount) + BigInt(sale.stakeAmount);
	const deployer = env.namedAccounts.deployer as `0x${string}`;

	const accounts: Record<Who, `0x${string}`> = {};
	for (const [i, name] of names.entries()) {
		accounts[name] = env.unnamedAccounts[i] as `0x${string}`;
	}
	const creator = accounts[names[0]];
	const receipt = await env.execute(Factory, {
		account: creator,
		functionName: 'createGame',
		args: [names.length, params.cycles ?? 2, options(mode)],
	});
	const [created] = parseEventLogs({
		abi: Factory.abi,
		logs: receipt.logs as Parameters<typeof parseEventLogs>[0]['logs'],
		eventName: 'GameCreated',
	}) as unknown as {args: {game: `0x${string}`}}[];
	const Table = {address: created.args.game, abi: Implementation.abi};

	const ids: Record<Who, bigint> = {};
	const id = (name: Who) => ids[name];
	const secret = (name: Who) =>
		`0x${(names.indexOf(name) + 1).toString(16).padStart(64, '0')}` as const;

	// THE OFFLINE RAILS (OT3-3, OT3-4)
	for (const name of names) {
		if (mode === ETH_MODE) {
			await env.execute(Table, {
				account: accounts[name],
				functionName: 'join',
				args: [zeroAddress, 0n],
				value: stake,
			});
			ids[name] = BigInt(accounts[name]);
		} else {
			await env.execute(AvatarsSale, {
				account: deployer,
				functionName: 'purchase',
				args: purchaseArgs({
					gameAddress: Table.address,
					owner: accounts[name],
					subID: 0n,
				}),
				value: price,
			});
			ids[name] = avatarIDFor(accounts[name], 0n);
		}
	}
	await env.execute(Table, {account: creator, functionName: 'start'});

	const read = {
		table: async () =>
			(await env.read(Table, {functionName: 'getTable'})) as {
				mode: number;
				closed: boolean;
				endCycle: bigint;
				alive: bigint;
				survivors: bigint;
				leftovers: bigint;
			},
		avatar: async (name: Who) =>
			(await env.read(Table, {
				functionName: 'getAvatar',
				args: [id(name)],
			})) as {inGame: boolean; life: number},
		config: async () =>
			(await env.read(Table, {functionName: 'getConfig'})) as {
				cyclePolicy: number;
				commitPhaseDuration: bigint;
				revealPhaseDuration: bigint;
			},
	};
	const advance = () =>
		env.execute(Table, {account: deployer, functionName: 'moveToNextPhase'});
	const commit = (name: Who, actions: Action[]) =>
		env.execute(Table, {
			account: accounts[name],
			functionName: 'commit',
			args: [id(name), commitmentHash(secret(name), actions), zeroAddress],
		});
	/** One cycle under the Manual cycle: every named seat commits, the phase is pushed, each reveals, the cycle is pushed. */
	async function cycle(turns: Record<Who, Action[]>) {
		for (const [name, actions] of Object.entries(turns)) {
			await commit(name, actions);
		}
		await advance();
		for (const [name, actions] of Object.entries(turns)) {
			await env.execute(Table, {
				account: accounts[name],
				functionName: 'reveal',
				args: [id(name), actions, secret(name), zeroAddress],
			});
		}
		await advance();
	}
	const balance = async (address: `0x${string}`) =>
		BigInt(
			(await provider.request({
				method: 'eth_getBalance',
				params: [address, 'latest'],
			})) as string,
		);
	async function gained(
		name: Who,
		send: () => Promise<{gasUsed: unknown; effectiveGasPrice: unknown}>,
	) {
		const before = await balance(accounts[name]);
		const receipt = await send();
		return (
			(await balance(accounts[name])) -
			before +
			BigInt(receipt.gasUsed as bigint) *
				BigInt(receipt.effectiveGasPrice as bigint)
		);
	}
	const close = () =>
		env.execute(Table, {account: deployer, functionName: 'closeTable'});
	const release = (name: Who) =>
		env.execute(Table, {
			account: deployer,
			functionName: 'releaseLeftover',
			args: [id(name)],
		});
	const withdraw = (name: Who) =>
		env.execute(Table, {
			account: accounts[name],
			functionName: 'withdraw',
			args: [id(name), accounts[name]],
		});
	const forfeit = (name: Who) =>
		env.execute(Table, {
			account: creator,
			functionName: 'forfeitMember',
			args: [id(name)],
		});
	const releaseDead = (name: Who) =>
		env.execute(Table, {
			account: deployer,
			functionName: 'releaseDeadAvatar',
			args: [id(name)],
		});
	return {
		env,
		Table,
		Avatars,
		stake,
		accounts,
		id,
		read,
		advance,
		commit,
		cycle,
		balance,
		gained,
		close,
		release,
		withdraw,
		forfeit,
		releaseDead,
	};
}

describe('a table in the offline world', () => {
	it('runs the Manual cycle, with both durations zero', async () => {
		const t = await offlineTable(AVATAR_MODE, ['a', 'b']);
		const config = await t.read.config();
		expect(config.cyclePolicy).toEqual(CYCLE_POLICY.Manual);
		expect(config.commitPhaseDuration).toEqual(0n);
		expect(config.revealPhaseDuration).toEqual(0n);
	});

	for (const [mode, label] of [
		[AVATAR_MODE, 'avatar'],
		[ETH_MODE, 'ETH'],
	] as const) {
		it(`in ${label} mode: seated by the offline rails, played to its end by its members, closed and paid`, async () => {
			const t = await offlineTable(mode, ['a', 'b', 'c']);
			await t.cycle({
				a: [enter(0n, 1n)],
				b: [enter(0n, 2n)],
				c: [enter(0n, 3n)],
			});
			await t.cycle({a: [], b: [], c: []});
			// past the last cycle: nothing commits and nothing moves
			await expect(t.commit('a', [])).toBeRejectedWith('GameEnded');
			await expect(t.advance()).toBeRejectedWith('GameEnded');
			await t.close();
			const state = await t.read.table();
			expect(state.closed).toEqual(true);
			expect(state.survivors).toEqual(3n);
			expect(state.leftovers).toEqual(0n);
			for (const name of ['a', 'b', 'c']) {
				expect(await t.gained(name, () => t.withdraw(name))).toEqual(
					mode === ETH_MODE ? t.stake : 0n,
				);
			}
			if (mode === AVATAR_MODE) {
				// each avatar back to its owner, still carrying the stake
				for (const name of ['a', 'b', 'c']) {
					expect(
						(
							(await t.env.read(t.Avatars, {
								functionName: 'ownerOf',
								args: [t.id(name)],
							})) as string
						).toLowerCase(),
					).toEqual(t.accounts[name].toLowerCase());
				}
			}
			expect(await t.balance(t.Table.address)).toEqual(0n);
		});
	}

	it('kills a seat that never enters; once dead it cannot commit, the forfeit stops the cycle waiting for it, and its leftover is shared', async () => {
		const t = await offlineTable(ETH_MODE, ['a', 'b', 'hiding'], {cycles: 5});
		await t.cycle({a: [enter(0n, 1n)], b: [enter(0n, 2n)], hiding: []});
		await t.cycle({a: [], b: [], hiding: []});
		expect((await t.read.avatar('hiding')).life).toEqual(0);
		await expect(t.commit('hiding', [])).toBeRejectedWith('AvatarIsDead');
		await t.commit('a', []);
		await t.commit('b', []);
		await expect(t.advance()).toBeRejectedWith('StillWaitingToCommit');
		// not in custody, so it is no avatar to release
		await expect(t.releaseDead('hiding')).toBeRejectedWith('AvatarNotDead');
		// committed seats cannot be forfeited, an absent one can
		await expect(t.forfeit('a')).toBeRejectedWith('MemberHasActed');
		await t.forfeit('hiding');
		await t.advance();
		await t.env.execute(t.Table, {
			account: t.accounts.a,
			functionName: 'reveal',
			args: [
				t.id('a'),
				[],
				`0x${(1).toString(16).padStart(64, '0')}`,
				zeroAddress,
			],
		});
		await t.env.execute(t.Table, {
			account: t.accounts.b,
			functionName: 'reveal',
			args: [
				t.id('b'),
				[],
				`0x${(2).toString(16).padStart(64, '0')}`,
				zeroAddress,
			],
		});
		await t.advance();
		await t.cycle({a: [], b: []});
		await t.cycle({a: [], b: []});
		await t.close();
		const state = await t.read.table();
		expect(state.survivors).toEqual(2n);
		expect(state.leftovers).toEqual(1n);
		await t.release('hiding');
		for (const name of ['a', 'b']) {
			expect(await t.gained(name, () => t.withdraw(name))).toEqual(
				t.stake + t.stake / 2n,
			);
		}
	});

	it('kills a forfeited seat after its misses, the cycle no longer waiting for it, and a release is not needed', async () => {
		const t = await offlineTable(AVATAR_MODE, ['a', 'b', 'gone'], {cycles: 6});
		await t.cycle({
			a: [enter(0n, 1n)],
			b: [enter(0n, 2n)],
			gone: [enter(0n, 3n)],
		});
		await t.forfeit('gone');
		await t.cycle({a: [], b: []});
		await t.cycle({a: [], b: []});
		expect((await t.read.avatar('gone')).life).toEqual(0);
		// the forfeit already stopped the cycle waiting for it
		await expect(t.releaseDead('gone')).toBeRejectedWith('NotInGame');
		await t.cycle({a: [], b: []});
		await t.cycle({a: [], b: []});
		await t.cycle({a: [], b: []});
		await t.close();
		const state = await t.read.table();
		expect(state.survivors).toEqual(2n);
		expect(state.leftovers).toEqual(1n);
		await t.release('gone');
		for (const name of ['a', 'b']) {
			expect(await t.gained(name, () => t.withdraw(name))).toEqual(
				t.stake / 2n,
			);
		}
	});

	it('closes early once one seat is alive, in a commit phase nobody living committed in', async () => {
		const t = await offlineTable(ETH_MODE, ['a', 'gone'], {cycles: 10});
		await t.cycle({a: [enter(0n, 1n)], gone: [enter(0n, 2n)]});
		await t.forfeit('gone');
		await t.cycle({a: []});
		await t.cycle({a: []});
		expect((await t.read.avatar('gone')).life).toEqual(0);
		expect((await t.read.table()).alive).toEqual(1n);
		await t.close();
		const state = await t.read.table();
		expect(state.closed).toEqual(true);
		expect(state.survivors).toEqual(1n);
		await expect(t.commit('a', [])).toBeRejectedWith('TableIsClosed');
		await t.release('gone');
		expect(await t.gained('a', () => t.withdraw('a'))).toEqual(2n * t.stake);
		expect(await t.balance(t.Table.address)).toEqual(0n);
	});
});
