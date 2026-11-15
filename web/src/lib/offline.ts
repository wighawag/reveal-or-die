import {get, readable, writable, type Readable} from 'svelte/store';
import {config, extensions} from 'reveal-or-die-contracts/rocketh/config.js';
import deployAvatars from 'reveal-or-die-contracts/deploy/001_deploy_avatars.js';
import deployGame from 'reveal-or-die-contracts/deploy/010_deploy_game.js';
import deploySale from 'reveal-or-die-contracts/deploy/020_deploy_sale.js';
import deployTables from 'reveal-or-die-contracts/deploy/030_deploy_tables.js';
import {
	avatarIDFor,
	purchaseArgs,
	purchaseValue,
} from 'reveal-or-die-contracts';
import {
	createEmbeddedWorld,
	restoreIsCoherent,
	type EmbeddedWorld,
} from '$lib/embedded';
import {mintChainId, rememberChainId} from '$lib/embedded/chain-id';
import {startEmbeddedNode} from '$lib/embedded/node';
import {
	announceEmbeddedWallet,
	type EmbeddedWallet,
} from '$lib/embedded/wallet';
import {embeddedConnectionFactory} from '$lib/embedded/world';
import {offlineWorldNode} from '$lib/offline-node';
import {createIndexedDBDeploymentStore} from '@rocketh/web';
import {createContext, lobby as gameLobby} from '$lib/context/index';
import type {DeploymentsStore} from '$lib/deployments-store';
import {
	createPublicClient,
	createWalletClient,
	custom,
	zeroAddress,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import type {TableChoice} from '$lib/game/lobby/lobby';
import type {ResolvedTable} from '$lib/game/lobby/table';
import {
	offlineSeatLabels,
	offlineTableCreator,
	seatTheOfflineTable,
	type OfflineTableChain,
	type OfflineTableCreator,
} from '$lib/game/lobby/offline-table';
import type {Context} from '$lib/context/types';
import {createOfflinePlayers, type OfflinePlayer} from '$lib/offline-players';
import {
	createPlayedTurnStore,
	RANDOM_LEVEL,
	type AiLevel,
} from '$lib/game/core/strategy';
import {
	WORLD_SEAT_DEFAULT_LEVEL,
	WORLD_SEAT_LEVELS,
	createWorldSeatStrategy,
} from '$lib/world/strategy';
import {WORLD_STORAGE} from '$lib/world/storage';
import {pokeWhenTheHumanActs} from '$lib/game/core/played';
import {seatsPlayedByTheWorld, type Table} from '$lib/game/lobby/seats';
import {authoriseTheBrowsersKey} from '$lib/game/acquire';
import {resolveWorldConfig} from '$lib/world/config';
import {
	closeAndReleaseOnceClosable,
	encodeTableMode,
	tableModeOf,
	type TableMode,
} from '$lib/world/table';
import {expectedContractNames} from '$lib/embedded/deployments';

/**
 * THIS GAME'S OFFLINE WORLD: the composition, which is the half
 * `$lib/embedded` deliberately does not have.
 *
 * `embedded-chain` is the MECHANISM's word and belongs to the framework;
 * `offline` is the EXPERIENCE a player chooses and belongs to the game,
 * exactly as `turn` does. So the framework knows how to boot a chain and run
 * deploy scripts on it, and this file knows WHICH scripts, WHAT the deployment
 * declares, and what a player of THIS game is handed before they start.
 *
 * SAME PATH AS THE TEMPLATE'S, AND DIFFERENT CONTENT, which is a deliberate
 * trade rather than an accident of porting. The content has to diverge - this
 * game's contracts, this game's stake, this game's actions - so the choice is
 * between conflicting at these files forever and modify/delete churn across
 * eight paths forever. `AGENTS.md` already accepts the first bargain for
 * `contracts/`, and it is much the better of the two: a conflict at a file
 * that exists on both sides is a diff a human can read.
 *
 * THE FOUR THINGS IT DECIDES, and each of them is a game's answer rather than
 * the framework's:
 *
 * 1. **The MANUAL cycle policy, with both phase durations zero.** One decision
 *    and not three: the contract refuses a configuration whose durations
 *    disagree with its declared policy. It is the only honest policy for a
 *    chain in a tab, for two independent reasons. A world exists for
 *    single-player and hotseat, where the human decides when a turn ends; and
 *    an automined chain has no clock BETWEEN transactions - a block exists only
 *    where a transaction happened, and every `eth_call` and `eth_estimateGas`
 *    runs at the last mined block's timestamp - so a timed game in the tab
 *    cannot even estimate a reveal after its commit phase closes. See
 *    `work/notes/findings/an-automined-chain-has-no-clock-between-transactions.md`
 *    on the template's `work` branch.
 *
 *    **AND THIS GAME COULD NOT RUN THAT POLICY UNTIL RECENTLY.** Its contract
 *    derived `SKIP_COMMIT` from the same two zero durations, so asking for a
 *    cycle pushed by hand silently asked for a game with NO COMMIT PHASE. That
 *    is fixed (`UsingGameTypes.CyclePolicy`), and it is worth knowing here
 *    because this file is what found it: nothing else in the repo had ever
 *    taken the manual branch.
 *
 * 2. **Everything else unchanged**, by SPREADING the deploy's own `default`
 *    data rather than restating it. `numMoves` and `numMissesAllowed` are
 *    properties of the GAME, not of where the chain runs. Restating them would
 *    be a second copy of a decision, and the spread is load-bearing rather than
 *    tidy: the world's `data` REPLACES the environment's entry wholesale, so a
 *    partial declaration would leave `numMoves` undefined and the client would
 *    refuse to start.
 *
 * 3. **What the player is given**, which here is an AVATAR, bought through the
 *    real sale and minted straight into the game, where it is in custody and
 *    therefore at stake from the moment it exists. Upstream the same hook hands
 *    out a bonded ERC20 reserve; here the player never has a reserve at all,
 *    and what they lose by going quiet is the avatar itself.
 *
 * 4. **Who else is in it**, which is the difference between a commit-reveal
 *    game and a demonstration of one. A cycle with a single waited-for member
 *    hides nothing, so a world enrols at least THREE and plays all but one of
 *    them. HOW MANY is the player's, chosen at the lobby before the world boots
 *    (`$lib/game/lobby`, wired to this world by `$lib/offline-lobby`), and it
 *    arrives here as a TABLE of seats; who is in each seat is
 *    `$lib/game/lobby/seats`, which is framework and shared, and what those
 *    seats DO is `$lib/offline-players`. What is decided here is what each of
 *    them is GIVEN and how this game spells who they are.
 *
 *    WHO THE CYCLE WAITS FOR IS DECIDED BY PROVISIONING ITSELF: under the
 *    manual policy the contract waits for every avatar that enters custody, so
 *    giving each seat its avatar is what makes it a member. Nothing here has to
 *    declare the table, as the template's world does not either.
 *
 * 5. **A TABLE, or the world** (stratagems' plan, step OT3): the lobby offers
 *    this game's tables offline as online (`startOfflineTable`), in either
 *    mode, on the world's chain and its clock. In avatar mode each seat's
 *    avatar is bought into the TABLE through the sale, as the world's is into
 *    the world; in ETH mode each seat's own account joins it, paying the stake,
 *    since a seat's id is the caller's address. Nobody is in the world's
 *    `Game` then. The tab closes the table and releases its leftovers once it
 *    can be closed; the winnings stay the person's to take.
 *
 *    **DEATH AT AN OFFLINE TABLE IS RARE, and that is the rules under the
 *    Manual cycle rather than a defect (OT3-8).** A phase closes only once
 *    every living member has acted, so nobody misses a reveal: a seat dies
 *    only by never entering (the table's clock for that) or once the creator
 *    forfeits it. An offline reveal-or-die table usually ends at its last
 *    cycle with every seat repaid; bomber-world's, whose bombs kill, is the
 *    one with stakes in play.
 *
 * It lives beside `lib/index.ts` rather than in a route, for the reason the
 * mechanism's README gives: this repo deletes the demo routes it inherits, and
 * anything world-building written inside one is thrown away with them.
 */

/**
 * The keys the deploy signs with, and they are PUBLIC AND FIXED on purpose.
 *
 * These are hardhat's well-known development accounts. There is nothing to
 * protect: the chain exists only in this tab, it has no bridge to anywhere, and
 * its ether is a number this file sets with a cheat call. Generating a key per
 * world would buy no security and would cost the one thing that matters here -
 * a world's contract addresses would change between runs, so nothing could be
 * reasoned about or written down.
 *
 * The PLAYER does not use these. They play through the announced wallet (see
 * `lib/embedded/wallet.ts`), which holds its own mnemonic.
 */
const DEPLOYER =
	'0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const DEPLOYER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const ADMIN =
	'0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const ADMIN_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;

/**
 * Where the id of the world in this browser is kept.
 *
 * EXPORTED because the LOBBY is what decides a world is over: changing how
 * many seats are at the table cannot be done to a world that is already
 * provisioned, so the lobby forgets this and the next boot mints a fresh id.
 * The key lives here rather than there because this file is what writes it.
 */
export const CHAIN_ID_STORAGE_KEY = 'offline-world:chain-id';

/**
 * Where the address of the world's TABLE is kept, when the world is a table
 * (`$lib/game/lobby/offline-table`): written as soon as it is created, checked
 * against the chain on every boot after, and forgotten with the world by the
 * lobby, which reads this key off this module. The framework's key, a WIRE
 * from its first build.
 */
export const TABLE_STORAGE_KEY = 'offline-world:table';
const PLAY_MONEY = 10n ** 24n;

/**
 * THE LEVELS THIS WORLD'S SEATS MAY PLAY AT, which the offline lobby offers
 * (it reads this export off the module; see `$lib/offline-lobby`). The game's
 * own (`$lib/world/strategy`): none in reveal-or-die.
 */
export const AI_LEVELS: readonly AiLevel[] | undefined =
	// UNDEFINED, not empty, when the game offers none: a game that offers
	// levels offers `random` among them (offline-lobby.test.ts holds every
	// game to it), and the lobby reads an absent list as no choice.
	WORLD_SEAT_LEVELS.length > 0 ? WORLD_SEAT_LEVELS : undefined;

/**
 * The level a world seat starts at in a fresh lobby choice (`$lib/offline-lobby`
 * reads it off the module): the game's own, `random` when it names none.
 */
export const AI_DEFAULT_LEVEL: string | undefined = WORLD_SEAT_DEFAULT_LEVEL;

/**
 * Where a played seat's decided turn is kept, beside this world's other keys:
 * a storage that lost it has lost the chain id too, and so the world. A WIRE
 * from its first build, like the record it holds (`$lib/game/core/strategy`):
 * the same key the template's reference game uses, because it is the same
 * framework record.
 */
export const PLAYED_TURNS_STORAGE_KEY = 'offline-world:played-turns';

/**
 * WHICH AVATAR AN ADDRESS PLAYS IN THIS WORLD, and it needs no chain read.
 *
 * `AvatarsSale._executeMint` computes the token id as
 * `(uint256(uint160(owner)) << 96) + subID`, so an id is a pure function of the
 * owner and a sub-id this file chooses. A world buys exactly one avatar per
 * seat, so the sub-id is zero and the identity is derivable from the address
 * alone.
 *
 * THE TEMPLATE'S EQUIVALENT HAS TO ASK THE CHAIN, and the difference is worth
 * naming because it looks like a simplification and is actually a property of
 * this game's id scheme. There, an avatar id is whatever the contract assigned,
 * so the only place the answer exists is on chain and `offlineIdentityOf` is
 * async. Here the mint is addressed rather than sequential, which is also why
 * `stakeForOfflinePlayer` below can ask "does this exact id already belong to
 * them" instead of searching a list.
 */
export function offlineIdentityOf(
	player: `0x${string}`,
	/**
	 * The table's mode (stratagems' plan, step OT3, OT3-5); the world plays
	 * avatars. At an ETH-mode table a seat IS its account: its id is the
	 * address (`join`).
	 */
	mode: TableMode = 'avatar',
): bigint {
	return mode === 'eth' ? BigInt(player) : avatarIDFor(player, 0n);
}

/**
 * THE DEPLOYMENT AN OFFLINE GAME IS, as one exported value.
 *
 * Exported rather than inlined below so that the world test can deploy the
 * same thing this file does. What is worth testing about an offline world is
 * not that the mechanism boots - the suites under `test/lib/embedded` already
 * cover that - but that the DATA this game declares produces a deployment this
 * game can actually play, and a test that restated the data would be asserting
 * against its own copy of the decision.
 */
export const OFFLINE_DEPLOYMENT = {
	/**
	 * The environment NAME the deploy runs under, which is what selects the
	 * per-environment data below. Its own rather than `localhost`, so that
	 * changing what an offline game is cannot change what a developer's local
	 * chain is.
	 */
	environment: 'offline',
	scripts: [
		// THE AVATARS COME FIRST, and the order is not cosmetic: the game takes
		// the collection's address in its constructor, and the sale needs both.
		// A world missing the first script deploys a game with no identity to
		// play as, and the failure arrives at the first click rather than at the
		// deploy.
		{id: '001_deploy_avatars', module: deployAvatars},
		{id: '010_deploy_game', module: deployGame},
		{id: '020_deploy_sale', module: deploySale},
		// THE TABLES, which an offline world plays too (`startOfflineTable`):
		// the factory and the implementation every table is a clone of.
		{id: '030_deploy_tables', module: deployTables},
	],
	/**
	 * What the in-tab deployment declares: the contracts config's own
	 * `offline` entries, the Manual cycle with both durations zero and
	 * everything else SPREAD FROM THE DEPLOY'S `default` (see point 2 on this
	 * module for why the rest must not be restated). There rather than here so
	 * that a contract test deploying under the `offline` environment deploys
	 * exactly this (`contracts/test/js/OfflineTables.test.ts`). The tables run
	 * the world's clock, for the world's reason (point 1).
	 */
	data: {
		Game: {...config.data.Game.offline},
		Table: {...config.data.Table.offline},
		sale: {...config.data.sale.default},
	},
	accounts: {deployer: DEPLOYER, admin: ADMIN},
	initialBalances: {
		[DEPLOYER_ADDRESS]: PLAY_MONEY,
		[ADMIN_ADDRESS]: PLAY_MONEY,
	},
	/** What must exist afterwards: everything the app was built against. */
	expectedContracts: expectedContractNames(),
} as const;

export type OfflineWorldStatus =
	| {step: 'Idle'}
	| {step: 'Booting'; what: string}
	| {
			step: 'Ready';
			world: EmbeddedWorld;
			context: {context: Context; start: () => () => void};
	  }
	| {step: 'Failed'; error: string};

const status = writable<OfflineWorldStatus>({step: 'Idle'});

/** What the page renders. */
export const offlineWorld: Readable<OfflineWorldStatus> = {
	subscribe: status.subscribe,
};

/**
 * APP-SCOPED AND LAZY, and the lifetime is the decision rather than the
 * laziness.
 *
 * Lazy because nothing may happen at import time: this module reaches for
 * IndexedDB-shaped things and announces a wallet on `window`, and the app
 * prerenders (ADR-0002). Nothing here runs until a page asks.
 *
 * App-scoped because a world is STATE, not a view. Route-scoped would boot a
 * fresh chain on every navigation, so visiting another page and coming back
 * would be a new game - the player's own chain, thrown away by the router.
 */
let pending: Promise<OfflineWorldStatus> | undefined;

export function startOfflineWorld(params: {
	/**
	 * Everyone this world will wait for, chosen at the lobby before anything
	 * booted. A world that is already building keeps the table it was started
	 * with: membership is provisioned once and cannot be changed afterwards
	 * without staking or withdrawing members mid-cycle.
	 */
	table: Table;
}): Promise<OfflineWorldStatus> {
	return boot(params.table, undefined);
}

/**
 * A TABLE IN THIS WORLD (stratagems' plan, step OT3): a game for the seats
 * chosen, in the mode chosen, created by the person's account, every seat
 * taken at it, started by the tab, ended after `cycles`. Read by the
 * byte-identical lobby off this module (`$lib/offline-lobby`): exporting it is
 * what offers a table offline, and a game with online tables must
 * (`test/offline-tables-boundary.test.ts`). The world's own `Game` is deployed
 * beside it, and nobody is in it.
 */
export function startOfflineTable(
	choice: TableChoice,
): Promise<OfflineWorldStatus> {
	return boot(choice.table, {
		cycles: choice.cycles,
		gameOptions: choice.gameOptions,
	});
}

/** What a table is created with: see `startOfflineTable`. */
type TableAt = {cycles: number; gameOptions: `0x${string}`};

function boot(
	table: Table,
	at: TableAt | undefined,
): Promise<OfflineWorldStatus> {
	if (!pending) {
		pending = buildOfflineWorld(table, at).catch((err) => {
			// The promise is dropped so a retry is possible: a failed boot is
			// usually a missing dependency or a deploy script throwing, and both
			// are things a developer fixes and reloads into.
			pending = undefined;
			const failure: OfflineWorldStatus = {
				step: 'Failed',
				error: err instanceof Error ? err.message : String(err),
			};
			status.set(failure);
			return failure;
		});
	}
	return pending;
}

async function buildOfflineWorld(
	table: Table,
	at?: TableAt,
): Promise<OfflineWorldStatus> {
	// The id is minted once and remembered, because it is what keys everything
	// the player keeps: the operations ledger, and this game's submission
	// storage (`world/storage.ts` keys by chain and game). See
	// `lib/embedded/chain-id.ts`.
	const chainId = rememberChainId({
		storage: localStorage,
		key: CHAIN_ID_STORAGE_KEY,
	});

	const world = await openWorld(chainId, table, at);

	/**
	 * WHERE THE GAME IS: the world's `Game`, or the world's TABLE. At a table
	 * everything below is composed on the table's record (the lobby's
	 * `deploymentsAt`, the game at the table's address), so the context, the
	 * played seats and their strategy all play the table; the world's own
	 * `Game` stands beside it, and nobody is in it.
	 */
	let records: DeploymentsStore = world.deployments;
	let establishConnection = world.establishConnection;
	let resolved: ResolvedTable | undefined;
	let mode: TableMode = 'avatar';
	if (at) {
		const opened = await openTheTable(world, table, at);
		if (opened.kind === 'incoherent') {
			// A RECORD THE CHAIN DOES NOT HOLD is refused as an incoherent restore
			// is: a new world under a new id, the old one orphaned (OT1-3).
			console.warn(`the offline world's table was refused: ${opened.reason}`);
			stopAnnouncingOfflineWallet();
			await world.dispose();
			status.set({step: 'Booting', what: 'starting a new world'});
			localStorage.setItem(CHAIN_ID_STORAGE_KEY, String(mintChainId()));
			localStorage.removeItem(TABLE_STORAGE_KEY);
			return buildOfflineWorld(table, at);
		}
		resolved = opened.table;
		mode = opened.mode;
		const atTable = gameLobby!.deploymentsAt(world.deployments.get(), resolved);
		records = {...readable(atTable), get: () => atTable} as DeploymentsStore;
		establishConnection = embeddedConnectionFactory({
			chainId: world.chainId,
			node: {provider: world.provider},
			deployments: records,
			wallets: announcedWallet ? [announcedWallet.handle] : undefined,
		});
	}

	status.set({step: 'Booting', what: 'connecting'});

	// SYNCHRONOUS, AND AFTER THE WORLD, which is the shape the whole design
	// turns on. The context cannot be built first and filled in: it reads a
	// contract address out of `deployments` while constructing, to scope the
	// operations ledger, and before the deploy there is no address to give it.
	// ADR-0002 is untouched - the app-level context in `+layout.svelte` is still
	// built synchronously during prerender, because that one is the remote
	// world.
	const context = createContext({
		establishConnection,
		// AT A TABLE the context is the table's, with its roster and its
		// creator's powers, its seats named as the lobby named them.
		...(resolved
			? {
					table: resolved,
					seatLabels: await offlineSeatLabels({
						table,
						accounts: announcedWallet?.accounts,
						identityOf: (player) => offlineIdentityOf(player, mode),
					}),
				}
			: {}),
	});

	// Dev/debug: the world on the console, beside the `context` handle `core.ts`
	// installs. Worth having for a world specifically, because the only way to
	// look at a chain in a tab is to hold it: there is no RPC url to curl, no
	// explorer, and no second process that can see it.
	if (typeof window !== 'undefined') {
		try {
			(globalThis as unknown as Record<string, unknown>).offlineWorld = {
				world,
				context: context.context,
			};
		} catch {
			// A console convenience is never worth failing a boot for.
		}
	}

	/**
	 * AND IT CONNECTS ITSELF, which is not something an online world may do and
	 * is the only honest behaviour here.
	 *
	 * Connecting is normally the player's decision because it is a question: WHICH
	 * wallet, which account, and do you want this site to see it. A world that
	 * brought its own wallet has already answered all three - there is one wallet,
	 * it holds one account, it signs without asking, and it exists nowhere but
	 * this tab. So a "Connect" button here would be a button with one option that
	 * discloses nothing to nobody.
	 *
	 * NOT FATAL IF IT FAILS. The world, the chain and the deploy are all fine
	 * without a connection; what the player loses is the ability to send, and the
	 * game already says so through the setup gate. Failing the boot instead would
	 * throw away a chain over a recoverable step.
	 */
	try {
		await connectOfflinePlayer(context.context.connection);
	} catch (err) {
		console.error('the offline world could not connect its own wallet', err);
	}

	/**
	 * AND IT AUTHORISES THE KEY THIS BROWSER PLAYS WITH, which is the last thing
	 * standing between a player and the board.
	 *
	 * HERE rather than in provisioning, and that is the whole reason this step
	 * could not simply be moved. The signer is derived in the tab from the
	 * SIGNATURE the line above just asked for, so at provisioning time it does
	 * not exist and has no address to register; after sign-in it does.
	 *
	 * NOT FATAL. If it fails the game's own setup gate comes back with the
	 * button on it, which is exactly the remedy a player would have had anyway.
	 */
	status.set({step: 'Booting', what: "authorising this browser's key"});
	try {
		await authoriseTheBrowsersKey(context.context);
	} catch (err) {
		console.error(
			"the offline world could not authorise this browser's key",
			err,
		);
	}

	/**
	 * AND GIVES THAT KEY PLAY MONEY, the same as every other seat.
	 *
	 * The authorisation funds it with ONE TOP-UP, which is the online amount and
	 * the wrong one here. Offline the key pays for more than the player's turns:
	 * it also pushes the manual cycle forward twice a cycle, which nothing online
	 * asks of it. Measured (bomber-world, 2026-09-27): four seats froze at cycle
	 * 16 with every commitment in and nobody able to open the reveal phase,
	 * because the only client that pushes had "Not enough gas to send this move".
	 *
	 * Gas is free here (see the note on refills in provisioning), so this is set
	 * on every boot, restore included, and a world never runs dry.
	 */
	try {
		const signer = get(context.context.signerExecutor);
		if (signer.status === 'ready') {
			await world.provider.request({
				method: 'evm_setBalance',
				params: [signer.address, `0x${PLAY_MONEY.toString(16)}`],
			} as never);
		}
	} catch (err) {
		console.error("the offline world could not fund this browser's key", err);
	}

	/**
	 * THE OTHER PLAYERS, STARTED WITH THE BOARD AND STOPPED WITH IT.
	 *
	 * Wrapped around the context's own `start` rather than started here, so that
	 * their lifetime is exactly the human's advance client's: both spend the
	 * world's gas to keep a cycle turning, and neither has any business doing so
	 * while nothing is on screen. The WORLD still outlives the page (the chain
	 * is not disposed when a router navigates away); what stops is the playing.
	 */
	const played = withLevels(playedByTheWorld(table, mode), table);
	const players = createOfflinePlayers({
		provider: world.provider,
		deployments: records,
		config: resolveWorldConfig(records.get()),
		players: played,
		// A SEAT WITH A LEVEL decides its turn with the game's strategy and
		// keeps it in this world's storage (see `PLAYED_TURNS_STORAGE_KEY`).
		...(played.some((seat) => (seat.level ?? RANDOM_LEVEL) !== RANDOM_LEVEL)
			? {
					createStrategy: createWorldSeatStrategy,
					turns: createPlayedTurnStore({
						storage: localStorage,
						key: PLAYED_TURNS_STORAGE_KEY,
						chainId: records.get().chain.id,
						contract: records.get().contracts.Game.address,
						format: WORLD_STORAGE,
					}),
				}
			: {}),
		// A played commit can complete unanimity just as the human's can, and the
		// advance client would otherwise find out on its own one-second poll.
		onActed: () => void context.context.game.cycleAdvance.check(),
	});

	const ready: OfflineWorldStatus = {
		step: 'Ready',
		world,
		context: {
			context: context.context,
			start: () => {
				const stopContext = context.start();
				const stopPlayers = players.start();
				// AT A TABLE, ITS END BY THE TAB (OT3-7): closed once it can be,
				// its leftovers released, through the HUD's own calls.
				const worldTable = context.context.game.worldTable;
				const stopClosing = worldTable
					? closeAndReleaseOnceClosable(worldTable)
					: () => {};
				const stopPoke = pokeWhenTheHumanActs({
					loop: players,
					submission: context.context.game.submission,
				});
				return () => {
					stopClosing();
					stopPoke();
					stopPlayers();
					stopContext();
				};
			},
		},
	};
	status.set(ready);
	return ready;
}

/**
 * Boot (or restore) the world for one chain id.
 *
 * PERSISTED BY DEFAULT, which is the answer to "should an offline game come
 * back when you reload". Yes, and it costs nothing to say so: webevm dumps its
 * state to IndexedDB and `@rocketh/web` keeps the deployment records the same
 * way, so a reload restores the chain AND skips the deploy rather than building
 * a second game beside the first. Both are namespaced by the chain id, so two
 * worlds never share a database.
 */
async function openWorld(
	chainId: number,
	table: Table,
	at: TableAt | undefined,
): Promise<EmbeddedWorld> {
	status.set({step: 'Booting', what: 'starting a chain in this tab'});

	const deploymentStore = await createIndexedDBDeploymentStore({
		db: `offline-world-deployments:${chainId}`,
	});

	// THE RESTORE IS CHECKED BEFORE ANYTHING IS DEPLOYED. Three stores persist
	// independently and nothing makes them atomic; records that outlive their
	// chain make rocketh skip a deploy it believes it has done, and the script
	// then reads a contract that is not there. Asking afterwards is too late -
	// the boot throws first, which is how this was found.
	//
	// A NEW ID rather than a repair. Everything the player kept is keyed by the
	// chain id, so reusing it would mix records describing a chain that no
	// longer exists into one that does. Minting orphans them instead, which is
	// what they are.
	//
	// THE PROBE RUNS WHERE THE WORLD'S NODE WILL (a Worker, in a browser), so
	// loading the dump does not stall the page either, and it is GONE before
	// the real node opens the same database: disposed, every request it was
	// sent settled, and its Worker terminated (`released`). It only reads, so
	// nothing of it could be saved over the real node's chain anyway; waiting
	// is what makes that a fact rather than an argument. See `$lib/offline-node`.
	const db = `offline-world-chain:${chainId}`;
	const probeNode = offlineWorldNode({db});
	const probe = await startEmbeddedNode({
		chainId,
		createNode: probeNode.createNode,
		persistence: probeNode.persistence,
	});
	const coherent = await restoreIsCoherent({
		provider: probe.provider,
		vfs: deploymentStore.vfs,
	}).finally(() => probe.dispose());
	await probeNode.released();
	if (!coherent) {
		status.set({step: 'Booting', what: 'starting a new world'});
		const fresh = mintChainId();
		localStorage.setItem(CHAIN_ID_STORAGE_KEY, String(fresh));
		return openWorld(fresh, table, at);
	}

	const worldNode = offlineWorldNode({db});
	return createEmbeddedWorld({
		chainId,
		chain: {
			name: 'Offline',
			nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
			properties: {
				// THE LOCAL CHAIN'S OWN PROPERTIES, read out of the deploy config
				// rather than typed again: `expectedWorstGasPrice` is what sizes the
				// stipend the purchase forwards to the play key, and a second copy of
				// it is a number that can drift into funding nobody.
				...config.chains[31337].properties,
				// A block exists only where a transaction happened, so a "block time"
				// here measures how long the player thought about their move. One
				// second is the honest floor to give anything that polls, and under
				// the manual policy nothing reads it for a deadline.
				averageBlockTimeMs: 1000,
				// ZERO CONFIRMATIONS, and it is the honest number rather than a
				// workaround. Under automine a block exists only where a transaction
				// happened, so the NEWEST transaction is always in the latest block
				// and a confirmation above it never arrives: the operations ledger
				// would hold every move as `final: false` forever. Confirmations buy
				// protection from a REORG, and a chain in one tab has no competing
				// producer to reorg it.
				finality: 0,
			},
		},
		rocketh: {config, extensions},
		environment: OFFLINE_DEPLOYMENT.environment,
		scripts: [...OFFLINE_DEPLOYMENT.scripts],
		data: {...OFFLINE_DEPLOYMENT.data},
		accounts: {...OFFLINE_DEPLOYMENT.accounts},
		expectedContracts: [...OFFLINE_DEPLOYMENT.expectedContracts],
		initialBalances: {...OFFLINE_DEPLOYMENT.initialBalances},
		// IN A WORKER whenever there is one, with its IndexedDB persistence built
		// inside it; on this thread otherwise. See `$lib/offline-node`.
		createNode: worldNode.createNode,
		persistence: worldNode.persistence,
		deploymentStore,
		provision: (params) =>
			provisionOfflinePlayer({...params, chainId, table, atTable: !!at}),
	});
}

/** The world's chain as viem wants it, for the clients the world's own loops build. */
function worldChain(world: Pick<EmbeddedWorld, 'deployments'>) {
	const records = world.deployments.get();
	return {
		id: records.chain.id,
		name: records.chain.name,
		nativeCurrency: records.chain.nativeCurrency,
		rpcUrls: {default: {http: [] as string[]}},
	};
}

/**
 * THE WORLD'S TABLE, set up (stratagems' plan, step OT3): created by the
 * person's account through the world's own wallet, unless its record (or the
 * factory) has it; every seat taken at it, unless it is; started, unless it
 * has (`$lib/game/lobby/offline-table`'s `seatTheOfflineTable`, around this
 * game's own seating). Each step asks the chain, so a reload or an interrupted
 * boot repeats nothing. Answers the table's mode with it, read off the chain.
 */
async function openTheTable(world: EmbeddedWorld, table: Table, at: TableAt) {
	const wallet = announcedWallet;
	if (!wallet || !gameLobby) {
		throw new Error('an offline table needs the world’s wallet and tables');
	}
	const records = world.deployments.get();
	const chain = worldChain(world);
	const reader = createPublicClient({
		chain,
		transport: custom(world.provider as never),
	});
	const creator = offlineTableCreator(wallet, chain);
	const opened = await seatTheOfflineTable({
		reader: reader as never,
		creator,
		factory: gameLobby.factory(records).address,
		implementation: gameLobby.implementation(records).address,
		storage: localStorage,
		storageKey: TABLE_STORAGE_KEY,
		seats: table.length,
		cycles: at.cycles,
		gameOptions: at.gameOptions,
		stake: (resolved) =>
			stakeForEveryoneAtTheTable({
				env: world.env,
				provider: world.provider,
				chain,
				table: resolved.address,
				you: creator,
				seats: table,
			}),
		onStep: (what) => status.set({step: 'Booting', what}),
	});
	if (opened.kind !== 'table') return opened;
	return {
		...opened,
		mode: await tableModeAt(world.env, opened.table.address),
	};
}

/** A table's mode, as its routes read it (`getTable`). Avatars when unread. */
async function tableModeAt(
	env: EmbeddedWorld['env'],
	table: `0x${string}`,
): Promise<TableMode> {
	const e = env as unknown as {
		get: (name: string) => {abi: unknown};
		read: (deployment: never, args: unknown) => Promise<unknown>;
	};
	const state = (await e.read(
		{address: table, abi: e.get('GameTableImplementation').abi} as never,
		{functionName: 'getTable'},
	)) as {mode: number};
	return tableModeOf(encodeTableMode(Number(state.mode))) ?? 'avatar';
}

let announced: (() => void) | undefined;
/** The wallet provisioning announced: a table's creator sends through it. */
let announcedWallet: EmbeddedWallet | undefined;

/**
 * WHAT AN OFFLINE PLAYER OF THIS GAME IS GIVEN, which is the seam's whole
 * content and is this game's answer rather than the framework's.
 *
 * Three things, and the order matters because each needs the one before it:
 *
 * 1. **A wallet.** The world brings its own, so the player is never asked to
 *    pick one - and cannot pick one that has no account on this chain, which is
 *    every other wallet they own.
 * 2. **Gas**, by cheat call. The chain is in the tab; its ether is a number.
 * 3. **AN AVATAR**, which is what this game puts at risk and therefore the only
 *    reason anybody here has to reveal. Bought through `AvatarsSale.purchase`,
 *    the same rail the online purchase uses, rather than by minting and
 *    depositing by hand: the rail mints it straight into the game contract, so
 *    the offline world exercises the path the online one depends on instead of
 *    a private shortcut that could quietly stop matching it.
 * 4. **EVERYONE ELSE AT THE TABLE**, which is the same three things over again
 *    and is not a courtesy: what makes a player worth waiting for is having
 *    something to lose, and here that is custody of the avatar. They are given
 *    exactly what the human is given and nothing more, so what the world can
 *    do, the human can do.
 *
 * IT DOES NOT AUTHORISE THE BROWSER'S KEY, because it cannot: the signer is
 * derived in the tab from a wallet signature AFTER this runs and after the
 * context exists at all, so provisioning has no address to register. The world
 * does it later, in the step that asks for that signature.
 */
async function provisionOfflinePlayer(params: {
	env: EmbeddedWorld['env'];
	node: {provider: {request: (args: never) => Promise<unknown>}};
	chainId: number;
	table: Table;
	/**
	 * Whether the world is a TABLE: then nobody is staked in the world's
	 * `Game`, and every seat is taken at the table once it exists (after the
	 * deploy, `openTheTable`).
	 */
	atTable: boolean;
}) {
	const {env, node, table} = params;

	status.set({step: 'Booting', what: 'handing the player a wallet'});
	const wallet = await announceEmbeddedWallet({
		provider: node.provider as never,
		chainId: params.chainId,
	});
	announced = wallet.cleanup;
	announcedWallet = wallet;

	// GAS IS FREE HERE AND THE AVATAR IS NOT, which is the one asymmetry in this
	// function and it is deliberate. This runs on EVERY boot, including a
	// restore, so a balance set unconditionally is a refill on every reload -
	// and that is the right answer for gas, which is a number on a chain in a
	// tab and is not what anybody is risking. The avatar is the opposite case:
	// it is what this game puts AT STAKE, so handing out another one on reload
	// would make a lost avatar cost nothing, and a stake that can be replaced by
	// pressing F5 is not a stake.
	for (const account of wallet.accounts) {
		await node.provider.request({
			method: 'evm_setBalance',
			params: [account, `0x${PLAY_MONEY.toString(16)}`],
		} as never);
	}

	// GAS FOR EVERY SEAT THE WORLD PLAYS, on the same terms and for the same
	// reason: it is a number on a chain in a tab, and a player who cannot pay
	// for a commit freezes the cycle for the human rather than for itself.
	for (const played of seatsPlayedByTheWorld(table)) {
		await node.provider.request({
			method: 'evm_setBalance',
			params: [played.address, `0x${PLAY_MONEY.toString(16)}`],
		} as never);
	}

	if (!params.atTable) {
		status.set({step: 'Booting', what: 'buying an avatar for everyone'});
		await stakeForEveryoneInTheWorld({
			env,
			player: wallet.accounts[0],
			table,
		});
	}

	// HANDED BACK rather than announced-and-hoped-for. The connection this world
	// builds will use exactly this wallet, so the player is never asked to
	// choose one.
	return {wallets: [wallet.handle]};
}

/**
 * GIVE EVERY SEAT AT THE TABLE SOMETHING TO LOSE.
 *
 * ONE FUNCTION RATHER THAN A CALL PER SEAT AT THE HOOK, because it is the half
 * of provisioning that can be asserted in node: the wallet and its gas need a
 * `window` to announce on, and this does not.
 * `test/lib/embedded/world.test.ts` calls exactly this, so it cannot check the
 * human and miss the players the world plays - which would be a green suite
 * over a world with one waited-for member and therefore over a cycle that hides
 * nothing.
 *
 * A WALK OF THE TABLE rather than a loop over a key list, which is where the
 * seat model earns its keep: this stakes for whoever is in each seat, so the
 * day a seat holds a second human it is staked for by this same line.
 */
export async function stakeForEveryoneInTheWorld(params: {
	env: EmbeddedWorld['env'];
	/**
	 * The human's address, which only exists once a wallet has been announced.
	 * Every other seat carries its own, because the world holds those keys.
	 */
	player: `0x${string}`;
	table: Table;
}): Promise<void> {
	for (const seat of params.table) {
		// A remote human stakes for themselves, at a table online; an offline
		// world has none.
		if (seat.occupant.kind === 'remote-human') continue;
		// Nor any other person at this device: this world offers no hotseat
		// (it exports no `LOCAL_HUMANS_AT_MOST`), so its lobby seats none.
		if (seat.occupant.kind === 'local-human') continue;
		const player =
			seat.occupant.kind === 'you' ? params.player : seat.occupant.address;
		await stakeForOfflinePlayer({env: params.env, player});
	}
}

/**
 * TAKE EVERY SEAT AT THE TABLE (stratagems' plan, step OT3, OT3-3, OT3-4), by
 * the rail the online seat uses, in the table's mode (read off the chain):
 *
 * - AVATAR MODE: the seat's avatar, bought into the TABLE through the sale by
 *   the deployer (`AvatarsSale.purchase` with the table as the game), exactly
 *   as the world buys its own, carrying the sale's stake, which is the
 *   table's (R1b-4). No stipend: there is no browser key yet.
 * - ETH MODE: `join`, paying exactly the table's stake, from the seat's OWN
 *   account, since a seat's id is the caller's address: the person through
 *   the world's wallet (`you`), a world seat from its own key. Their gas and
 *   stake are play money, set by provisioning before.
 *
 * GUARDED BY WHAT THE CHAIN HOLDS: a seat whose avatar the table already holds
 * for it is skipped, so a reload or an interrupted boot takes no seat twice.
 * Nobody is in the world's `Game`. A person at this device other than the
 * first has no seat: this world offers no hotseat.
 *
 * Exported for the world test.
 */
export async function stakeForEveryoneAtTheTable(params: {
	env: EmbeddedWorld['env'];
	provider: EmbeddedWorld['provider'];
	chain: OfflineTableChain;
	/** The table's address. */
	table: `0x${string}`;
	/** The person's account (the table's creator), and how it sends. */
	you: OfflineTableCreator;
	seats: Table;
}): Promise<void> {
	const env = params.env as unknown as {
		get: (name: string) => {abi: unknown};
		namedAccounts: Record<string, `0x${string}`>;
		read: (deployment: never, args: unknown) => Promise<unknown>;
		execute: (deployment: never, args: unknown) => Promise<unknown>;
	};
	const atTable = {
		address: params.table,
		abi: env.get('GameTableImplementation').abi,
	};
	const state = (await env.read(atTable as never, {
		functionName: 'getTable',
	})) as {mode: number; stake: bigint};
	const mode = tableModeOf(encodeTableMode(Number(state.mode))) ?? 'avatar';
	const reader = createPublicClient({
		chain: params.chain,
		transport: custom(params.provider as never),
	});
	for (const seat of params.seats) {
		if (seat.occupant.kind === 'remote-human') continue;
		if (seat.occupant.kind === 'local-human') continue;
		const player =
			seat.occupant.kind === 'you' ? params.you.address : seat.occupant.address;
		const held = (await env.read(atTable as never, {
			functionName: 'getAvatar',
			args: [offlineIdentityOf(player, mode)],
		})) as {owner: `0x${string}`};
		if (held.owner.toLowerCase() === player.toLowerCase()) continue;

		if (mode === 'avatar') {
			await env.execute(env.get('AvatarsSale') as never, {
				account: env.namedAccounts.deployer,
				functionName: 'purchase',
				args: purchaseArgs({
					gameAddress: params.table,
					owner: player,
					subID: 0n,
				}),
				value: purchaseValue({
					price: config.data.sale.default.price,
					stake: config.data.sale.default.stake,
				}),
			});
			continue;
		}
		const request = {
			address: params.table,
			abi: atTable.abi as never,
			functionName: 'join',
			args: [zeroAddress, 0n] as const,
			value: state.stake,
		};
		const hash =
			seat.occupant.kind === 'you'
				? await params.you.writeContract(request)
				: await createWalletClient({
						account: privateKeyToAccount(seat.occupant.privateKey),
						chain: params.chain,
						transport: custom(params.provider as never),
					}).writeContract(request as never);
		const receipt = await reader.waitForTransactionReceipt({hash});
		if (receipt.status !== 'success') {
			throw new Error('a seat at the world’s table could not be joined');
		}
	}
}

/**
 * PUT AN AVATAR IN THE GAME, through the rail a purchase uses.
 *
 * Its own exported function for the same reason as upstream: the wallet and its
 * gas are the mechanism's shape and need a `window` to announce on, while what
 * is at stake is the game's and can be asserted in node.
 */
export async function stakeForOfflinePlayer(params: {
	env: EmbeddedWorld['env'];
	player: `0x${string}`;
}): Promise<void> {
	const env = params.env as unknown as {
		get: (name: string) => never;
		namedAccounts: Record<string, `0x${string}`>;
		read: (deployment: never, args: unknown) => Promise<unknown>;
		execute: (deployment: never, args: unknown) => Promise<unknown>;
	};

	/**
	 * ONLY IF THEY HAVE NONE, and this is the half that measurement added
	 * upstream and that this game needs just as much.
	 *
	 * Provisioning runs on every boot and a boot is not always a first boot: the
	 * chain and the deployment records both persist, so a reload restores the
	 * world and SKIPS the deploy - and then runs this hook again. Here a second
	 * purchase would revert rather than quietly double the stake, because the id
	 * is derived from the owner and would already be minted - but reverting on
	 * every reload is not a design, it is a crash the world would have to
	 * swallow.
	 *
	 * `getAvatar` rather than a search, which is the id scheme paying off: the
	 * avatar an address plays is computable, so this asks about one exact token
	 * instead of walking a list. A zero owner means it was never deposited; an
	 * owner that is not this player means the world lost it, which is the stake
	 * being real.
	 */
	const game = env.get('Game');
	const avatarID = offlineIdentityOf(params.player);
	const existing = (await env.read(game, {
		functionName: 'getAvatar',
		args: [avatarID],
	})) as {owner: `0x${string}`};
	if (existing.owner.toLowerCase() === params.player.toLowerCase()) return;

	await env.execute(env.get('AvatarsSale'), {
		// THE RESOLVED ADDRESS, not the private key. rocketh resolves a named
		// account to an address and keeps the signing material against it
		// (`privateKey:` protocol, which this config already registers); handing
		// it the key instead asks it to sign for an address that does not exist.
		// It cannot fall back to a node-held account either: an execution-only
		// chain answers `eth_accounts` with a real `-32601`.
		account: env.namedAccounts.deployer,
		functionName: 'purchase',
		// THE SAME ARGUMENTS THE APP SENDS, from the same helper, so this world
		// cannot drift from the online purchase. The NFT goes to the GAME (which
		// is what makes it a deposit, and therefore a stake) and the OWNER is
		// carried in `data`.
		//
		// NO STIPEND, and the two move together: there is no browser key to fund
		// yet, because it is derived after this runs. The authorisation that
		// happens later carries its own gas in the same transaction, exactly as
		// the online one does.
		args: purchaseArgs({
			gameAddress: (game as unknown as {address: `0x${string}`}).address,
			owner: params.player,
			subID: 0n,
		}),
		// THE PRICE AND THE STAKE EXACTLY, read off the same config the sale was
		// deployed with. `SaleViaNativePayment.purchase` requires `msg.value`
		// minus the stipend to equal `PAYMENT_AMOUNT + STAKE_AMOUNT` exactly (the
		// stake the avatar carries since step R1a), so a value computed anywhere
		// else is a value that can drift into reverting every purchase.
		value: purchaseValue({
			price: config.data.sale.default.price,
			stake: config.data.sale.default.stake,
		}),
	});
}

/**
 * Each world seat's level, from the table, beside the keys
 * {@link playedByTheWorld} derives. Kept apart from it because a game may
 * rewrite how a seat's identity is derived (bomber-world gives each seat its
 * character), while the levels are the lobby's and the same everywhere: both
 * walk the world's seats in table order.
 */
function withLevels(
	players: readonly OfflinePlayer[],
	table: Table,
): readonly OfflinePlayer[] {
	const levels = seatsPlayedByTheWorld(table).map((seat) => seat.level);
	return players.map((player, index) => {
		const level = levels[index];
		return level !== undefined ? {...player, level} : player;
	});
}

/**
 * The seats the world plays, with the identity each of their keys plays as:
 * its avatar, or its account at an ETH-mode table (OT3-5).
 */
export function playedByTheWorld(
	table: Table,
	mode: TableMode = 'avatar',
): readonly OfflinePlayer[] {
	return seatsPlayedByTheWorld(table).map((played) => ({
		privateKey: played.privateKey,
		identity: offlineIdentityOf(played.address, mode),
	}));
}

/**
 * CONNECT, AND THEN SIGN IN, IN TWO STEPS RATHER THAN ONE.
 *
 * A world takes the app's `targetStep` rather than choosing one, deliberately:
 * a world chooses the CHAIN, never how the app authenticates. This repo's
 * target is `SignedIn`, and `ensureConnected()` with no argument waits at
 * `WalletConnected` forever, because the step after it is a SIGNATURE and a
 * signature is a thing an app asks a person for. This page mounts no connection
 * flow, so there is no button and nobody to press it.
 *
 * So the world asks for the signature itself, and this is the one place where
 * that is honest rather than a shortcut. The message is origin-scoped and the
 * wallet that signs it was generated by this world seconds ago, holds one
 * account, exists in no other tab and auto-approves by declaration. There is no
 * prompt to suppress and no decision being taken from anybody. What the
 * signature buys is exactly what it buys online: the local signer this browser
 * plays with, derived deterministically, so that a commit and a reveal cost no
 * prompts.
 */
async function connectOfflinePlayer(connection: Context['connection']) {
	await connection.ensureConnected('WalletConnected');
	if (connection.targetStep === 'SignedIn') {
		await connection.requestSignature();
	}
}

/**
 * Stop announcing the offline wallet.
 *
 * NOT a teardown of the world, deliberately: the chain outlives the page that
 * showed it, and disposing of it on unmount is how a router deletes somebody's
 * game.
 */
export function stopAnnouncingOfflineWallet(): void {
	announced?.();
	announced = undefined;
}
