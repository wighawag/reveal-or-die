import type {Readable} from 'svelte/store';
import {
	config,
	extensions,
	CYCLE_POLICY,
} from 'template-commit-reveal-contracts/rocketh/config.js';
import deployToken from 'template-commit-reveal-contracts/deploy/001_deploy_token.js';
import deployAvatars from 'template-commit-reveal-contracts/deploy/005_deploy_avatars.js';
import deployGame from 'template-commit-reveal-contracts/deploy/010_deploy_game.js';
import deployStakeSale from 'template-commit-reveal-contracts/deploy/020_deploy_stake_sale.js';
import deployLobby from 'template-commit-reveal-contracts/deploy/030_deploy_lobby.js';
import type {EmbeddedWorld} from '$lib/embedded';
import {
	createOfflineBoot,
	openOfflineWorld,
	type OfflineBootStatus,
} from '$lib/offline-world';
import {createContext, lobby as gameLobby} from '$lib/context/index';
import type {Context} from '$lib/context/types';
import {createPublicClient, custom} from 'viem';
import type {TableChoice} from '$lib/game/lobby/lobby';
import {offlineSeatLabels} from '$lib/game/lobby/offline-table';
import {
	createOfflinePlayers,
	playedTurnCells,
	type OfflinePlayer,
} from '$lib/offline-players';
import {createPlayedTurnStore, RANDOM_LEVEL} from '$lib/game/core/strategy';
import {createBytecodeSandbox} from '$lib/game/simulation';
import {
	PLACEMENT_LEVELS,
	createPlacementStrategy,
} from '$lib/placement/strategy';
import {PLACEMENT_STORAGE} from '$lib/placement/storage';
import {
	MOST_SEATS,
	humansAtThisDevice,
	type Table,
} from '$lib/game/lobby/seats';
import {showHotseat} from '$lib/game/lobby/hotseat';
import {
	createOfflineWallet,
	handOverBetweenThem,
	holdTheWorldOnTheConsole,
	openTheWorldsTable,
	readyToPlay,
	resolvePlayedSeats,
	revealerForTheHumans,
	seatTheHumans,
	stakeEverySeat,
	theWorldsGame,
	worldChain,
	type TableAt,
	type WorldNodeProvider,
} from '$lib/game/offline';
import {resolvePlacementConfig} from '$lib/placement/config';

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
 * THE THREE THINGS IT DECIDES, and each of them is a game's answer rather than
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
 *    on the `work` branch.
 *
 * 2. **Everything else unchanged**, by SPREADING the deploy's own `default`
 *    data rather than restating it. `commitGas`, `revealGas`,
 *    `actionsPerReveal` and `expectedActionsPerTurn` are properties of the
 *    CONTRACTS and of the EVM, not of where the chain runs, and webevm was
 *    measured to agree with hardhat to the unit on all six gas readings - so
 *    the declared limits keep their measured headroom here. Restating them
 *    would be a second copy of a measurement, which is exactly how the identity
 *    branches once came to price a credit 58% above what a step there costs.
 *
 * 3. **What the player is given**, which ON THIS BRANCH is an AVATAR, minted
 *    straight into the game where it is at stake from the moment it exists.
 *    That is the one thing in this file that differs from `main`'s, and it is
 *    the difference the provisioning hook exists for: the framework supplies
 *    the moment and the capability, and what is lost by not revealing is the
 *    game's own answer. Upstream it is a bonded ERC20 in a reserve; here the
 *    player never has a reserve at all.
 *
 * 4. **Who else is in it**, which is the difference between a commit-reveal
 *    game and a demonstration of one. A cycle with a single waited-for member
 *    hides nothing and two of `advanceCycle`'s three conditions cannot be
 *    reached at all, so a world enrols at least THREE and plays all but one of
 *    them. HOW MANY is the player's, chosen at the lobby before the world
 *    boots (`$lib/game/lobby`, wired to this world by `$lib/offline-lobby`), and
 *    it arrives here as a TABLE of seats. What those players DO is
 *    `$lib/offline-players`; who is in each seat is `$lib/game/lobby/seats`,
 *    which is framework and shared. What is decided here is what each of them is
 *    GIVEN and how this game spells who they are, because that is what differs
 *    per branch and this file differs already.
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
 * lobby, which reads this key off this module. A WIRE from its first build.
 */
