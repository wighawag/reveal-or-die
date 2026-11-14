import {describe, it, expect} from 'vitest';
import {get, writable} from 'svelte/store';
import {
	closable,
	encodeTableMode,
	ETH_MODE,
	AVATAR_MODE,
	leftoversOf,
	revealOrDieLobby,
	seatableHeld,
	seatWanted,
	tableModeOf,
	tableOptions,
	tablePanelOf,
	tableStopsPlay,
	winningsOf,
	isTableGame,
	createWorldTable,
	type SeatOnChain,
	type TableOnChain,
	type WorldTableState,
} from '$lib/world/table';
import {encodeTableOptions} from '$lib/game/lobby/table';
import type {TypedDeployments} from '$lib/deployments-store';

/**
 * Tables in reveal-or-die (stratagems' plan, step R1b, R1b-16): the mode the
 * lobby sends, the record a table is composed with, and every word of the
 * table's part of the HUD.
 */

const STAKE = 100n;
const ME = 7n;
const OTHER = 8n;
const THIRD = 9n;

function tableOf(overrides: Partial<TableOnChain> = {}): TableOnChain {
	return {
		mode: 'eth',
		stake: STAKE,
		started: true,
		closed: false,
		ended: false,
		endCycle: 0,
		seated: 2,
		alive: 2,
		survivors: 0,
		leftovers: 0,
		leftoverPot: 0n,
		...overrides,
	};
}

function seat(id: bigint, overrides: Partial<SeatOnChain> = {}): SeatOnChain {
	return {
		seat: id,
		owner: `0x${id.toString(16).padStart(40, '0')}`,
		inGame: true,
		life: 1,
		claimed: false,
		released: false,
		openClaims: 0,
		...overrides,
	};
}

function loaded(
	table: Partial<TableOnChain>,
	seats: SeatOnChain[],
	carried = 0n,
): WorldTableState {
	return {step: 'Loaded', table: tableOf(table), seats, carried};
}

const panel = (state: WorldTableState, extra: {inCustody?: boolean} = {}) =>
	tablePanelOf({
		state,
		action: {step: 'Idle'},
		seat: ME,
		inCustody: extra.inCustody ?? true,
		format: (v) => v.toString(),
		symbol: 'ETH',
	});

describe("a table's mode", () => {
	it('is the lowest byte of the options, the rest zero', () => {
		expect(encodeTableMode(AVATAR_MODE)).toBe(`0x${'0'.repeat(64)}`);
		expect(encodeTableMode(ETH_MODE)).toBe(`0x${'1'.padStart(64, '0')}`);
		expect(tableModeOf(encodeTableMode(AVATAR_MODE))).toBe('avatar');
		expect(tableModeOf(encodeTableMode(ETH_MODE))).toBe('eth');
		expect(tableModeOf(encodeTableMode(2))).toBeUndefined();
		expect(tableModeOf(`0x01${'0'.repeat(62)}`)).toBeUndefined();
	});

	it('is asked in the lobby as a choice, and said back in words', () => {
		const [field] = tableOptions.fields;
		expect(field.choices?.map((c) => c.value)).toEqual([AVATAR_MODE, ETH_MODE]);
		// a select answers a string, and anything else is the default
		expect(encodeTableOptions(tableOptions, {mode: '1'})).toBe(
			encodeTableMode(ETH_MODE),
		);
		expect(encodeTableOptions(tableOptions, {mode: 5})).toBe(
			encodeTableMode(AVATAR_MODE),
		);
		expect(tableOptions.describe(encodeTableMode(ETH_MODE))[0].value).toMatch(
			/^ETH/,
		);
		expect(tableOptions.describe(encodeTableMode(3))).toEqual([]);
	});
});

