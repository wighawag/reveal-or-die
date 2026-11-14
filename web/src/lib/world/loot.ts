/**
 * THE BODIES AND WHAT THEY CARRY (step R1a of stratagems' plan; reveal-or-die
 * `work`: `stake-in-the-avatar`).
 *
 * Every avatar carries a fixed stake in ETH, in the Avatars contract, paid out
 * only by burning it. A dead avatar is a body: an avatar standing on it names
 * it in its turn (a Collect action, at most `MAX_COLLECTS` a turn), and the
 * avatars that collect it in the first cycle it is collected in share its
 * stake plus whatever it had collected itself. Each collector pulls its own
 * share once that cycle is over (`settleClaim`, sent from this browser's key,
 * since anyone may); what it collected is paid when the avatar is withdrawn,
 * and the avatar keeps exactly its own stake.
 *
 * What is here is the reading and the deciding; the HUD renders it
 * (`ui/LootPanel.svelte`), and the planning adds the Collects
 * (`planning.collect`).
 */
import {derived, get, writable, type Readable} from 'svelte/store';
import {MAX_COLLECTS, type Position} from 'reveal-or-die-contracts';
import type {CoreServices} from '$lib/context/core';
import {sendMove} from '$lib/game/core/commit-reveal/send';
import type {Abi} from 'viem';

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

/** What `bodiesAt` reads of an avatar on the board. */
export type BoardAvatar = {
	avatarID: bigint;
	inGame: boolean;
	life: number;
	position: Position;
};

/**
 * The bodies lying on `at`: avatars in the world and dead, other than `self`.
 * The contract checks the same (`_collectable`), so a Collect planned from this
 * resolves unless the board was stale.
 */
export function bodiesAt(
	avatars: Iterable<BoardAvatar>,
	at: Position,
	self?: bigint,
): bigint[] {
	const found: bigint[] = [];
	for (const avatar of avatars) {
		if (
			avatar.inGame &&
			avatar.life === 0 &&
			avatar.avatarID !== self &&
			avatar.position.x === at.x &&
			avatar.position.y === at.y
		) {
			found.push(avatar.avatarID);
		}
	}
	return found;
}

/**
 * WHICH BODIES TO NAME when a turn has room for fewer than lie there: a random
 * choice, so that players who reach the same pile tend to name different
 * bodies rather than all splitting the same one (the user, 2026-11-12). The
 * contract does not care which; this is the client's courtesy to its player.
 */
export function chooseBodies(
	bodies: readonly bigint[],
	room: number,
	random: () => number = Math.random,
): bigint[] {
	if (room <= 0) return [];
	if (bodies.length <= room) return [...bodies];
	const pool = [...bodies];
	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[pool[i], pool[j]] = [pool[j], pool[i]];
	}
	return pool.slice(0, room);
}

/** How many more bodies the turn may name, given what is planned already. */
export function collectRoom(plannedCollects: number): number {
	return Math.max(0, MAX_COLLECTS - plannedCollects);
}

/** A claim, as the HUD shows it. */
export type Claim = {
	body: bigint;
	/** The cycle it was made in. */
	cycleNumber: number;
	/** Whether that cycle is over, so the share can be settled. */
	final: boolean;
	/** The body's value: its stake and what it carries, or its pot once released. */
	value: bigint;
	/** How many share it (final only once the cycle is over). */
	claimants: number;
};