export const TABLE_STORAGE_KEY = 'offline-world:table';

/**
 * HOTSEAT: how many people at this device this world can play, each their own
 * account in the world's wallet and their own avatar in the game's custody
 * (bought for them by the same walk of the table as everyone else's), passing
 * the device between them (`$lib/game/lobby/hotseat`). Every seat may be one.
 * Read by the byte-identical lobby off this module (`$lib/offline-lobby`).
 */
export const LOCAL_HUMANS_AT_MOST = MOST_SEATS;

/**
 * THE LEVELS A WORLD SEAT MAY PLAY AT, chosen per seat at the lobby: `random`
 * (today's derived turn, the default) and `greedy` (`$lib/placement/strategy`).
 * Read by the byte-identical lobby off this module, as `LOCAL_HUMANS_AT_MOST`
 * is; a game whose world does not export it offers no choice, and every seat
 * plays `random`.
 */
export const AI_LEVELS = PLACEMENT_LEVELS;

/**
 * Where a played seat's decided turn is kept, beside this world's other keys:
 * a storage that lost it has lost the chain id too, and so the world. A WIRE
 * from its first build, like the record it holds (`$lib/game/core/strategy`).
 */
export const PLAYED_TURNS_STORAGE_KEY = 'offline-world:played-turns';
const PLAY_MONEY = 10n ** 24n;

/**
 * THE DEPLOYMENT AN OFFLINE GAME IS, as one exported value.
 *
 * Exported rather than inlined below so that the world test can deploy the
 * same thing this file does. What is worth testing about an offline world is
 * not that the mechanism boots - four suites under `test/lib/embedded` already
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
		{id: '001_deploy_token', module: deployToken},
		// THE FOURTH SCRIPT, which is this branch's and is easy to lose in a
		// cascade: the avatars have to exist before the game that takes custody
		// of them. A world missing it deploys a game with no identity to play as,
		// and the failure arrives at the first click rather than at the deploy.
		{id: '005_deploy_avatars', module: deployAvatars},
		{id: '010_deploy_game', module: deployGame},
		{id: '020_deploy_stake_sale', module: deployStakeSale},
		// THE TABLES, which an offline world plays too (`startOfflineTable`):
		// the factory and the lobby implementation every table is a clone of.
		{id: '030_deploy_lobby', module: deployLobby},
	],
	/**
	 * What the in-tab deployment declares.
	 *
	 * SPREAD FROM THE DEPLOY'S OWN `default`, so the only things this world says
	 * are the things that are actually different about it. See point 2 on this
	 * module for why the rest must not be restated here - and note that the
	 * spread is load-bearing rather than tidy: the world's `data` REPLACES the
	 * environment's entry wholesale, so a partial declaration would leave
	 * `commitGas` undefined and the client would refuse to start.
	 */
	data: {
		Game: {
			...config.data.Game.default,
			cyclePolicy: CYCLE_POLICY.Manual,
			commitPhaseDuration: 0n,
			revealPhaseDuration: 0n,
		},
		// A TABLE RUNS THE WORLD'S CLOCK HERE, for the world's reason (point 1
		// on this module): the Manual cycle with both durations zero, every
		// phase closed by its members. Everything else is the lobby's own.
		Lobby: {
			...config.data.Lobby.default,
			cyclePolicy: CYCLE_POLICY.Manual,
			commitPhaseDuration: 0n,
			revealPhaseDuration: 0n,
		},
	},
	accounts: {deployer: DEPLOYER, admin: ADMIN},
	initialBalances: {
		[DEPLOYER_ADDRESS]: PLAY_MONEY,
		[ADMIN_ADDRESS]: PLAY_MONEY,
	},
} as const;

