/**
 * TABLES IN REVEAL-OR-DIE (stratagems' plan, step R1b, R1b-16): a game for a
 * fixed set of seats at an address of its own, created from the lobby, in one
 * of two modes chosen there.
 *
 * - AVATAR MODE: a seat is an avatar, bought straight into the table (the
 *   sale's `purchase` with the table as `to`, which the ordinary purchase does
 *   once the context is at the table) or an avatar the account holds, sent to
 *   it. Its stake is the avatar's own.
 * - ETH MODE: a seat is `join()` for the table's stake in ETH; the character is
 *   the account's, its look generated from its id (the address).
 *
 * There is no exit (`UsingGameTable._exit` drops it, and the planning never
 * offers it here). A table ends at its last cycle or as soon as at most one
 * seat is alive; anyone closes it, anyone releases the bodies nobody claimed
 * (a dead carrier's chain first, from the bottom up), and each survivor takes
 * its winnings: its stake (its avatar, in avatar mode), what it collected, and
 * its share of the leftovers. The dead get nothing.
 *
 * Every rule is the contract's (`contracts/src/game/table/`); this module reads
 * them, sends the transactions, and decides the HUD's words
 * ({@link tablePanelOf}).
 */
import {derived, get, writable, type Readable} from 'svelte/store';
import type {Abi} from 'viem';
import type {TypedDeployments} from '$lib/deployments-store';
import type {CoreServices} from '$lib/context/core';
import type {TableLobby, TableOptions} from '$lib/game/lobby/table';
import {sendMove} from '$lib/game/core/commit-reveal/send';

// ---------------------------------------------------------------------------
// The mode, and the lobby
// ---------------------------------------------------------------------------

/** `gameOptions`' lowest byte, as `UsingGameTable` reads it. */
export const AVATAR_MODE = 0;
export const ETH_MODE = 1;

export type TableMode = 'avatar' | 'eth';

/** The options a table of this mode is created with. */
export function encodeTableMode(mode: number): `0x${string}` {
	return `0x${BigInt(mode).toString(16).padStart(64, '0')}`;
}

/** The mode a table's options name, or undefined when they name none. */
export function tableModeOf(options: `0x${string}`): TableMode | undefined {
	let value: bigint;
	try {
		value = BigInt(options);
	} catch {
		return undefined;
	}
	if (value === BigInt(AVATAR_MODE)) return 'avatar';
	if (value === BigInt(ETH_MODE)) return 'eth';
	return undefined;
}

export const MODE_LABELS: Record<TableMode, string> = {
	avatar: 'Avatars: each seat is an avatar, and risks the stake it carries',
	eth: 'ETH: each seat pays the stake in ETH, and plays a character of its own',
};

export const tableOptions: TableOptions = {
	fields: [
		{
			id: 'mode',
			label: 'Seats are',
			min: AVATAR_MODE,
			max: ETH_MODE,
			default: AVATAR_MODE,
			choices: [
				{value: AVATAR_MODE, label: 'Avatars (each risks its stake)'},
				{value: ETH_MODE, label: 'ETH (a stake a seat, no avatar needed)'},
			],
		},
	],
	encode: (values) => encodeTableMode(values.mode ?? AVATAR_MODE),
	describe(gameOptions) {
		const mode = tableModeOf(gameOptions);
		return mode ? [{label: 'Seats', value: MODE_LABELS[mode]}] : [];
	},
};

/**
 * THIS GAME'S TABLES (`$lib/game/lobby/table`'s `TableLobby`): a table is the
 * world's record with the game at the table's address, the ABI of
 * `GameTableImplementation`, the config `030_deploy_tables.ts` records on the
 * factory, and the block the table was opened in.
 */
export const revealOrDieLobby: TableLobby = {
	factory: (deployments) => deployments.contracts.GameTableFactory,
	implementation: (deployments) =>
		deployments.contracts.GameTableImplementation,
	deploymentsAt(deployments, table) {
		const {contracts} = deployments;
		return {
			...deployments,
			contracts: {
				...contracts,
				Game: {
					...contracts.GameTableImplementation,
					address: table.address,
					startBlock: table.openedAtBlock,
					linkedData: contracts.GameTableFactory.linkedData,
				},
			},
		} as unknown as TypedDeployments;
	},
	options: tableOptions,
};

/**
 * Whether `name` is one of the contracts `030_deploy_tables.ts` deploys, which
 * the offline world does not (an in-tab chain has nobody to invite).
 */
export function isTableContract(name: string): boolean {
	return name.startsWith('GameTable');
}