/** What a claim is worth to its collector, as far as is known now. */
export function shareOf(claim: Pick<Claim, 'value' | 'claimants'>): bigint {
	return claim.claimants === 0 ? 0n : claim.value / BigInt(claim.claimants);
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export type LootState =
	| {step: 'Unloaded'}
	| {
			step: 'Loaded';
			avatarID: bigint;
			/** What the game holds for the avatar, paid at its withdrawal. */
			carried: bigint;
			claims: readonly Claim[];
	  }
	| {step: 'Error'; message: string};

export type LootAction =
	| {step: 'Idle'}
	| {step: 'Sending'; what: string}
	| {step: 'Failed'; message: string};

export type LootStore = Readable<LootState> & {
	action: Readable<LootAction>;
	/** The avatars the ACCOUNT holds, outside any game, with their stakes. */
	held: Readable<readonly HeldAvatar[]>;
	update(): Promise<void>;
	/** Settle every final claim, the chain of a dead carrier's first. */
	settleAll(): Promise<void>;
	/**
	 * Take an avatar out of the game, which pays what it collected: from the
	 * account, with a wallet prompt, since only the owner may.
	 */
	withdraw(avatarID: bigint): Promise<void>;
	/** Burn an avatar the account holds, for the stake it carries. */
	burn(avatarID: bigint): Promise<void>;
};

/** An avatar the account holds outside the game, and the stake in it. */
export type HeldAvatar = {avatarID: bigint; stake: bigint};

/** How deep a chain of dead carriers is followed before giving up. */
const MAX_CHAIN = 8;
const PAGE = 50n;

type Reader = Pick<CoreServices['publicClient'], 'readContract'>;

type PublicBody = {
	firstClaimCycle: bigint;
	claimants: number;
	released: boolean;
	pot: bigint;
	value: bigint;
	openClaims: bigint;
};

async function openClaimsOf(
	reader: Reader,
	game: {address: `0x${string}`; abi: Abi},
	avatarID: bigint,
): Promise<bigint[]> {
	const bodies: bigint[] = [];
	for (let start = 0n; ; start += PAGE) {
		const [page, total] = (await reader.readContract({
			...game,
			functionName: 'getOpenClaims',
			args: [avatarID, start, PAGE],
		})) as [readonly bigint[], bigint];
		bodies.push(...page);
		if (start + PAGE >= total) return bodies;
	}
}

export function createLoot(params: {
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
	game: {address: `0x${string}`; abi: Abi};
	avatars: {address: `0x${string}`; abi: Abi};
	/** The avatar playing. */
	avatar: Readable<bigint | undefined>;
	/** The cycle the chain is in. */
	cycleNumber: Readable<number>;
}): LootStore {
	const {deps, game} = params;
	const state = writable<LootState>({step: 'Unloaded'});
	const action = writable<LootAction>({step: 'Idle'});
	const held = writable<readonly HeldAvatar[]>([]);

	const read = (functionName: string, args: readonly unknown[]) =>
		deps.publicClient.readContract({...game, functionName, args} as never);

	async function claimsOf(avatarID: bigint): Promise<Claim[]> {
		const cycle = get(params.cycleNumber);
		const bodies = await openClaimsOf(deps.publicClient, game, avatarID);
		return Promise.all(
			bodies.map(async (body) => {
				const [claimedIn, info] = (await Promise.all([
					read('getClaim', [avatarID, body]),
					read('getBody', [body]),
				])) as [bigint, PublicBody];
				return {
					body,
					cycleNumber: Number(claimedIn),
					final: Number(claimedIn) < cycle,
					value: info.value,
					claimants: Number(info.claimants),
				};
			}),
		);
	}

	async function updateHeld() {
		const owner = get(deps.account);
		if (!owner) {
			held.set([]);
			return;
		}
		const ids: bigint[] = [];
		for (let index = 0n; ; index += PAGE) {
			const [page, more] = (await deps.publicClient.readContract({
				...params.avatars,
				functionName: 'tokensOfOwner',
				args: [owner, index, PAGE],
			} as never)) as [readonly bigint[], boolean];
			ids.push(...page);
			if (!more) break;
		}
		const stakes = (await Promise.all(
			ids.map((id) =>
				deps.publicClient.readContract({
					...params.avatars,
					functionName: 'stakeOf',
					args: [id],
				} as never),
			),
		)) as bigint[];
		held.set(ids.map((avatarID, i) => ({avatarID, stake: stakes[i]})));
	}

	async function update() {
		void updateHeld().catch(() => undefined);
		const avatarID = get(params.avatar);
		if (avatarID === undefined) {
			state.set({step: 'Unloaded'});
			return;
		}
		try {
			const [carried, claims] = await Promise.all([
				read('getCarried', [avatarID]) as Promise<bigint>,
				claimsOf(avatarID),
			]);
			if (get(params.avatar) !== avatarID) return;
			state.set({step: 'Loaded', avatarID, carried, claims});
		} catch (error) {
			state.set({step: 'Error', message: messageOf(error)});
		}
	}

	async function send(collector: bigint, body: bigint) {
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
				functionName: 'settleClaim',
				args: [collector, body],
				account: executor.account,
				chain: null,
			},
			'Settling a share of a body',
		);
	}

	/**
	 * Settle `collector`'s claim on `body`, first settling the body's own open
	 * claims if it has any (a dead carrier's), from the bottom of the chain up.
	 * Claims go from a later death to an earlier one, so the chain ends; it is
	 * bounded here anyway.
	 */
	async function settleChain(collector: bigint, body: bigint, depth: number) {
		if (depth > MAX_CHAIN) {
			throw new Error('This body is at the end of a chain too long to settle.');
		}
		const info = (await read('getBody', [body])) as PublicBody;
		if (!info.released && info.openClaims > 0n) {
			const cycle = get(params.cycleNumber);
			for (const held of await openClaimsOf(deps.publicClient, game, body)) {
				const claimedIn = Number(
					(await read('getClaim', [body, held])) as bigint,
				);
				// a claim of the current cycle cannot be settled yet, and neither can
				// this body until it is
				if (claimedIn >= cycle) {
					throw new Error(
						'A body this one collected is still being shared this cycle: try again next cycle.',
					);
				}
				await settleChain(body, held, depth + 1);
			}
		}
		await send(collector, body);
	}

	async function settleAll() {
		const now = get(state);
		if (now.step !== 'Loaded') return;
		const final = now.claims.filter((claim) => claim.final);
		if (final.length === 0) return;
		action.set({step: 'Sending', what: 'Settling your shares'});
		try {
			for (const claim of final) {
				await settleChain(now.avatarID, claim.body, 0);
			}
			action.set({step: 'Idle'});
		} catch (error) {
			action.set({step: 'Failed', message: messageOf(error)});
		}
		await update();
	}

	/** From the account, with a wallet prompt: only the owner may do these. */
	async function fromAccount(what: string, request: Record<string, unknown>) {
		action.set({step: 'Sending', what});
		try {
			await deps.connection.ensureConnected();
			const executor = get(deps.accountExecutor);
			if (executor.status !== 'ready') {
				throw new Error('Connect the wallet that owns this avatar.');
			}
			const hash = await executor.client.writeContract({
				...request,
				account: executor.account,
				chain: null,
			} as never);
			const receipt = await deps.publicClient.waitForTransactionReceipt({
				hash,
			});
			if (receipt.status === 'reverted') {
				throw new Error(`${what} was rejected by the contract`);
			}
			action.set({step: 'Idle'});
		} catch (error) {
			action.set({step: 'Failed', message: messageOf(error)});
		}
		await update();
	}

	return {
		subscribe: state.subscribe,
		action: {subscribe: action.subscribe},
		held: {subscribe: held.subscribe},
		update,
		settleAll,
		withdraw: (avatarID) =>
			fromAccount('Taking the avatar out', {
				...game,
				functionName: 'withdraw',
				args: [avatarID, get(deps.account)],
			}),
		burn: (avatarID) =>
			fromAccount('Burning the avatar for its stake', {
				...params.avatars,
				functionName: 'burn',
				args: [avatarID, '0x'],
			}),
	};
}