/** What a `Ready` world carries as its `context`: the context, and what starts with the board. */
type OfflineWorldContext = {context: Context; start: () => () => void};

export type OfflineWorldStatus = OfflineBootStatus<{
	world: EmbeddedWorld;
	context: OfflineWorldContext;
}>;

/**
 * THE WORLD'S OWN WALLET, announced at provisioning: the world switches its
 * accounts in hotseat (`$lib/game/offline`'s `createOfflineWallet`).
 */
const wallet = createOfflineWallet();

/**
 * APP-SCOPED AND LAZY, and the lifetime is the decision rather than the
 * laziness (`$lib/offline-world`'s `createOfflineBoot`): nothing runs until a
 * page asks, a world is STATE rather than a view so a second start joins the
 * first, and a failed boot is dropped so a retry is possible.
 */
const boot = createOfflineBoot(
	(booting, table: Table, at: TableAt | undefined) =>
		buildOfflineWorld(booting, table, at),
);

/** What the page renders. */
export const offlineWorld: Readable<OfflineWorldStatus> = boot.status;

export function startOfflineWorld(params: {
	/**
	 * Everyone this world will wait for, chosen at the lobby before anything
	 * booted. A world that is already building keeps the table it was started
	 * with: membership is provisioned once and cannot be changed afterwards
	 * without staking or withdrawing members mid-cycle.
	 */
	table: Table;
}): Promise<OfflineWorldStatus> {
	return boot.start(params.table, undefined);
}

/**
 * A TABLE IN THIS WORLD: a game for the seats chosen, created by the first
 * person's account, every seat staked at it, started by the tab, ended after
 * `cycles`. Read by the byte-identical lobby off this module (`$lib/offline-lobby`):
 * exporting it is what offers a table offline, and a game with online tables
 * must (`test/offline-tables-boundary.test.ts`). The world's own `Game` is
 * deployed beside it, and nobody is staked there.
 */
export function startOfflineTable(
	choice: TableChoice,
): Promise<OfflineWorldStatus> {
	return boot.start(choice.table, {
		cycles: choice.cycles,
		gameOptions: choice.gameOptions,
	});
}

/**
 * THIS GAME'S WORLD, composed of the steps every commit-reveal game's world
 * takes (`$lib/game/offline`) around what is this game's: its deployment, its
 * stake, who an address plays as and how its world seats decide.
 */