describe("a table's record", () => {
	const deployments = {
		chain: {id: 1},
		contracts: {
			Game: {address: '0xaaaa', abi: [{type: 'function', name: 'reveal'}]},
			GameTableImplementation: {
				address: '0xbbbb',
				abi: [{type: 'function', name: 'getTable'}],
				startBlock: 3,
			},
			GameTableFactory: {address: '0xcccc', linkedData: {stake: '100'}},
			Avatars: {address: '0xdddd'},
		},
	} as unknown as TypedDeployments;

	it("is the world's, with the game at the table, its routes and config, from its own block", () => {
		const table = {address: '0x1234' as `0x${string}`, openedAtBlock: 99};
		const records = revealOrDieLobby.deploymentsAt(deployments, table) as any;
		expect(records.contracts.Game.address).toBe('0x1234');
		expect(records.contracts.Game.startBlock).toBe(99);
		expect(records.contracts.Game.linkedData).toEqual({stake: '100'});
		expect(isTableGame(records.contracts.Game)).toBe(true);
		expect(isTableGame((deployments as any).contracts.Game)).toBe(false);
		// everything else is the world's
		expect(records.contracts.Avatars.address).toBe('0xdddd');
		expect(revealOrDieLobby.factory(deployments).address).toBe('0xcccc');
		expect(revealOrDieLobby.implementation(deployments).address).toBe('0xbbbb');
	});
});

describe('the rules the HUD reads', () => {
	it('names the leftovers: the dead nobody claimed, not released', () => {
		expect(
			leftoversOf([
				seat(ME),
				seat(OTHER, {life: 0}),
				seat(THIRD, {life: 0, claimed: true}),
				seat(10n, {life: 0, released: true}),
			]),
		).toEqual([OTHER]);
	});

	it('is closable once started, not closed, and past its end or down to one alive', () => {
		expect(closable(tableOf({alive: 2}))).toBe(false);
		expect(closable(tableOf({alive: 1}))).toBe(true);
		expect(closable(tableOf({alive: 0}))).toBe(true);
		expect(closable(tableOf({alive: 2, ended: true}))).toBe(true);
		expect(closable(tableOf({alive: 1, started: false}))).toBe(false);
		expect(closable(tableOf({alive: 1, closed: true}))).toBe(false);
	});

	it('stops a lone survivor committing empty turns, so the close can be taken', () => {
		expect(tableStopsPlay(undefined)).toBe(false);
		expect(tableStopsPlay({step: 'Unloaded'})).toBe(false);
		expect(tableStopsPlay(loaded({alive: 2}, []))).toBe(false);
		expect(tableStopsPlay(loaded({alive: 1}, []))).toBe(true);
		expect(tableStopsPlay(loaded({closed: true}, []))).toBe(true);
	});

	it('wants a seat only before the start', () => {
		expect(seatWanted({step: 'Unloaded'})).toBe(false);
		expect(seatWanted(loaded({started: false}, []))).toBe(true);
		expect(seatWanted(loaded({started: true}, []))).toBe(false);
	});

	it('pays a survivor its stake in ETH mode, what it carries, and its share of the leftovers', () => {
		const closed = {closed: true, survivors: 2, leftoverPot: 301n};
		expect(winningsOf(loaded(closed, [seat(ME)], 5n), ME)).toBe(
			STAKE + 5n + 150n,
		);
		// in avatar mode the stake is the avatar itself
		expect(
			winningsOf(loaded({...closed, mode: 'avatar'}, [seat(ME)], 5n), ME),
		).toBe(5n + 150n);
		// the dead, an open table, and nobody surviving pay nothing
		expect(
			winningsOf(loaded(closed, [seat(ME, {life: 0})]), ME),
		).toBeUndefined();
		expect(winningsOf(loaded({}, [seat(ME)]), ME)).toBeUndefined();
		expect(
			winningsOf(loaded({closed: true, survivors: 0}, [seat(ME)]), ME),
		).toBeUndefined();
	});

	it('seats a held avatar only before the start, in avatar mode, carrying the stake', () => {
		const held = [
			{avatarID: 1n, stake: STAKE},
			{avatarID: 2n, stake: STAKE + 1n},
		];
		const open = loaded({mode: 'avatar', started: false}, []);
		expect(seatableHeld(open, held)).toEqual([1n]);
		expect(
			seatableHeld(loaded({mode: 'eth', started: false}, []), held),
		).toEqual([]);
		expect(seatableHeld(loaded({mode: 'avatar'}, []), held)).toEqual([]);
	});
});