/** Whether this record's game is a table: only a table's routes have `getTable`. */
export function isTableGame(game: {abi: Abi}): boolean {
	return game.abi.some(
		(item) => item.type === 'function' && item.name === 'getTable',
	);
}

// ---------------------------------------------------------------------------
// What is read
// ---------------------------------------------------------------------------

export type TableOnChain = {
	mode: TableMode | undefined;
	stake: bigint;
	started: boolean;
	closed: boolean;
	/** Past the table's last cycle (the base's `getEnd`). */
	ended: boolean;
	endCycle: number;
	seated: number;
	alive: number;
	survivors: number;
	leftovers: number;
	leftoverPot: bigint;
};

export type SeatOnChain = {
	seat: bigint;
	owner: `0x${string}`;
	inGame: boolean;
	life: number;
	/** Whether a body's first claim has been made: a claimed body is not a leftover. */
	claimed: boolean;
	released: boolean;
	openClaims: number;
};

export type WorldTableState =
	| {step: 'Unloaded'}
	| {
			step: 'Loaded';
			table: TableOnChain;
			seats: readonly SeatOnChain[];
			/** What the game holds for the playing seat, if it is one. */
			carried: bigint;
	  }
	| {step: 'Error'; message: string};

export type WorldTableAction =
	| {step: 'Idle'}
	| {step: 'Sending'; what: string}
	| {step: 'Failed'; message: string};

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

/**
 * The bodies `releaseLeftover` takes: a seat dead at the end cycle (every read
 * after the close is at it) that nobody claimed and that is not released.
 */
export function leftoversOf(seats: readonly SeatOnChain[]): bigint[] {
	return seats
		.filter((s) => s.life === 0 && !s.claimed && !s.released)
		.map((s) => s.seat);
}

/** Whether `closeTable` would be taken now, as far as the reads go. */
export function closable(table: TableOnChain): boolean {
	return table.started && !table.closed && (table.ended || table.alive <= 1);
}

/**
 * Whether the table has nothing left to play: closed, or closable. A lone
 * survivor commits no more empty turns then, which is what lets the close be
 * taken in a commit phase (`TableCommitmentOpen` otherwise).
 */
export function tableStopsPlay(state: WorldTableState | undefined): boolean {
	return (
		state?.step === 'Loaded' && (state.table.closed || closable(state.table))
	);
}

/** Whether a seat is still to be bought or joined: only before the start. */
export function seatWanted(state: WorldTableState | undefined): boolean {
	return state?.step === 'Loaded' && !state.table.started;
}

/**
 * What a survivor takes home: its stake in ETH mode (in avatar mode the avatar
 * itself, which carries its own), what it collected, and its share of the
 * leftovers. Undefined for anybody else.
 */
export function winningsOf(
	state: WorldTableState,
	seat: bigint | undefined,
): bigint | undefined {
	if (state.step !== 'Loaded' || seat === undefined) return undefined;
	const {table} = state;
	if (!table.closed || table.survivors === 0) return undefined;
	const mine = state.seats.find((s) => s.seat === seat);
	if (!mine || mine.life === 0) return undefined;
	return (
		(table.mode === 'eth' ? table.stake : 0n) +
		state.carried +
		table.leftoverPot / BigInt(table.survivors)
	);
}

/** What `ui/TableStatus.svelte` renders, every word decided here. */
export type TablePanel = {
	lines: readonly string[];
	close?: {label: string; disabled: boolean};
	release?: {label: string; disabled: boolean};
	winnings?: {label: string; disabled: boolean; seat: bigint};
	error?: string;
};