async function buildOfflineWorld(
	booting: (what: string) => void,
	table: Table,
	at: TableAt | undefined,
): Promise<{world: EmbeddedWorld; context: OfflineWorldContext}> {
	// The id is minted once and remembered, because it is what keys everything
	// the player keeps: the operations ledger, and this game's submission
	// storage (`placement/storage.ts` keys by `chainID_gameAddress_player`). See
	// `lib/embedded/chain-id.ts`.
	const world = await openOfflineWorld({
		chainIdKey: CHAIN_ID_STORAGE_KEY,
		deployment: {
			rocketh: {config, extensions},
			environment: OFFLINE_DEPLOYMENT.environment,
			scripts: [...OFFLINE_DEPLOYMENT.scripts],
			// The manual policy and the two zeroes are the whole of what is
			// different about an offline deployment. See `OFFLINE_DEPLOYMENT`.
			data: OFFLINE_DEPLOYMENT.data,
			accounts: OFFLINE_DEPLOYMENT.accounts,
			initialBalances: OFFLINE_DEPLOYMENT.initialBalances,
		},
		// THE LOCAL CHAIN'S OWN PROPERTIES, read out of the deploy config rather
		// than typed again: `expectedWorstGasPrice` and `creditsGasMultiplier` are
		// what denominate the play key's gas in MOVES, and a second copy of either
		// is a number that can drift into telling the player they have more turns
		// than they do. The block time and the finality are the opener's.
		chainProperties: config.chains[31337].properties,
		provision: (params) =>
			provisionOfflinePlayer({
				...params,
				table,
				atTable: !!at,
				onStep: booting,
			}),
		onStep: booting,
	});
	const humans = humansAtThisDevice(table);

	let where = theWorldsGame(world);
	if (at) {
		const opened = await openTheWorldsTable({
			world,
			wallet,
			lobby: gameLobby,
			table,
			at,
			stake: (opened) =>
				stakeForEveryoneAtTheTable({
					env: world.env,
					table: opened.address,
					player: wallet.current()!.accounts[0],
					humans: wallet.current()!.accounts,
					seats: table,
				}),
			chainIdKey: CHAIN_ID_STORAGE_KEY,
			storageKey: TABLE_STORAGE_KEY,
			onStep: booting,
		});
		// A refused table let go of this world and remembered a new id: build
		// again, which opens the new one.
		if (opened.kind === 'incoherent') {
			return buildOfflineWorld(booting, table, at);
		}
		where = opened;
	}
	const {records} = where;
	const identityOf = (player: `0x${string}`) =>
		offlineIdentityOf({
			env: world.env,
			player,
			game: records.get().contracts.Game,
		});

	let pokeAdvance = () => {};
	const revealer = revealerForTheHumans({
		world,
		records,
		humans,
		onActed: () => pokeAdvance(),
	});

	booting('connecting');

	// SYNCHRONOUS, AND AFTER THE WORLD, which is the shape the whole design
	// turns on. The context cannot be built first and filled in: it reads a
	// contract address out of `deployments` while constructing, to scope the
	// operations ledger, and before the deploy there is no address to give it.
	// ADR-0002 is untouched - the app-level context in `+layout.svelte` is still
	// built synchronously during prerender, because that one is the remote
	// world.
	const context = createContext({
		establishConnection: where.establishConnection,
		...(revealer ? {scheduler: revealer.scheduler} : {}),
		// AT A TABLE the context is the table's, with its roster and its
		// creator's powers, its seats named as the lobby named them.
		...(where.table
			? {
					table: where.table,
					seatLabels: await offlineSeatLabels({
						table,
						accounts: wallet.current()?.accounts,
						identityOf,
						levels: AI_LEVELS,
					}),
				}
			: {}),
	});
	pokeAdvance = () => void context.context.game.cycleAdvance.check();
	holdTheWorldOnTheConsole({world, context: context.context});

	const seated = await seatTheHumans({
		context: context.context,
		wallet: wallet.current(),
		humans,
		identityOf,
		onStep: booting,
	});
	const hotseat = handOverBetweenThem({
		seated,
		wallet: wallet.current(),
		revealer,
		context: context.context,
		world,
		records,
	});

	// THE OTHER PLAYERS, STARTED WITH THE BOARD AND STOPPED WITH IT
	// (`readyToPlay`).
	const played = await playedByTheWorld({
		env: world.env,
		table,
		game: records.get().contracts.Game,
	});
	const decider = playedSeatDecider(
		{provider: world.provider, deployments: records},
		played,
	);
	const players = createOfflinePlayers({
		provider: world.provider,
		deployments: records,
		config: resolvePlacementConfig(records.get()),
		players: played,
		// A played commit can complete unanimity just as the human's can, and the
		// advance client would otherwise find out on its own one-second poll.
		onActed: () => void context.context.game.cycleAdvance.check(),
		...(decider ? {strategy: decider.strategy, turns: decider.turns} : {}),
	});

	showHotseat(hotseat);
	return {
		world,
		context: readyToPlay({context, players, revealer, hotseat, decider}),
	};
}

/**
 * HOW THE WORLD'S SEATS DECIDE, when one of them plays at a level other than
 * `random`: the game's strategy over the world's own provider, scored by the
 * `Simulation` route's bytecode in a sandbox of the seats' own (not the
 * player's preview sandbox, which is the game context's and rebuilt with it),
 * and the store their decided turns are kept in. Undefined when every seat
 * plays `random`, so such a world builds no sandbox and stores nothing.
 *
 * EXPORTED for the world test, which builds the seats exactly as this does.
 * Handed the provider and nothing of the page (PA6): no context, no
 * submission, no handover.
 */