// ---------------------------------------------------------------------------
// What the HUD shows
// ---------------------------------------------------------------------------

export type LootModel = {
	/** Shown at all: the avatar is known. */
	visible: boolean;
	carried: bigint;
	/** Final shares, waiting to be settled. */
	settleable: bigint;
	settleableCount: number;
	/** Shares of this cycle's collects, not final yet (an estimate). */
	pending: bigint;
	pendingCount: number;
	busy: boolean;
	error?: string;
};

export function lootModelOf(state: LootState, action: LootAction): LootModel {
	if (state.step !== 'Loaded') {
		return {
			visible: false,
			carried: 0n,
			settleable: 0n,
			settleableCount: 0,
			pending: 0n,
			pendingCount: 0,
			busy: false,
			...(state.step === 'Error' ? {error: state.message} : {}),
		};
	}
	const final = state.claims.filter((claim) => claim.final);
	const open = state.claims.filter((claim) => !claim.final);
	return {
		visible: true,
		carried: state.carried,
		settleable: final.reduce((sum, claim) => sum + shareOf(claim), 0n),
		settleableCount: final.length,
		pending: open.reduce((sum, claim) => sum + shareOf(claim), 0n),
		pendingCount: open.length,
		busy: action.step === 'Sending',
		...(action.step === 'Failed' ? {error: action.message} : {}),
	};
}

