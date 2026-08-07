import type {Context, TxObserverDebugState} from './types.js';
import {writable, derived, type Readable} from 'svelte/store';
import {createWalletClient, custom, http} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {createAccountData} from '$lib/account/AccountData.js';
import {establishRemoteConnection} from '$lib/core/connection';
import {createBalanceStore} from '$lib/core/connection/balance';
import {createSignerBalanceStore} from '$lib/core/connection/signerBalance';
import {createGasFeeStore} from '$lib/core/connection/gasFee';
import {createRpcHealthStore} from '$lib/core/connection/rpcHealth';
import {createOfflineStore} from '$lib/core/connection/offline';
import {createClockStore} from '$lib/core/clock';
import {createTransactionObserver} from '@etherkit/tx-observer';
import {createTabLeaderService} from '$lib/core/tab-leader';
import {createTrackedWalletClient} from '@etherkit/viem-tx-tracker';
import {
	createTrackedWalletConnector,
	createTransactionObserverConnector,
	createOnchainStateRefreshConnector,
} from '$lib/account/connectors.js';
import {createToastConnector} from '$lib/account/toastConnector.js';
import {initBurnerWallet} from '@etherkit/burner-wallet';
import {
	PUBLIC_NODE_URL,
	PUBLIC_CHAIN_INFO_NODE_URL,
	PUBLIC_USE_BURNER_WALLET,
	PUBLIC_WALLET_HOST,
	PUBLIC_EXECUTION_MODE,
} from '$env/static/public';
import {burnerOverride} from '$lib';
import {resolveBurnerWallet} from './burner.js';
import {resolveConnectionMode} from '$lib/core/connection/mode.js';
import {resolveSignerRpc} from '$lib/core/connection/signer-rpc.js';
import {hasConfiguredRpc} from '$lib/core/connection/rpc-config.js';
import {
	createNonceCacheStore,
	inactiveNonceCacheStore,
} from '$lib/core/connection/nonce-cache-store.js';
import {createExecutor} from '$lib/core/connection/executor.js';
import {createAccountCannotSendStore} from '$lib/core/transaction/account-cannot-send-store.js';
import {createErrorDetailsStore} from '$lib/core/transaction/error-details-store.js';
import type {AugmentedChainInfo} from '$lib/core/connection/types.js';
import {createBalanceCheckStore} from '$lib/core/transaction/balance-check-store.js';
import {resolveAppConfig, operationScopeAddress} from './config.js';
import {startTxObserverLoop} from '$lib/core/tx-observer';
import {IMPERSONATE_ADDRESSES} from '$lib/dev-accounts.js';

/**
 * What the game half is built on.
 *
 * The core services that exist before any game does, and that a game needs in
 * order to read the chain and send transactions. Passing this explicitly (as
 * opposed to the whole `Context`) is what keeps the dependency one-way: the
 * game knows about the core, the core does not know about the game.
 */
export type CoreServices = {
	connection: Context['connection'];
	publicClient: Context['publicClient'];
	deployments: Context['deployments'];
	/** The authenticated account: the wallet or the hosted sign-in identity. */
	account: Context['account'];
	/**
	 * Sends transactions the way the APP is configured to, which for anything
	 * that moves the player's money means from their wallet, with a prompt.
	 */
	executor: Context['executor'];
	/**
	 * Sends the GAME's transactions, always from the local signer. Use this for
	 * commit and reveal; use `executor` for anything that spends the player's
	 * funds. See the comment where it is built.
	 */
	gameExecutor: Context['executor'];
	/**
	 * The address the game plays as (the local signer), or undefined until the
	 * player is signed in.
	 */
	gameIdentity: Readable<`0x${string}` | undefined>;
	/**
	 * Whether this deployment can ever produce a signer. False in a wallet-only
	 * setup, where the game cannot be played and the UI should say so.
	 */
	gameIdentityAvailable: boolean;
	/** Gas held by the signer that pays for moves (and by its owner). */
	signerBalance: Context['signerBalance'];
	balanceCheck: Context['balanceCheck'];
	accountData: Context['accountData'];
	txObserver: Context['txObserver'];
	clock: Context['clock'];
	/**
	 * Chain reads only run while this is truthy. Undefined when the app has its
	 * own RPC, in which case there is nothing to wait for.
	 */
	chainFetchGate: Readable<boolean> | undefined;
	canReadChain: Context['canReadChain'];
	hasAppRpc: boolean;
};