export function playedSeatDecider(
	world: Pick<EmbeddedWorld, 'provider' | 'deployments'>,
	played: readonly OfflinePlayer[],
	options: {
		storage?: Pick<Storage, 'getItem' | 'setItem'>;
		onDecided?: (measure: {
			ms: number;
			claimed: number;
			simulated: number;
		}) => void;
	} = {},
) {
	if (played.every((seat) => (seat.level ?? RANDOM_LEVEL) === RANDOM_LEVEL)) {
		return undefined;
	}
	const records = world.deployments.get();
	const contract = {
		address: records.contracts.Game.address,
		abi: records.contracts.Game.abi,
	};
	const sandbox = createBytecodeSandbox({
		provider: world.provider as never,
		contracts: {
			rules: {
				address:
					records.contracts.Game_Implementation_Router_Simulation_Route.address,
			},
		},
	});
	const strategy = createPlacementStrategy({
		publicClient: createPublicClient({
			chain: worldChain(world),
			transport: custom(world.provider as never),
		}),
		sandbox,
		contract,
		candidates: playedTurnCells(),
		onDecided: options.onDecided,
	});
	const turns = createPlayedTurnStore({
		storage: options.storage ?? localStorage,
		key: PLAYED_TURNS_STORAGE_KEY,
		chainId: records.chain.id,
		contract: contract.address,
		format: PLACEMENT_STORAGE,
	});
	return {strategy, turns, sandbox};
}

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
 * 3. **AN AVATAR**, which is what THIS branch puts at risk and therefore the
 *    only reason anybody here has to reveal. Bought through
 *    `GameAvatarSale.purchase`, the same rail the online purchase uses, rather
 *    than by minting and depositing by hand: the rail is one call that mints
 *    it straight into the game contract and can forward a gas stipend, and
 *    using it here means the offline world exercises the contract path the
 *    online one depends on instead of a private shortcut that could quietly
 *    stop matching it.
 * 4. **EVERYONE ELSE AT THE TABLE**, which is gas and an avatar for every seat
 *    the lobby laid out and is the same three things over again. It is not a
 *    courtesy: on this branch what enrols a player is custody of the avatar
 *    the sale mints straight into the game, so this call is what makes
 *    unanimity mean something - and a cycle with one member is a cycle that
 *    hides nothing. They are given exactly what the human is given and nothing
 *    more, so what the world can do, the human can do.
 *
 * WHAT IT STILL DOES NOT DO IS AUTHORISE THE BROWSER'S KEY, and this paragraph
 * used to go on to say that authorising was therefore the player's one press.
 * It is not any more, and the REASON given here was true and stays true: the
 * signer is derived in the tab from a wallet signature AFTER this runs (and
 * after the context exists at all), so provisioning cannot know its address,
 * let alone register it. What has changed is who does it once it exists. The
 * world does, in the step that asks for that signature and is therefore the
 * first moment there is an address to register - see `connectTheWorld`
 * and the call beside it.
 *
 * ASKING WAS RIGHT WHEN THE WORLD HAD ONE MEMBER, AND IS NOT NOW. With one
 * member that press was the only thing in the whole world that the player was
 * asked for, so it read as the honest split: the world gives what only the
 * world can give - a chain, contracts, gas and an identity to play as - and
 * the browser gives what only it can, a key and the authority to play with it.
 * With a table of members already provisioned and already waiting, the same
 * press is one dialog with one possible answer in front of a game that is
 * otherwise ready: both sides of "who pays" are the same wallet, on a chain in
 * this tab, holding money this file invented. A question with one answer is
 * not consent, it is a gate. The SPLIT is unchanged - the browser still
 * supplies the key and the authority - what went is being asked to confirm it.
 *
 * THE STIPEND IS ZERO HERE, and the sale refuses a stipend with nowhere to go,
 * so the two move together. There is still no key to forward gas to at this
 * point, for the reason above; the authorisation that happens later carries
 * its own gas with it, in the same transaction, exactly as the online one
 * does.
 */
