import {get, writable, type Readable} from 'svelte/store';
import {
	config,
	extensions,
	CYCLE_POLICY,
} from 'reveal-or-die-contracts/rocketh/config.js';
import deployAvatars from 'reveal-or-die-contracts/deploy/001_deploy_avatars.js';
import deployGame from 'reveal-or-die-contracts/deploy/010_deploy_game.js';
import deploySale from 'reveal-or-die-contracts/deploy/020_deploy_sale.js';
import {avatarIDFor, purchaseArgs} from 'reveal-or-die-contracts';
import {
	createEmbeddedWorld,
	restoreIsCoherent,
	type EmbeddedWorld,
} from '$lib/embedded';
import {mintChainId, rememberChainId} from '$lib/embedded/chain-id';
import {startEmbeddedNode} from '$lib/embedded/node';
import {announceEmbeddedWallet} from '$lib/embedded/wallet';
import {createIndexedDBPersistence} from 'webevm';
import {createIndexedDBDeploymentStore} from '@rocketh/web';
import {createContext} from '$lib/context/index';
import type {Context} from '$lib/context/types';
import {createOfflinePlayers, type OfflinePlayer} from '$lib/offline-players';
import {pokeWhenTheHumanActs} from '$lib/game/core/played';
import {seatsPlayedByTheWorld, type Table} from '$lib/game/lobby/seats';
import {authoriseTheBrowsersKey} from '$lib/game/acquire';
import {resolveWorldConfig} from '$lib/world/config';
import {declareWaitedFor} from '$lib/world/advance';

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
 *    AND HERE THE WORLD HAS TO SAY WHO THEY ARE, which is the one structural
 *    difference from the template's version of this file. That game's contract
 *    keeps an `Attendance` and answers `getAttendance`; this one keeps no
 *    membership set at all and cannot enumerate one, so unanimity is measured
 *    by the CLIENT against a table this file declares. See
 *    {@link declareWaitedFor} and the file it lives in.
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
const PLAY_MONEY = 10n ** 24n;

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
export function offlineIdentityOf(player: `0x${string}`): bigint {
	return avatarIDFor(player, 0n);
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
	],
	/**
	 * What the in-tab deployment declares.
	 *
	 * SPREAD FROM THE DEPLOY'S OWN `default`, so the only things this world says
	 * are the things that are actually different about it. See point 2 on this
	 * module for why the rest must not be restated here.
	 */
	data: {
		Game: {
			...config.data.Game.default,
			cyclePolicy: CYCLE_POLICY.Manual,
			commitPhaseDuration: 0n,
			revealPhaseDuration: 0n,
		},
		sale: {...config.data.sale.default},
	},
	accounts: {deployer: DEPLOYER, admin: ADMIN},
	initialBalances: {
		[DEPLOYER_ADDRESS]: PLAY_MONEY,
		[ADMIN_ADDRESS]: PLAY_MONEY,
	},
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
	if (!pending) {
		pending = buildOfflineWorld(params.table).catch((err) => {
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

async function buildOfflineWorld(table: Table): Promise<OfflineWorldStatus> {
	// The id is minted once and remembered, because it is what keys everything
	// the player keeps: the operations ledger, and this game's submission
	// storage (`world/storage.ts` keys by chain and game). See
	// `lib/embedded/chain-id.ts`.
	const chainId = rememberChainId({
		storage: localStorage,
		key: CHAIN_ID_STORAGE_KEY,
	});

	const world = await openWorld(chainId, table);

	status.set({step: 'Booting', what: 'connecting'});

	// SYNCHRONOUS, AND AFTER THE WORLD, which is the shape the whole design
	// turns on. The context cannot be built first and filled in: it reads a
	// contract address out of `deployments` while constructing, to scope the
	// operations ledger, and before the deploy there is no address to give it.
	// ADR-0002 is untouched - the app-level context in `+layout.svelte` is still
	// built synchronously during prerender, because that one is the remote
	// world.
	const context = createContext({
		establishConnection: world.establishConnection,
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
	 * WHO THE CYCLE WAITS FOR, DECLARED, which the template's world never has to
	 * do because its contract keeps the tally itself.
	 *
	 * EVERY SEAT INCLUDING THE HUMAN'S, because unanimity is measured against
	 * the table and not against the players the world happens to drive. A
	 * declaration that listed only the played seats would let an advance close a
	 * cycle the human had not revealed in, which in this game is a step towards
	 * losing their avatar.
	 *
	 * It is safe to declare an avatar that is not in the world yet: the reader
	 * treats one that has never entered as alive and waited for, which is right,
	 * because its first submission is the Enter.
	 */
	declareWaitedFor(world.chainId, [
		offlineIdentityOf(await theHumansAddress(context.context)),
		...seatsPlayedByTheWorld(table).map((played) =>
			offlineIdentityOf(played.address),
		),
	]);

	/**
	 * THE OTHER PLAYERS, STARTED WITH THE BOARD AND STOPPED WITH IT.
	 *
	 * Wrapped around the context's own `start` rather than started here, so that
	 * their lifetime is exactly the human's advance client's: both spend the
	 * world's gas to keep a cycle turning, and neither has any business doing so
	 * while nothing is on screen. The WORLD still outlives the page (the chain
	 * is not disposed when a router navigates away); what stops is the playing.
	 */
	const players = createOfflinePlayers({
		provider: world.provider,
		deployments: world.deployments,
		config: resolveWorldConfig(world.deployments.get()),
		players: playedByTheWorld(table),
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
				const stopPoke = pokeWhenTheHumanActs({
					loop: players,
					submission: context.context.game.submission,
				});
				return () => {
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
 * The address the human is playing as, once the world has connected its wallet.
 *
 * READ OFF THE CONTEXT rather than remembered from provisioning, because
 * provisioning ran before the connection existed and the wallet is what decides
 * which of its accounts is in use.
 *
 * AND WAITED FOR, which the first version of this did not do and which cost a
 * browser run to find. `ensureConnected` and `requestSignature` resolving does
 * not mean every store downstream of them has been written: the account store
 * is fed by the connection's own state, so a synchronous read the instant those
 * resolve can still see `undefined`. There is no store to await here and no
 * promise that means "and the account is published", so this waits for the
 * first defined value.
 *
 * IT GIVES UP RATHER THAN HANGING. A world that cannot name its own player
 * cannot declare who the cycle waits for, and a table missing seat one is worse
 * than a failed boot: an advance would close cycles the human had not revealed
 * in, which is how they lose the avatar. Failing loudly here is the safe
 * direction.
 */
async function theHumansAddress(context: Context): Promise<`0x${string}`> {
	const immediate = get(context.account);
	if (immediate) return immediate;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			stop();
			reject(
				new Error(
					'the offline world connected no account, so it does not know who is in seat one',
				),
			);
		}, ACCOUNT_WAIT_MS);
		const stop = context.account.subscribe((address) => {
			if (!address) return;
			clearTimeout(timer);
			// `subscribe` calls back synchronously with the current value, so
			// `stop` may not be assigned yet on the first call. Deferring the
			// teardown is the ordinary way round that and costs one microtask.
			queueMicrotask(() => stop());
			resolve(address);
		});
	});
}

/** How long to wait for the connection to publish an account. */
const ACCOUNT_WAIT_MS = 30_000;

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
	const probe = await startEmbeddedNode({
		chainId,
		persistence: createIndexedDBPersistence({
			db: `offline-world-chain:${chainId}`,
		}),
	});
	const coherent = await restoreIsCoherent({
		provider: probe.provider,
		vfs: deploymentStore.vfs,
	});
	await probe.dispose();
	if (!coherent) {
		status.set({step: 'Booting', what: 'starting a new world'});
		const fresh = mintChainId();
		localStorage.setItem(CHAIN_ID_STORAGE_KEY, String(fresh));
		return openWorld(fresh, table);
	}

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
		initialBalances: {...OFFLINE_DEPLOYMENT.initialBalances},
		persistence: createIndexedDBPersistence({
			db: `offline-world-chain:${chainId}`,
		}),
		deploymentStore,
		provision: (params) => provisionOfflinePlayer({...params, chainId, table}),
	});
}

let announced: (() => void) | undefined;

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
}) {
	const {env, node, table} = params;

	status.set({step: 'Booting', what: 'handing the player a wallet'});
	const wallet = await announceEmbeddedWallet({
		provider: node.provider as never,
		chainId: params.chainId,
	});
	announced = wallet.cleanup;

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

	status.set({step: 'Booting', what: 'buying an avatar for everyone'});
	await stakeForEveryoneInTheWorld({
		env,
		player: wallet.accounts[0],
		table,
	});

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
		const player =
			seat.occupant.kind === 'you' ? params.player : seat.occupant.address;
		await stakeForOfflinePlayer({env: params.env, player});
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
		// THE PRICE EXACTLY, read off the same config the sale was deployed with.
		// `SaleViaNativePayment.purchase` requires `msg.value` minus the stipend
		// to equal `PAYMENT_AMOUNT` exactly, so a value computed anywhere else is
		// a value that can drift into reverting every purchase.
		value: config.data.sale.default.price,
	});
}

/** The seats the world plays, with the identity each of their keys plays as. */
export function playedByTheWorld(table: Table): readonly OfflinePlayer[] {
	return seatsPlayedByTheWorld(table).map((played) => ({
		privateKey: played.privateKey,
		identity: offlineIdentityOf(played.address),
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