describe("the table's part of the HUD", () => {
	it('says nothing before the start: the lobby does', () => {
		expect(panel(loaded({started: false}, []))).toBeUndefined();
	});

	it('says how many are alive and that there is no exit, and offers no close while two are', () => {
		const p = panel(loaded({alive: 2}, [seat(ME), seat(OTHER)]))!;
		expect(p.lines[0]).toBe(
			'2 of 2 alive. No exit at a table: it ends at its last cycle, or when at most one is alive.',
		);
		expect(p.close).toBeUndefined();
	});

	it('offers the close once one is alive, and tells the dead they take nothing', () => {
		const p = panel(loaded({alive: 1}, [seat(ME, {life: 0}), seat(OTHER)]))!;
		expect(p.close).toEqual({label: 'Close the table', disabled: false});
		expect(p.lines).toContain(
			'You did not survive: the dead take nothing from a table.',
		);
	});

	it('after the close: the leftovers to release first, then the winnings', () => {
		const state = loaded({closed: true, survivors: 1, alive: 1, leftovers: 1}, [
			seat(ME),
			seat(OTHER, {life: 0}),
		]);
		const before = panel(state)!;
		expect(before.lines).toEqual([
			'The table is closed: 1 survived.',
			'1 body nobody claimed, to release before anyone is paid.',
		]);
		expect(before.release).toEqual({
			label: 'Release the leftovers',
			disabled: false,
		});
		expect(before.winnings?.disabled).toBe(true);

		const after = panel(
			loaded(
				{
					closed: true,
					survivors: 1,
					alive: 1,
					leftovers: 0,
					leftoverPot: STAKE,
				},
				[seat(ME), seat(OTHER, {life: 0, released: true})],
			),
		)!;
		expect(after.release).toBeUndefined();
		expect(after.winnings).toEqual({
			seat: ME,
			label: `Take your winnings: ${2n * STAKE} ETH`,
			disabled: false,
		});
		// once taken, the seat is not in custody any more
		expect(
			panel(
				loaded({closed: true, survivors: 1, leftoverPot: STAKE}, [
					seat(ME),
					seat(OTHER, {life: 0, released: true}),
				]),
				{inCustody: false},
			)!.winnings,
		).toBeUndefined();
	});

	it('says the avatar comes back too in avatar mode', () => {
		const p = panel(
			loaded({mode: 'avatar', closed: true, survivors: 1, leftoverPot: STAKE}, [
				seat(ME),
			]),
		)!;
		expect(p.winnings?.label).toBe(
			`Take your winnings: ${STAKE} ETH, and your avatar`,
		);
	});

	it('says when nobody survived', () => {
		const p = panel(
			loaded({closed: true, survivors: 0, alive: 0}, [seat(ME, {life: 0})]),
		)!;
		expect(p.lines[0]).toBe(
			'The table is closed, and nobody survived: each body nobody claimed goes back to its owner.',
		);
		expect(p.winnings).toBeUndefined();
	});
});

describe('the table store', () => {
	it("reads the table, its seats and the playing seat's carried value", async () => {
		const reads: string[] = [];
		const answers: Record<string, unknown> = {
			getTable: {
				mode: 1,
				stake: STAKE,
				started: true,
				closed: false,
				endCycle: 0n,
				seated: 2n,
				alive: 1n,
				survivors: 0n,
				leftovers: 0n,
				leftoverPot: 0n,
			},
			getSeated: [ME, OTHER],
			getEnd: [10n, 20n, false],
			getCarried: 3n,
		};
		const store = createWorldTable({
			deps: {
				publicClient: {
					readContract: async (request: {
						functionName: string;
						args: bigint[];
					}) => {
						reads.push(request.functionName);
						if (request.functionName === 'getAvatar') {
							return {
								owner: '0x01',
								inGame: true,
								life: request.args[0] === ME ? 1 : 0,
							};
						}
						if (request.functionName === 'getBody') {
							return {firstClaimCycle: 0n, released: false, openClaims: 0n};
						}
						return answers[request.functionName];
					},
				},
			} as never,
			game: {address: '0x0000000000000000000000000000000000000001', abi: []},
			avatars: {address: '0x0000000000000000000000000000000000000002', abi: []},
			seat: writable(ME),
			settleClaimsOf: async () => {},
		});
		await store.update();
		const state = get(store);
		expect(state.step).toBe('Loaded');
		if (state.step !== 'Loaded') return;
		expect(state.table.mode).toBe('eth');
		expect(state.table.alive).toBe(1);
		expect(state.carried).toBe(3n);
		expect(leftoversOf(state.seats)).toEqual([OTHER]);
		expect(closable(state.table)).toBe(true);
	});
});