async function provisionOfflinePlayer(params: {
	env: EmbeddedWorld['env'];
	node: {provider: WorldNodeProvider};
	chainId: number;
	table: Table;
	/**
	 * Whether the world is a TABLE: then nobody is staked in the world's
	 * `Game`, and every seat is staked at the table once it exists (after the
	 * deploy, `openTheWorldsTable`).
	 */
	atTable: boolean;
	onStep: (what: string) => void;
}) {
	const {env, node, table} = params;

	// A WALLET AND GAS, for every seat (`$lib/game/offline`'s
	// `createOfflineWallet`, which says why gas is refilled on every boot and a
	// stake never is).
	params.onStep('handing the player a wallet');
	const announced = await wallet.announce({
		provider: node.provider,
		chainId: params.chainId,
		table,
		gas: PLAY_MONEY,
	});

	if (!params.atTable) {
		params.onStep('staking for everyone at the table');
		await stakeForEveryoneInTheWorld({
			env,
			player: announced.accounts[0],
			humans: announced.accounts,
			table,
		});
	}

	// HANDED BACK rather than announced-and-hoped-for. The connection this world
	// builds will use exactly this wallet, so the player is never asked to
	// choose one.
	return {wallets: [announced.handle]};
}

/**
 * GIVE EVERY SEAT AT THE TABLE SOMETHING TO LOSE.
 *
 * ONE FUNCTION RATHER THAN A CALL PER SEAT AT THE HOOK, because it is the half
 * of provisioning that can be asserted in node: the wallet and its gas need a
 * `window` to announce on, and this does not.
 * `test/lib/embedded/world.test.ts` calls exactly this, so it cannot check the
 * human and miss the players the world plays - which would be a green suite
 * over a world with one waited-for member and therefore over a cycle that
 * hides nothing. That test reads the count back off `getAttendance` rather
 * than off the table, because the table is what a cascade can quietly halve.
 *
 * A WALK OF THE TABLE rather than a loop over a key list, which is where the
 * seat model earns its keep: this stakes for whoever is in each seat, so the
 * day a seat holds a second human it is staked for by this same line.
 *
 * THE OTHER SEATS ARE NOT A COURTESY. What enrols a player on this branch is
 * CUSTODY of an avatar - the sale mints it straight into the game, and
 * `_startWaitingFor` fires from there - so this call is what makes unanimity
 * mean something; and custody is what they lose by going quiet, which is what
 * makes their commitments worth making. They are given exactly what the human
 * is given and nothing more, so what the world can do, the human can do.
 */
export async function stakeForEveryoneInTheWorld(params: {
	env: EmbeddedWorld['env'];
	/**
	 * The human's address, which only exists once a wallet has been announced.
	 * Every other seat carries its own, because the world holds those keys.
	 */
	player: `0x${string}`;
	/**
	 * Every account of the world's wallet, in seat order, for the other people
	 * at this device (hotseat): a `local-human` seat is the account at its index.
	 */
	humans?: readonly `0x${string}`[];
	table: Table;
}): Promise<void> {
	await stakeEverySeat({
		table: params.table,
		you: params.player,
		...(params.humans ? {humans: params.humans} : {}),
		stake: ({player}) => stakeForOfflinePlayer({env: params.env, player}),
	});
}

/**
 * GIVE EVERY SEAT AT THE WORLD'S TABLE A SEAT: on this branch an AVATAR bought
 * AT THE TABLE (`GameAvatarSale.purchaseAt`, the rail an online seat is taken
 * by), minted into the table's custody, which is what makes a member of a
 * closed roster, for each seat of the table as
 * {@link stakeForEveryoneInTheWorld} walks it. Unless the seat already holds an
 * avatar there, for the reason {@link stakeForOfflinePlayer} gives: an identity
 * minted again by a reload has nothing at stake. Exported for the table test.
 */