export function tablePanelOf(params: {
	state: WorldTableState;
	action: WorldTableAction;
	/** The playing seat, if any. */
	seat: bigint | undefined;
	/** Whether the playing seat is still in the table's custody. */
	inCustody: boolean;
	format: (value: bigint) => string;
	symbol: string;
}): TablePanel | undefined {
	const {state, action, seat, inCustody} = params;
	if (state.step !== 'Loaded' || !state.table.started) return undefined;
	const eth = (value: bigint) => `${params.format(value)} ${params.symbol}`;
	const busy = action.step === 'Sending';
	const {table} = state;
	const panel: {-readonly [K in keyof TablePanel]: TablePanel[K]} = {
		lines: [],
		...(action.step === 'Failed' ? {error: action.message} : {}),
	};
	const lines: string[] = [];
	const mine = state.seats.find((s) => s.seat === seat);

	if (!table.closed) {
		lines.push(
			`${table.alive} of ${table.seated} alive. No exit at a table: it ends at its last cycle, or when at most one is alive.`,
		);
		if (closable(table)) {
			panel.close = {
				label: busy ? 'Closing...' : 'Close the table',
				disabled: busy,
			};
		}
		if (mine && mine.life === 0) {
			lines.push('You did not survive: the dead take nothing from a table.');
		}
	} else {
		lines.push(
			table.survivors === 0
				? 'The table is closed, and nobody survived: each body nobody claimed goes back to its owner.'
				: `The table is closed: ${table.survivors} survived.`,
		);
		const leftovers = leftoversOf(state.seats).length;
		if (leftovers > 0) {
			lines.push(
				`${leftovers} bod${leftovers === 1 ? 'y' : 'ies'} nobody claimed, to release before anyone is paid.`,
			);
			panel.release = {
				label: busy ? 'Releasing...' : 'Release the leftovers',
				disabled: busy,
			};
		}
		if (mine && mine.life === 0) {
			lines.push('You did not survive: the dead take nothing from a table.');
		}
		const winnings = winningsOf(state, seat);
		if (winnings !== undefined && seat !== undefined && inCustody) {
			panel.winnings = {
				seat,
				label: busy
					? 'Taking your winnings...'
					: `Take your winnings: ${eth(winnings)}${table.mode === 'avatar' ? ', and your avatar' : ''}`,
				disabled: busy || leftovers > 0,
			};
		}
	}
	panel.lines = lines;
	return panel;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export type WorldTableStore = Readable<WorldTableState> & {
	action: Readable<WorldTableAction>;
	update(): Promise<void>;
	/** Take an ETH-mode seat, from the account, paying the stake. */
	join(): Promise<void>;
	/** Send an avatar the account holds to an avatar-mode table. */
	seatHeld(avatarID: bigint): Promise<void>;
	close(): Promise<void>;
	/** Release every leftover, each dead carrier's chain settled first. */
	releaseLeftovers(): Promise<void>;
	/** A survivor's winnings, from the account (only the owner may). */
	takeWinnings(seat: bigint): Promise<void>;
	/** Poll while subscribed to: returns the teardown. */
	startPolling(): () => void;
};

type GameContract = {address: `0x${string}`; abi: Abi};

type TableRead = {
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
};

const POLL_MS = 4000;

export function createWorldTable(params: {
	deps: Pick<
		CoreServices,
		| 'publicClient'
		| 'connection'
		| 'signerExecutor'
		| 'accountExecutor'
		| 'deployments'
		| 'signerBalance'
		| 'account'
	>;
	game: GameContract;
	avatars: GameContract;
	/** The seat playing. */
	seat: Readable<bigint | undefined>;
	/**
	 * Settle `body`'s own final open claims, from the bottom of its chain up
	 * (the loot store's), so it can be released.
	 */
	settleClaimsOf: (body: bigint) => Promise<void>;
	/** Called after anything this store sends lands. */
	onChanged?: () => void;
}): WorldTableStore {
	const {deps, game} = params;
	const state = writable<WorldTableState>({step: 'Unloaded'});
	const action = writable<WorldTableAction>({step: 'Idle'});
	const read = (functionName: string, args: readonly unknown[] = []) =>
		deps.publicClient.readContract({...game, functionName, args} as never);

	async function update() {
		try {
			const [table, seatIDs, end] = (await Promise.all([
				read('getTable'),
				read('getSeated'),
				read('getEnd'),
			])) as [TableRead, readonly bigint[], readonly [bigint, bigint, boolean]];
			const seats = await Promise.all(
				seatIDs.map(async (seat) => {
					const [avatar, body] = (await Promise.all([
						read('getAvatar', [seat]),
						read('getBody', [seat]),
					])) as [
						{owner: `0x${string}`; inGame: boolean; life: number},
						{firstClaimCycle: bigint; released: boolean; openClaims: bigint},
					];
					return {
						seat,
						owner: avatar.owner,
						inGame: avatar.inGame,
						life: Number(avatar.life),
						claimed: body.firstClaimCycle !== 0n,
						released: body.released,
						openClaims: Number(body.openClaims),
					} satisfies SeatOnChain;
				}),
			);
			const seat = get(params.seat);
			const carried =
				seat === undefined
					? 0n
					: ((await read('getCarried', [seat])) as bigint);
			state.set({
				step: 'Loaded',
				table: {
					mode: tableModeOf(encodeTableMode(Number(table.mode))),
					stake: table.stake,
					started: table.started,
					closed: table.closed,
					ended: end[2],
					endCycle: Number(table.endCycle),
					seated: Number(table.seated),
					alive: Number(table.alive),
					survivors: Number(table.survivors),
					leftovers: Number(table.leftovers),
					leftoverPot: table.leftoverPot,
				},
				seats,
				carried,
			});
		} catch (error) {
			state.set({step: 'Error', message: messageOf(error)});
		}
	}

	async function run(what: string, send: () => Promise<void>) {
		if (get(action).step === 'Sending') return;
		action.set({step: 'Sending', what});
		try {
			await send();
			action.set({step: 'Idle'});
		} catch (error) {
			action.set({step: 'Failed', message: messageOf(error)});
		}
		await update();
		params.onChanged?.();
	}

	/** From this browser's key: anyone may close and release. */
	async function fromSigner(
		functionName: string,
		args: readonly unknown[],
		label: string,
	) {
		await deps.connection.ensureConnected();
		const executor = get(deps.signerExecutor);
		if (executor.status !== 'ready') {
			throw new Error('No signing key yet: authorise this browser to play.');
		}
		await sendMove(
			deps,
			executor,
			{
				...game,
				functionName,
				args,
				account: executor.account,
				chain: null,
			},
			label,
		);
	}

	/** From the account, with a wallet prompt: what only the owner may do. */
	async function fromAccount(request: Record<string, unknown>, what: string) {
		await deps.connection.ensureConnected();
		const executor = get(deps.accountExecutor);
		if (executor.status !== 'ready') {
			throw new Error('Connect the wallet that holds this seat.');
		}
		const hash = await executor.client.writeContract({
			...request,
			account: executor.account,
			chain: null,
		} as never);
		const receipt = await deps.publicClient.waitForTransactionReceipt({hash});
		if (receipt.status === 'reverted') {
			throw new Error(`${what} was rejected by the contract`);
		}
	}

	async function releaseLeftovers() {
		const now = get(state);
		if (now.step !== 'Loaded') return;
		for (const body of leftoversOf(now.seats)) {
			const seat = now.seats.find((s) => s.seat === body);
			if (seat && seat.openClaims > 0) await params.settleClaimsOf(body);
			await fromSigner(
				'releaseLeftover',
				[body],
				'Releasing a body nobody claimed',
			);
		}
	}

	function startPolling() {
		void update();
		const timer = setInterval(() => void update(), POLL_MS);
		return () => clearInterval(timer);
	}

	return {
		subscribe: state.subscribe,
		action: {subscribe: action.subscribe},
		update,
		join: () =>
			run('Joining the table', async () => {
				const now = get(state);
				if (now.step !== 'Loaded')
					throw new Error('The table is not read yet.');
				await fromAccount(
					{...game, functionName: 'join', args: [], value: now.table.stake},
					'Joining the table',
				);
			}),
		seatHeld: (avatarID) =>
			run('Seating your avatar', () =>
				fromAccount(
					{
						...params.avatars,
						functionName: 'safeTransferFrom',
						args: [get(deps.account), game.address, avatarID],
					},
					'Seating your avatar',
				),
			),
		close: () =>
			run('Closing the table', () =>
				fromSigner('closeTable', [], 'Closing the table'),
			),
		releaseLeftovers: () => run('Releasing the leftovers', releaseLeftovers),
		takeWinnings: (seat) =>
			run('Taking your winnings', () =>
				fromAccount(
					{...game, functionName: 'withdraw', args: [seat, get(deps.account)]},
					'Taking your winnings',
				),
			),
		startPolling,
	};
}

/** The table panel's model, from the stores it reads. */
export function tablePanel(params: {
	table: WorldTableStore;
	seat: Readable<bigint | undefined>;
	inCustody: Readable<boolean>;
	format: (value: bigint) => string;
	symbol: string;
}): Readable<TablePanel | undefined> {
	return derived(
		[params.table, params.table.action, params.seat, params.inCustody],
		([$state, $action, $seat, $inCustody]) =>
			tablePanelOf({
				state: $state,
				action: $action,
				seat: $seat,
				inCustody: $inCustody,
				format: params.format,
				symbol: params.symbol,
			}),
	);
}

function messageOf(error: unknown): string {
	if (error && typeof error === 'object' && 'shortMessage' in error) {
		return String((error as {shortMessage: unknown}).shortMessage);
	}
	return error instanceof Error ? error.message : String(error);
}

/**
 * The avatars the account holds that an avatar-mode table would seat, before
 * its start: those carrying exactly the table's stake (`TableStakeMismatch`
 * otherwise).
 */
export function seatableHeld(
	state: WorldTableState | undefined,
	held: readonly {avatarID: bigint; stake: bigint}[],
): bigint[] {
	if (state?.step !== 'Loaded') return [];
	const {table} = state;
	if (table.started || table.mode !== 'avatar') return [];
	return held.filter((a) => a.stake === table.stake).map((a) => a.avatarID);
}