/**
 * The parts of the context the game half supplies.
 *
 * Structural rather than an import of the game's own type, so this file has no
 * dependency on any particular game.
 */
export type InjectedGame = {
	onchainState: Context['onchainState'];
	viewState: Context['viewState'];
	game: Context['game'];
	render: Context['render'];
	start(): () => void;
};

/**
 * Build the app context.
 *
 * Synchronous, and constructible off-browser: every service it composes idles
 * when browser APIs are absent, so this also runs during SSR and prerendering.
 * Nothing here starts IO; that belongs to `start()`, which the provider calls
 * from `onMount`. Readiness is expressed as store state, never as an
 * unresolved promise. See ADR-0002.
 *
 * This is the CORE half: what jolly-roger provides, and what descendants merge
 * down from it. The game is injected through `createGame` so that this file can
 * be taken from upstream more or less unchanged. See `./game.ts`.
 */
export function createCoreContext(params: {
	createGame: (services: CoreServices) => InjectedGame;
}): {
	context: Context;
	start: () => () => void;
} {
	let cleanupBurnerWallet: (() => void) | undefined;

	// Reasons the app cannot run. Collected rather than thrown: the context is
	// also constructed during SSR / prerender, where a throw would fail the build
	// instead of showing the user anything. See ADR-0002.
	const fatal = writable<string | undefined>(undefined);

	const burner = resolveBurnerWallet(
		burnerOverride,
		PUBLIC_USE_BURNER_WALLET,
		PUBLIC_NODE_URL,
	);
	// An explicit `?burner=true` that cannot be honoured is an error rather than
	// being silently ignored. It is raised in start() rather than here: it comes
	// from the URL, which is empty on the server, so setting it now would make
	// the browser's first render disagree with the prerendered HTML.
	const burnerFatal =
		burner.use === false && burner.error ? burner.error : undefined;
	// Browser-only: the burner announces itself over EIP-6963 on `window`. The
	// context is also constructed during SSR / prerender, where there is no
	// wallet to announce to. See ADR-0002.
	if (burner.use && typeof window !== 'undefined') {
		const {cleanup} = initBurnerWallet({
			nodeURL: burner.nodeURL,
			impersonateAddresses: [...IMPERSONATE_ADDRESSES],
		});
		cleanupBurnerWallet = cleanup;
	}

	// Resolve the connection + execution mode from env. The one illegal
	// combination (signer execution without hosted sign-in) is recorded as fatal
	// here and surfaced by the init-error screen.
	const modeResolution = resolveConnectionMode(
		PUBLIC_WALLET_HOST,
		PUBLIC_EXECUTION_MODE,
	);
	if (!modeResolution.ok) {
		fatal.set(modeResolution.error);
	}
	// Env-derived, so identical on the server and in the browser: the error
	// screen prerenders and hydrates without a mismatch. The fallback below is
	// never actually used, since the layout renders the error instead of the app;
	// it only lets construction finish.
	const {walletHost, executionMode, targetStep} = modeResolution.ok
		? modeResolution.mode
		: {
				walletHost: undefined,
				executionMode: 'wallet' as const,
				targetStep: 'WalletConnected' as const,
			};

	// ----------------------------------------------------------------------------
	// CONNECTION
	// ----------------------------------------------------------------------------

	const {
		connection,
		walletClient: rawWalletClient,
		publicClient,
		account,
		// The local signer derived at sign-in. The game plays as this; see the
		// game executor below.
		signer,
		deployments,
		forceRpcFailure,
	} = establishRemoteConnection({
		nodeURL: PUBLIC_NODE_URL,
		walletHost,
		// The RPC url handed to the WALLET, which is not necessarily the one the
		// app uses. Without it the exported chain info carries an empty rpc list
		// (rocketh does not bake a public endpoint into chain info), and a wallet
		// that does not already know the chain cannot be told how to reach it:
		// wallet_switchEthereumChain fails with "Unrecognized chain ID" and there
		// is nothing to fall back to wallet_addEthereumChain with.
		//
		// Deliberately NOT defaulted to PUBLIC_NODE_URL: that one may be a private
		// or key-bearing endpoint, and this value is handed to every user's wallet.
		chainInfoNodeURL: PUBLIC_CHAIN_INFO_NODE_URL,
	});

	// ----------------------------------------------------------------------------
	// CHAIN CONFIGURATION
	// ----------------------------------------------------------------------------

	// Resolve chain-specific configuration (finality, block time, intervals)
	// from the chain's optional properties + defaults.
	const chain = deployments.get().chain as AugmentedChainInfo;
	const {finality, txObserverProcessInterval, maxMessages} =
		resolveAppConfig(chain);

	// Signer mode broadcasts from a local signer and so needs a real node RPC
	// (PUBLIC_NODE_URL or an rpcUrl configured on the chain). Wallet mode does
	// not (the wallet provides the RPC). Signer-mode with no RPC is recorded as
	// fatal and surfaced by the init-error screen; the resolved url also drives
	// the signer client's transport below.
	const signerRpc = resolveSignerRpc(
		executionMode,
		PUBLIC_NODE_URL,
		chain.rpcUrls?.default?.http,
		import.meta.env.DEV,
	);
	if (!signerRpc.ok) {
		fatal.set(signerRpc.error);
	}
	const signerRpcUrl = signerRpc.ok ? signerRpc.rpcUrl : undefined;

	// Whether the app has an RPC of its own (PUBLIC_NODE_URL or a chain rpcUrl).
	// When it does not, the app can only reach the chain via the connected wallet,
	// so chain-data fetching must wait until the wallet is connected (otherwise it
	// would fail and look like a broken RPC). Exposed so the UI can explain this.
	const hasAppRpc = hasConfiguredRpc(
		PUBLIC_NODE_URL,
		chain.rpcUrls?.default?.http,
	);

	// Whether the app can read the chain right now: it has its own RPC, or the
	// wallet is connected (and supplies one). Always a boolean, so UI can gate
	// fetches and show a "connect to load" state instead of firing calls that
	// would fail and look like a broken RPC. See also chainFetchGate below.
	const canReadChain = derived(
		connection,
		($c) => hasAppRpc || connection.isTargetStepReached($c),
	);

	// Gate for chain reads (onchain state, gas). With an app RPC, fetch
	// unconditionally. Without one, only fetch once the wallet is connected (its
	// provider then supplies the RPC), so we do not fire calls that would fail and
	// look like a broken RPC while disconnected.
	const chainFetchGate = hasAppRpc ? undefined : canReadChain;

	// Reactive clock store that updates every second for smooth "time ago" displays
	const clock = createClockStore();

	// ----------------------------------------------------------------------------
	// TRACKED WALLET CLIENT
	// ----------------------------------------------------------------------------

	// Wrap the raw wallet client with tracking capabilities
	// This is exposed as `walletClient` for drop-in compatibility
	// Use `walletClient.walletClient` to access the underlying viem WalletClient if needed
	const trackerBuilder = createTrackedWalletClient({
		populateMetadata: true,
		clock: () => clock.now(),
	});
	const walletClient = trackerBuilder.using(rawWalletClient, publicClient);

	// ----------------------------------------------------------------------------
	// TRANSACTION EXECUTOR
	// ----------------------------------------------------------------------------
	// Mode-agnostic front for sending transactions (wallet account vs local
	// signer). Call sites use this instead of the wallet client + account address.
	//
	// The signer-mode client is built HERE (not inside the executor) because this
	// is where its concrete pieces live: the chain from deployments, the node RPC
	// URL, and the same tracker config as `walletClient` (so signer-mode
	// transactions get identical metadata/observation wiring). The executor only
	// sees the finished tracked client, keeping it free of construction concerns.
	const buildSignerClient = (privateKey: `0x${string}`) => {
		const account = privateKeyToAccount(privateKey);
		const raw = createWalletClient({
			account,
			chain: deployments.get().chain,
			// Broadcast over the resolved node RPC (PUBLIC_NODE_URL or a chain
			// rpcUrl). Signer mode guarantees one exists (see resolveSignerRpc
			// above); the connection-provider fallback only applies to non-signer
			// use where a signer client would not actually be built.
			transport: signerRpcUrl
				? http(signerRpcUrl)
				: custom(connection.provider),
		});
		return {client: trackerBuilder.using(raw, publicClient), account};
	};

	const executor = createExecutor({
		connection,
		walletClient,
		executionMode,
		buildSignerClient,
	});

	// ----------------------------------------------------------------------------
	// THE GAME'S EXECUTOR
	// ----------------------------------------------------------------------------
	//
	// A SECOND executor, pinned to the local signer whatever `PUBLIC_EXECUTION_MODE`
	// says. Game moves go through this one; everything else keeps using `executor`.
	//
	// A commit-reveal round is at least two transactions per epoch, forever. Sent
	// from the wallet that means a MetaMask prompt for every commit AND every
	// reveal, which is unusable for a game and actively dangerous here: a reveal
	// the player does not approve in time costs them their stake. Worse, an
	// account authenticated by email or social sign-in has NO wallet provider at
	// all, so under wallet execution it cannot send anything and simply cannot
	// play.
	//
	// The local signer solves both. It is derived from the signed-in account and
	// the origin, so it is the same key on every device the player signs in from,
	// and it can sign without prompting. What it must NOT be used for is spending
	// the player's money: buying in and topping up the stake stay on `executor`,
	// so value leaves the wallet the player controls, with a prompt, deliberately.
	const signerExecutor = createExecutor({
		connection,
		walletClient,
		executionMode: 'signer',
		buildSignerClient,
	});

	/**
	 * Whether this deployment has a local signer at all.
	 *
	 * A signer only exists under hosted sign-in (`PUBLIC_WALLET_HOST`). Without
	 * it the connection never reaches `SignedIn`, so there is no key to play
	 * with and the game falls back to the wallet: correct, but it means a
	 * signature prompt for every commit and every reveal, and no play at all for
	 * an email/social account. Surfaced so the UI can say that plainly instead of
	 * failing one move at a time.
	 *
	 * Chosen per DEPLOYMENT rather than per moment. Picking whichever executor
	 * happens to be ready would quietly send a move through the wallet while a
	 * sign-in was still in flight, which is the exact prompt this avoids.
	 */
	const hasLocalSigner = targetStep === 'SignedIn';

	const gameExecutor = hasLocalSigner ? signerExecutor : executor;

	/** The address the game plays as. */
	const gameIdentity = hasLocalSigner
		? derived(signer, ($signer) => $signer?.address)
		: account;
	const gameIdentityAvailable = hasLocalSigner;

	/**
	 * Gas held by the local signer, alongside its owner's.
	 *
	 * The signer pays for every move, and it starts empty: it is a fresh key, not
	 * the player's funded wallet. If it runs dry the round simply stops working,
	 * so the balance has to be visible up front rather than discovered when a
	 * reveal fails and takes the stake with it.
	 *
	 * `createSignerBalanceStore` ships in `$lib/core` as an unwired building
	 * block ("for smart-account / session-key setups where the signer is distinct
	 * from the owner, and a UI wants to show both balances"). That is exactly
	 * this, so it is wired here.
	 */
	const signerBalance = createSignerBalanceStore({publicClient, signer});

	const accountCannotSend = createAccountCannotSendStore();
	const errorDetails = createErrorDetailsStore();

	// The address that actually pays for transactions: the wallet/owner in wallet
	// mode, the local signer in signer mode. Balance checks and the top-bar
	// balance follow this (so the shown/gating balance matches the sender).
	const executorAddress = derived(executor, ($executor) =>
		$executor.status === 'ready' ? $executor.address : undefined,
	);

	// ----------------------------------------------------------------------------
	// BALANCE AND COSTS
	// ----------------------------------------------------------------------------
	//
	// Built here, ahead of the game, because the game's transactions go through
	// `balanceCheck` and so it has to exist before `createGame` is called.

	// Spending balance: the address that pays for transactions (executor).
	const balance = createBalanceStore({
		publicClient,
		account: executorAddress,
	});

	// Owner balance: the authenticated account (wallet/owner). In signer mode it
	// is a distinct account (whose funds can top up the signer), so it gets its
	// own poller. In wallet mode owner and spender are the same account, so it IS
	// the same store instance: consumers can subscribe to both without causing a
	// second poll for the same address.
	const ownerBalance =
		executionMode === 'signer'
			? createBalanceStore({publicClient, account})
			: balance;

	const gasFee = createGasFeeStore({
		publicClient: publicClient,
		fetchGate: chainFetchGate,
	});

	const balanceCheck = createBalanceCheckStore({
		publicClient,
		balance,
		gasFee,
	});

	// ----------------------------------------------------------------------------

	const accountData = createAccountData({
		accountStore: account,
		deployments: deployments.get(),
		clock,
		scopeAddress: operationScopeAddress(deployments.get()),
	});

	const txObserver = createTransactionObserver({
		finality,
		provider: connection.provider,
		// Injected wallets (e.g. MetaMask) can keep serving a stale pending view
		// from eth_getTransactionByHash (blockNumber null) for an already-mined
		// tx, while eth_getTransactionReceipt returns the real receipt. Fetch the
		// receipt directly in that case so inclusion is detected through the
		// user's own wallet-configured node (no dedicated/hardcoded RPC needed).
		alwaysFetchReceipt: true,
	});

	const tabLeader = createTabLeaderService();

	const trackedWalletConnector = createTrackedWalletConnector({
		walletClient,
		executor,
		accountData,
	});

	const txObserverConnector = createTransactionObserverConnector({
		accountData,
		txObserver,
	});

	const toastConnector = createToastConnector({
		accountData,
	});

	// ----------------------------------------------------------------------------
	// THE GAME
	// ----------------------------------------------------------------------------
	//
	// Injected rather than imported, so this file stays the part a descendant
	// merges down from jolly-roger untouched. It is built HERE, part-way through,
	// rather than before or after: the game needs the connection and the balance
	// check that already exist above, and the RPC-health store and the refresh
	// action below need the game's chain reads. Construction order is the only
	// thing that resolves that, so it is made explicit instead of being worked
	// around with a placeholder store or a mutable hole.
	const services: CoreServices = {
		connection,
		publicClient,
		deployments,
		account,
		executor,
		gameExecutor,
		gameIdentity,
		gameIdentityAvailable,
		signerBalance,
		balanceCheck,
		accountData,
		txObserver,
		clock,
		chainFetchGate,
		canReadChain,
		hasAppRpc,
	};
	const gameContext = params.createGame(services);

	const onchainStateRefreshConnector = createOnchainStateRefreshConnector({
		txObserver,
		onchainState: gameContext.onchainState,
	});

	// Health reflects whether we can read the chain right now. All inputs share
	// one transport, so any recent success (e.g. the 5s onchain-state poll, or a
	// user Retry) means the RPC is up and clears the banner, without waiting for
	// the slow gas poller to retry.
	const rpcHealth = createRpcHealthStore({
		inputs: [balance, gasFee, gameContext.onchainState],
	});

	// Wallet nonce-cache detection. Only meaningful when the app has its OWN
	// trusted node RPC to compare the wallet against, and only worth the extra
	// per-connect RPC calls in DEV (where restarting a local node desyncs the
	// wallet's cached nonce and silently strands transactions). In production, or
	// with no app RPC, we use the no-op store so nothing runs. signerRpcUrl is the
	// same resolved app RPC (PUBLIC_NODE_URL or chain rpcUrl) that hasAppRpc
	// reflects; when hasAppRpc is true it is defined.
	const nonceCache =
		typeof window !== 'undefined' &&
		import.meta.env.DEV &&
		hasAppRpc &&
		signerRpcUrl
			? createNonceCacheStore({
					connection,
					account,
					txObserver,
					nodeRpcUrl: signerRpcUrl,
				})
			: inactiveNonceCacheStore;

	// Refresh every chain read at once. Used by Retry actions and the health
	// banner so a single click heals the whole health picture, not just one store.
	const refreshChainData = () => {
		void gameContext.onchainState.update();
		void gasFee.update();
		void balance.update();
		if (ownerBalance !== balance) void ownerBalance.update();
	};
	const offline = createOfflineStore();

	// Debug store for tx-observer processing stats
	const txObserverDebug = writable<TxObserverDebugState>({
		processCount: 0,
		lastProcessTime: null,
		isLeader: false,
	});

	const context: Context = {
		fatal: {subscribe: fatal.subscribe},
		gasFee,
		balance,
		ownerBalance,
		rpcHealth,
		nonceCache,
		refreshChainData,
		hasAppRpc,
		canReadChain,
		forceRpcFailure,
		offline,
		connection,
		walletClient,
		executor,
		gameExecutor,
		gameIdentity,
		gameIdentityAvailable,
		signerBalance,
		executionMode,
		accountCannotSend,
		errorDetails,
		publicClient,
		account,
		deployments,
		accountData,
		clock,
		txObserver,
		txObserverDebug: {subscribe: txObserverDebug.subscribe},
		balanceCheck,
		// The game half, spread in so call sites see one context.
		onchainState: gameContext.onchainState,
		viewState: gameContext.viewState,
		game: gameContext.game,
		render: gameContext.render,
	};

	// Dev/debug: expose the whole context on globalThis for console access
	// (e.g. `context.balance`). Self-maintaining: new context members appear
	// automatically. Delete this line if you don't want it.
	if (typeof window !== 'undefined') {
		(globalThis as any).context = context;
	}

	return {
		context,
		start: () => {
			// Raised here, not at construction: it is derived from the URL, which
			// only exists in the browser. Doing it on mount keeps the first client
			// render identical to the prerendered HTML.
			if (burnerFatal) fatal.set(burnerFatal);

			// we trigger it so it is always availabe
			const unsubscribeFromBalance = balance.subscribe(() => {});
			// we trigger it so it is always availabe
			const unsubscribeFromGasFee = gasFee.subscribe(() => {});

			tabLeader.start();

			const stopTxObserverLoop = startTxObserverLoop({
				tabLeader,
				txObserver,
				intervalMs: txObserverProcessInterval,
				// App concern: record debug stats. The core loop stays free of any
				// app-specific state shape.
				onProcess: () =>
					txObserverDebug.update((state) => ({
						...state,
						processCount: state.processCount + 1,
						lastProcessTime: Date.now(),
					})),
				onLeadershipChange: (isLeader) =>
					txObserverDebug.update((state) => ({...state, isLeader})),
			});

			trackedWalletConnector.connect();
			txObserverConnector.connect();
			toastConnector.connect();
			onchainStateRefreshConnector.connect();

			const stopGame = gameContext.start();

			return () => {
				stopGame();
				cleanupBurnerWallet?.();
				trackedWalletConnector.disconnect();
				txObserverConnector.disconnect();
				toastConnector.disconnect();
				onchainStateRefreshConnector.disconnect();
				stopTxObserverLoop();
				tabLeader.stop();
				unsubscribeFromBalance();
				unsubscribeFromGasFee();
			};
		},
	};
}