export async function stakeForEveryoneAtTheTable(params: {
	env: EmbeddedWorld['env'];
	/** The table's address. */
	table: `0x${string}`;
	player: `0x${string}`;
	humans?: readonly `0x${string}`[];
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
		abi: env.get('GameLobbyImplementation').abi,
	};
	await stakeEverySeat({
		table: params.seats,
		you: params.player,
		...(params.humans ? {humans: params.humans} : {}),
		stake: async ({player}) => {
			const held = await offlineIdentityOf({
				env: params.env,
				player,
				game: atTable,
			}).catch(() => undefined);
			if (held !== undefined) return;
			await env.execute(env.get('GameAvatarSale') as never, {
				account: env.namedAccounts.deployer,
				functionName: 'purchaseAt',
				args: [
					params.table,
					player,
					'0x0000000000000000000000000000000000000000',
					0n,
				],
				value: config.data.sale.default.price,
			});
		},
	});
}

/**
 * PUT AN AVATAR IN THE GAME, through the rail a purchase uses.
 *
 * WHAT IS AT STAKE ON THIS BRANCH, and the shape of the difference is worth as
 * much as the code. `main`'s version of this function buys a bonded ERC20 and
 * checks `getReserve`; here the player owns no reserve and can lose no bond -
 * what they lose by not revealing is custody of the avatar itself, which is
 * why the sale mints it straight into the game contract and why the check
 * below asks whether they already hold one.
 *
 * Its own exported function for the same reason as upstream: the wallet and
 * its gas are the mechanism's shape and need a `window` to announce on, while
 * what is at stake is the game's and can be asserted in node.
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
	 * ONLY IF THEY HAVE NONE, and this is the half that measurement added.
	 *
	 * Provisioning runs on every boot and a boot is not always a first boot: the
	 * chain and the deployment records both persist, so a reload restores the
	 * world and SKIPS the deploy - and then runs this hook again. Measured on
	 * `main`, where the reserve went from 10 to 20 on the second load; here it
	 * would be a second avatar every time, and an account that can mint another
	 * identity by pressing F5 has nothing at stake in the first one.
	 *
	 * `getAvatarsOf` then `getAvatarOwner`, which is the same pair
	 * `$lib/game/identity` uses to find who this account plays as: the first is
	 * a SEARCH SPACE (every avatar this account ever put in) and only the second
	 * says whether it is still theirs.
	 */
	const game = env.get('Game');
	const candidates = (await env.read(game, {
		functionName: 'getAvatarsOf',
		args: [params.player],
	})) as readonly bigint[];
	for (const avatarID of candidates) {
		const holder = (await env.read(game, {
			functionName: 'getAvatarOwner',
			args: [avatarID],
		})) as `0x${string}`;
		if (holder.toLowerCase() === params.player.toLowerCase()) return;
	}

	await env.execute(env.get('GameAvatarSale'), {
		// THE RESOLVED ADDRESS, not the private key the spec was written with.
		// rocketh resolves a named account to an address and keeps the signing
		// material against it (`privateKey:` protocol, which this config already
		// registers); handing it the key instead asks it to sign for an address
		// that does not exist, and the failure names the key as though it were
		// one. It cannot fall back to a node-held account either: an
		// execution-only chain answers `eth_accounts` with a real `-32601`.
		account: env.namedAccounts.deployer,
		functionName: 'purchase',
		// The owner is an ARGUMENT rather than `msg.sender`: whoever sends this
		// pays and `owner` is recorded as who may play the avatar, which is what
		// lets a world set up an account that has never sent anything. Buying
		// somebody else an avatar is a gift, because only its owner can play it
		// or take it out.
		//
		// THE STIPEND IS ZERO AND THE KEY IS THE ZERO ADDRESS, and the sale
		// refuses a stipend with nowhere to go, so the two move together. There is
		// no browser key to fund yet: it is derived after this runs.
		args: [params.player, '0x0000000000000000000000000000000000000000', 0n],
		// THE PRICE EXACTLY, read off the same config the sale was deployed with.
		// `purchase` subtracts the stipend from `msg.value` and then requires the
		// remainder to equal `PRICE` exactly, so a value computed anywhere else is
		// a value that can drift into `WrongPaymentAmount`.
		value: config.data.sale.default.price,
	});
}

