import {writable, type Readable} from 'svelte/store';
import {
	config,
	extensions,
	CYCLE_POLICY,
} from 'template-commit-reveal-contracts/rocketh/config.js';
import deployToken from 'template-commit-reveal-contracts/deploy/001_deploy_token.js';
import deployAvatars from 'template-commit-reveal-contracts/deploy/005_deploy_avatars.js';
import deployGame from 'template-commit-reveal-contracts/deploy/010_deploy_game.js';
import deployStakeSale from 'template-commit-reveal-contracts/deploy/020_deploy_stake_sale.js';
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

const CHAIN_ID_STORAGE_KEY = 'offline-world:chain-id';
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

export function startOfflineWorld(): Promise<OfflineWorldStatus> {
	if (!pending) {
		pending = buildOfflineWorld().catch((err) => {
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

async function buildOfflineWorld(): Promise<OfflineWorldStatus> {
	// The id is minted once and remembered, because it is what keys everything
	// the player keeps: the operations ledger, and this game's submission
	// storage (`placement/storage.ts` keys by `chainID_gameAddress_player`). See
	// `lib/embedded/chain-id.ts`.
	const chainId = rememberChainId({
		storage: localStorage,
		key: CHAIN_ID_STORAGE_KEY,
	});

	const world = await openWorld(chainId);

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
	 * It also has nowhere to live. The app's connect button is in the NAVBAR,
	 * which is in `+layout.svelte`, outside every route subtree and bound to the
	 * app's own context - so it connects the remote world, not this one. That is
	 * the chrome gap the route says out loud, and until it is closed a nested
	 * world that waited to be connected would simply never be.
	 *
	 * NOT FATAL IF IT FAILS. The world, the chain and the deploy are all fine
	 * without a connection; what the player loses is the ability to send, and the
	 * game already says so through the setup gate. Failing the boot instead would
	 * throw away a chain over a recoverable step.
	 */
	status.set({step: 'Booting', what: 'connecting'});
	try {
		await connectOfflinePlayer(context.context.connection);
	} catch (err) {
		console.error('the offline world could not connect its own wallet', err);
	}

	const ready: OfflineWorldStatus = {step: 'Ready', world, context};
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
 *
 * It is also what makes the operations ledger honest. That ledger already
 * persists (it always did, keyed by chain id), and without a persisted chain it
 * would come back describing transactions on a chain that no longer exists.
 */
async function openWorld(chainId: number): Promise<EmbeddedWorld> {
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
		return openWorld(fresh);
	}

	return createEmbeddedWorld({
		chainId,
		chain: {
			name: 'Offline',
			nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
			properties: {
				// THE LOCAL CHAIN'S OWN PROPERTIES, read out of the deploy config
				// rather than typed again: `expectedWorstGasPrice` and
				// `creditsGasMultiplier` are what denominate the play key's gas in
				// MOVES, and a second copy of either is a number that can drift into
				// telling the player they have more turns than they do.
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
		// The manual policy and the two zeroes are the whole of what is different
		// about an offline deployment. See `OFFLINE_DEPLOYMENT`.
		data: {...OFFLINE_DEPLOYMENT.data},
		accounts: {...OFFLINE_DEPLOYMENT.accounts},
		initialBalances: {...OFFLINE_DEPLOYMENT.initialBalances},
		persistence: createIndexedDBPersistence({
			db: `offline-world-chain:${chainId}`,
		}),
		deploymentStore,
		provision: (params) => provisionOfflinePlayer({...params, chainId}),
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
 * 3. **A STAKE**, which is what THIS game puts at risk and therefore the only
 *    reason anybody here has to reveal. Bought through `StakeSale.purchase`,
 *    the same rail the online purchase uses, rather than by minting and
 *    bonding by hand: the rail is one call that mints, stakes for the player
 *    and can forward a gas stipend, and using it here means the offline world
 *    exercises the contract path the online one depends on instead of a
 *    private shortcut that could quietly stop matching it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO IS AUTHORISE THE BROWSER'S KEY. The signer
 * is derived in the tab from a wallet signature AFTER this runs (and after the
 * context exists at all), so the world cannot know its address, let alone
 * register it. That step stays the player's one press, which is the honest
 * split: the world gives what only the world can give - a chain, contracts,
 * gas and a stake - and the browser gives what only it can, a key and the
 * authority to play with it.
 *
 * THE STIPEND IS ZERO HERE, and the sale refuses a stipend with nowhere to go,
 * so the two move together. There is no key to forward gas to yet, for the
 * reason in the paragraph above.
 */
async function provisionOfflinePlayer(params: {
	env: EmbeddedWorld['env'];
	node: {provider: {request: (args: never) => Promise<unknown>}};
	chainId: number;
}) {
	const {env, node} = params;

	status.set({step: 'Booting', what: 'handing the player a wallet'});
	const wallet = await announceEmbeddedWallet({
		provider: node.provider as never,
		chainId: params.chainId,
	});
	announced = wallet.cleanup;

	// GAS IS FREE HERE AND THE STAKE IS NOT, which is the one asymmetry in this
	// function and it is deliberate. This runs on EVERY boot, including a restore,
	// so a balance set unconditionally is a refill on every reload - and that is
	// the right answer for gas, which is a number on a chain in a tab and is not
	// what anybody is risking. The reserve below is the opposite case: it is what
	// this game puts AT STAKE, so topping it up on reload would make a missed
	// reveal cost nothing, and a stake that can be refilled by pressing F5 is not
	// a stake.
	for (const account of wallet.accounts) {
		await node.provider.request({
			method: 'evm_setBalance',
			params: [account, `0x${PLAY_MONEY.toString(16)}`],
		} as never);
	}

	status.set({step: 'Booting', what: 'staking for the player'});
	await stakeForOfflinePlayer({env, player: wallet.accounts[0]});

	// HANDED BACK rather than announced-and-hoped-for. The connection this world
	// builds will use exactly this wallet, so the player is never asked to
	// choose one.
	return {wallets: [wallet.handle]};
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
 * CONNECT, AND THEN SIGN IN, IN TWO STEPS RATHER THAN ONE.
 *
 * THE FIRST THING NOBODY HAD RUN, and it is worth the paragraph because the
 * plan predicted a surprise here without knowing which one. A world takes the
 * app's `targetStep` rather than choosing one, deliberately: a world chooses
 * the CHAIN, never how the app authenticates. This repo's `TARGET_STEP` is
 * `SignedIn`, and the branch the mechanism came from targets
 * `WalletConnected`, so an embedded world with a local signer derived over the
 * world's own burner existed on no branch upstream and no browser had been
 * pointed at it.
 *
 * What it does is hang. `ensureConnected()` with no argument means "reach the
 * connection's target step", the wallet connects by itself (one wallet, one
 * account, nothing to pick) and then it waits at `WalletConnected` forever,
 * because the step after it is a SIGNATURE and a signature is a thing an app
 * asks a person for: in the app that is the "Sign In" button on the connection
 * flow, which calls `requestSignature()`. This page mounts no flow, for the
 * reason written at the route, so there is no button and nobody to press it.
 *
 * So the world asks for the signature itself, and this is the one place where
 * that is honest rather than a shortcut. The message is origin-scoped and the
 * wallet that signs it was generated by this world seconds ago, holds one
 * account, exists in no other tab and auto-approves by declaration
 * (`WalletInfo.autoApproves`). There is no prompt to suppress and no decision
 * being taken from anybody. What the signature buys is exactly what it buys
 * online: the local signer this browser plays with, derived deterministically,
 * so that a commit and a reveal cost no prompts.
 *
 * `'WalletConnected'` is named explicitly for the first step because the target
 * cannot be reached without help; the same two-step shape is already used by
 * `core/connection/ensure-can-sign.ts` on a `SignedIn` connection, for the
 * different reason that paying only needs a wallet.
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