export function lootModel(store: LootStore): Readable<LootModel> {
	return derived([store, store.action], ([$state, $action]) =>
		lootModelOf($state, $action),
	);
}

function messageOf(error: unknown): string {
	if (error && typeof error === 'object' && 'shortMessage' in error) {
		return String((error as {shortMessage: unknown}).shortMessage);
	}
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/** What `ui/LootPanel.svelte` renders, every word decided here. */
export type LootPanel = {
	/** Bodies where the plan ends, and whether a Collect can be planned. */
	bodies?: {line: string; canCollect: boolean; collectLabel: string};
	carriedLine?: string;
	settle?: {line: string; label: string; disabled: boolean};
	pendingLine?: string;
	/** Taking the avatar out, when it is out of the world. */
	withdraw?: {label: string; avatarID: bigint; disabled: boolean};
	/** The avatars the account holds, each burnable for its stake. */
	held: readonly {avatarID: bigint; label: string; disabled: boolean}[];
	error?: string;
};

export function lootPanelOf(params: {
	model: LootModel;
	held: readonly HeldAvatar[];
	bodiesHere: readonly bigint[];
	collectsLeft: number;
	canPlan: boolean;
	/** The playing avatar, when it is deposited and out of the world, alive. */
	outOfTheWorld?: bigint;
	symbol: string;
	format: (value: bigint) => string;
}): LootPanel {
	const {model, symbol, format} = params;
	const eth = (value: bigint) => `${format(value)} ${symbol}`;
	const panel: LootPanel = {
		held: params.held.map((avatar) => ({
			avatarID: avatar.avatarID,
			label: `Burn an avatar for its stake, ${eth(avatar.stake)}`,
			disabled: model.busy,
		})),
		...(model.error ? {error: model.error} : {}),
	};
	const count = params.bodiesHere.length;
	if (count > 0) {
		const room = Math.min(count, params.collectsLeft);
		panel.bodies = {
			line:
				count === 1
					? 'A body lies here: collect it to share its stake.'
					: `${count} bodies lie here: collect them to share their stakes.`,
			canCollect: params.canPlan && room > 0,
			collectLabel:
				room > 0
					? `Collect ${room === 1 ? 'it' : `${room}`}`
					: `No more collects this turn (${MAX_COLLECTS} at most)`,
		};
	}
	if (model.carried > 0n) {
		panel.carriedLine = `You carry ${eth(model.carried)}, paid when you take your avatar out.`;
	}
	if (model.settleableCount > 0) {
		panel.settle = {
			line: `${model.settleableCount} share${model.settleableCount === 1 ? '' : 's'} to settle, about ${eth(model.settleable)}.`,
			label: model.busy ? 'Settling...' : 'Settle',
			disabled: model.busy,
		};
	}
	if (model.pendingCount > 0) {
		panel.pendingLine = `${model.pendingCount} body${model.pendingCount === 1 ? '' : ' bodies'} collected this cycle, about ${eth(model.pending)}: final when the cycle ends.`;
	}
	if (params.outOfTheWorld !== undefined) {
		panel.withdraw = {
			avatarID: params.outOfTheWorld,
			label:
				model.carried > 0n
					? `Take your avatar out, with ${eth(model.carried)}`
					: 'Take your avatar out',
			disabled: model.busy,
		};
	}
	return panel;
}