/**
 * WHO AN ADDRESS PLAYS AS IN THIS WORLD, once it has been provisioned.
 *
 * ASYNC BECAUSE ON THIS BRANCH IT HAS TO BE, and that is the whole reason
 * upstream writes it as a function it does not need. `main` is an ADDRESS
 * game, so an identity is the account widened to a `uint256` and nobody has to
 * be asked; here the identity is a TOKEN, minted by the provisioning above,
 * whose id is whatever the contract assigned - so the only place the answer
 * exists is the chain. The shared signature costs upstream one `await` and
 * keeps `offline-players.ts`, which is where all the behaviour is,
 * byte-identical across the template's branches.
 *
 * ONE PLACE PER BRANCH SAYS HOW AN ADDRESS BECOMES A PLAYER, which is the same
 * rule `game/identity.ts` follows for the human and for the same reason: every
 * OTHER site that spelled it would be a site this branch has to edit and
 * therefore conflict on forever.
 *
 * `getAvatarsOf` then `getAvatarOwner`, which is the pair `game/identity.ts`
 * uses and the pair `stakeForOfflinePlayer` above uses: the first is a SEARCH
 * SPACE (every avatar this address ever put in, append-only on purpose) and
 * only the second says whether it is still theirs. An avatar that has been
 * seized for a missed reveal stops being an identity, which is the stake being
 * real.
 *
 * IT THROWS rather than answering zero. Zero is a legal argument to
 * `makeCommitment` and means "play as the caller", so a world that handed it
 * to a played player would enrol nobody and quietly commit as an address with
 * no avatar - which reverts one layer down with a message about delegation.
 * Called AFTER provisioning, so there is no honest case where the answer is
 * missing.
 */
export async function offlineIdentityOf(params: {
	env: EmbeddedWorld['env'];
	player: `0x${string}`;
	/**
	 * THE GAME THE IDENTITY IS IN: the world's `Game` when omitted, or the
	 * world's table. On this branch an identity is an avatar in ONE game's
	 * custody, so it is looked for in this one.
	 */
	game?: {address: `0x${string}`; abi: unknown};
}): Promise<bigint> {
	const env = params.env as unknown as {
		get: (name: string) => never;
		read: (deployment: never, args: unknown) => Promise<unknown>;
	};
	// IN THE GAME IT PLAYS IN: an avatar is in the custody of one game, the
	// world's `Game` or the world's table, and is that game's member only.
	const game = (params.game ?? env.get('Game')) as never;
	const candidates = (await env.read(game, {
		functionName: 'getAvatarsOf',
		args: [params.player],
	})) as readonly bigint[];
	for (const avatarID of candidates) {
		const holder = (await env.read(game, {
			functionName: 'getAvatarOwner',
			args: [avatarID],
		})) as `0x${string}`;
		if (holder.toLowerCase() === params.player.toLowerCase()) return avatarID;
	}
	throw new Error(
		`the offline world has no avatar in custody for ${params.player}, so it has nobody to play as`,
	);
}

/** The seats the world plays, with the identity each of their keys plays as. */
export async function playedByTheWorld(params: {
	env: EmbeddedWorld['env'];
	table: Table;
	/** The game they play in: see {@link offlineIdentityOf}. */
	game?: {address: `0x${string}`; abi: unknown};
}): Promise<readonly OfflinePlayer[]> {
	return resolvePlayedSeats({
		table: params.table,
		identityOf: ({player}) =>
			offlineIdentityOf({
				env: params.env,
				player,
				...(params.game ? {game: params.game} : {}),
			}),
	});
}

/**
 * Stop announcing the offline wallet.
 *
 * NOT a teardown of the world, deliberately: the chain outlives the page that
 * showed it, and disposing of it on unmount is how a router deletes somebody's
 * game.
 */
export function stopAnnouncingOfflineWallet(): void {
	wallet.stop();
}
