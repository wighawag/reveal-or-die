import type {Context, TxObserverDebugState} from './types.js';
import {writable, derived, type Readable} from 'svelte/store';
import {createWalletClient, custom, http} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {createAccountData} from '$lib/account/AccountData.js';
import {establishRemoteConnection} from '$lib/core/connection';
import {createBalanceStore} from '$lib/core/connection/balance';
import {createGasFeeStore} from '$lib/core/connection/gasFee';
import {createRpcHealthStore} from '$lib/core/connection/rpcHealth';
import {createOfflineStore} from '$lib/core/connection/offline';
import {createClockStore} from '$lib/core/clock';
import {createDelegationState} from '$lib/onchain/delegation.js';
import {createDelegationCheckStore} from '$lib/ui/delegation/delegation-check.js';
import {createConfirmation} from '$lib/core/ui/confirm/confirmation.js';
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
	PUBLIC_IMPERSONATE_ADDRESSES,
	PUBLIC_FAUCET_LINK,
	PUBLIC_FAUCET_API,
} from '$env/static/public';
import {hasFaucet} from '$lib/core/ui/faucet/index.js';
import {createTopUpFlow} from '$lib/ui/credits/top-up-flow.js';
import {burnerOverride} from '$lib';
import {resolveBurnerWallet} from './burner.js';
import {
	resolveConnectionConfig,
	TARGET_STEP,
} from '$lib/core/connection/mode.js';
import {resolveSignerRpc} from '$lib/core/connection/signer-rpc.js';
import {hasConfiguredRpc} from '$lib/core/connection/rpc-config.js';
import {
	createNonceCacheStore,
	inactiveNonceCacheStore,
} from '$lib/core/connection/nonce-cache-store.js';
import {
	createExecutor,
	memoiseSignerClient,
	type ExecutorStore,
} from '$lib/core/connection/executor.js';
import {createAccountCannotSendStore} from '$lib/core/transaction/account-cannot-send-store.js';
import {createErrorDetailsStore} from '$lib/core/transaction/error-details-store.js';
import type {AugmentedChainInfo} from '$lib/core/connection/types.js';
import {createBalanceCheckStore} from '$lib/core/transaction/balance-check-store.js';
import {resolveAppConfig, operationScopeAddress} from './config.js';
import {startTxObserverLoop} from '$lib/core/tx-observer';
import {parseImpersonateAddresses} from '$lib/dev-accounts.js';

/**
 * Build the app context.
 *
 * Synchronous, and constructible off-browser: every service it composes idles
 * when browser APIs are absent, so this also runs during SSR and prerendering.
 * Nothing here starts IO; that belongs to `start()`, which the provider calls
 * from `onMount`. Readiness is expressed as store state, never as an
 * unresolved promise. See ADR-0002.
 */
/**
 * What the game half is built on.
 *
 * The core services that exist before any game does, and that a game needs in
 * order to read the chain and send transactions. Passed explicitly rather than
 * the whole `Context`, so the dependency stays one-way: the game knows about
 * the core, the core does not know about the game.
 *
 * Note there are TWO executors, and which one a game reaches for is a decision
 * about who should be prompted. Moves go through `signerExecutor` and are
 * silent; anything that moves the player's assets goes through
 * `accountExecutor` and prompts, deliberately.
 */
export type CoreServices = {
	connection: Context['connection'];
	publicClient: Context['publicClient'];
	deployments: Context['deployments'];
	account: Context['account'];
	/** The authenticated account. Prompts. For anything that spends assets. */
	accountExecutor: Context['accountExecutor'];
	/** The local signer. Silent. For whatever the app does on the user's behalf. */
	signerExecutor: Context['signerExecutor'];
	/** Whether this app signs in, and so whether a signer exists at all. */
	hasLocalSigner: boolean;
	/** Gas held by the signer: what pays for moves. */
	signerBalance: Context['signerBalance'];
	/** Gas held by the authenticated account: what pays for assets. */
	accountBalance: Context['accountBalance'];
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
			impersonateAddresses: [
				...parseImpersonateAddresses(PUBLIC_IMPERSONATE_ADDRESSES),
			],
		});
		cleanupBurnerWallet = cleanup;
	}

	// How the app authenticates. `targetStep` is config (see core/connection/mode);
	// only the hosted-mechanism host comes from env. Total, so nothing here can
	// fail: there is no illegal combination left to reject.
	const {targetStep, walletHost, walletOnly} = resolveConnectionConfig(
		TARGET_STEP,
		PUBLIC_WALLET_HOST,
	);

	/**
	 * Whether this app has a local signer at all.
	 *
	 * The one predicate everything downstream uses. Deliberately NOT "is
	 * PUBLIC_WALLET_HOST set": a wallet-only sign-in has no host and still
	 * derives a signer, so testing the host would get it wrong.
	 */
	const hasLocalSigner = targetStep === 'SignedIn';

	// ----------------------------------------------------------------------------
	// CONNECTION
	// ----------------------------------------------------------------------------

	const {
		connection,
		walletClient: rawWalletClient,
		publicClient,
		account,
		signer,
		payment,
		deployments,
		forceRpcFailure,
	} = establishRemoteConnection({
		nodeURL: PUBLIC_NODE_URL,
		targetStep,
		walletHost,
		walletOnly,
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
	const {finality, txObserverProcessInterval, maxMessages, credits} =
		resolveAppConfig(chain);

	// A local signer broadcasts raw transactions. It prefers a real node RPC
	// (PUBLIC_NODE_URL or an rpcUrl configured on the chain), and REQUIRES one
	// under hosted sign-in, where the account may have no wallet to fall back to.
	// Missing is recorded as fatal and surfaced by the init-error screen; the
	// resolved url also drives the signer client's transport below.
	const signerRpc = resolveSignerRpc(
		{targetStep, walletOnly},
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
	// TRANSACTION EXECUTORS
	// ----------------------------------------------------------------------------
	//
	// TWO of them, named for WHO SIGNS, and call sites pick by intent. There is no
	// mode and no default: "which account is this transaction from" is a property
	// of what the transaction DOES, not of how the app is configured.
	//
	// - `accountExecutor`: the account the user authenticated as. Prompts. Use it
	//   for anything only the account may do, or that moves the user's own money
	//   (getting an asset out of an app, say).
	// - `signerExecutor`: the local signer, derived at sign-in. Silent, and free
	//   of the user's attention. Use it for whatever the app does on the user's
	//   behalf, which for a game is every move.
	//
	// Both always exist. The signer one simply never reaches `ready` when the app
	// does not sign in, so a call site handles that the same way it already
	// handles "not connected yet" - no optional stores, no branching on config.
	//
	// The signer client is built HERE (not inside the executor) because this is
	// where its concrete pieces live: the chain from deployments, the node RPC
	// URL, and the same tracker config as `walletClient` (so signer transactions
	// get identical metadata/observation wiring). The executor only sees the
	// finished tracked client, keeping it free of construction concerns.
	//
	// MEMOISED across both executors, and that matters for correctness rather
	// than for cost: without it the two would hold DIFFERENT client objects for
	// the same signer, and the tracking connector, which identifies clients by
	// reference, would listen to only one of them. See memoiseSignerClient.
	const buildSignerClient = memoiseSignerClient((privateKey) => {
		const account = privateKeyToAccount(privateKey);
		const raw = createWalletClient({
			account,
			chain: deployments.get().chain,
			// Broadcast over the resolved node RPC (PUBLIC_NODE_URL or a chain
			// rpcUrl) when there is one. Hosted sign-in guarantees it (see
			// resolveSignerRpc above, which makes its absence fatal); under
			// wallet-only sign-in every account has a wallet, so the connection
			// provider is a real fallback rather than a hopeful one.
			transport: signerRpcUrl
				? http(signerRpcUrl)
				: custom(connection.provider),
		});
		return {client: trackerBuilder.using(raw, publicClient), account};
	});

	const accountExecutor = createExecutor({
		connection,
		walletClient,
		sendFrom: 'account',
		buildSignerClient,
	});

	const signerExecutor = createExecutor({
		connection,
		walletClient,
		sendFrom: 'signer',
		buildSignerClient,
	});

	const accountCannotSend = createAccountCannotSendStore();
	const errorDetails = createErrorDetailsStore();

	// The address each executor sends from, or undefined until it is ready. The
	// matching balance follows it, so a shown or gating balance always belongs to
	// the account that would actually pay.
	const addressOf = (executor: ExecutorStore) =>
		derived(executor, ($executor) =>
			$executor.status === 'ready' ? $executor.address : undefined,
		);

	// ----------------------------------------------------------------------------

	const config = {maxMessages};

	const gasFee = createGasFeeStore({
		publicClient: publicClient,
		fetchGate: chainFetchGate,
	});

	const balanceCheck = createBalanceCheckStore({
		publicClient,
		gasFee,
	});

	// Whether this browser's signer may act for the account. Scoped to the
	// account AND its signer, so it resets when either changes, and gated the
	// same way the game's chain reads are: with no app RPC there is nothing to
	// read it over until a wallet is connected.
	const signerAddress = derived(signer, ($signer) => $signer?.address);
	const delegation = createDelegationState({
		publicClient,
		// The Game itself: it adopts `core/UsingDelegation.sol`, so the authority
		// to play as an account is recorded by the same contract that holds that
		// account's reserve and cells. An address rather than a contract name,
		// because delegation is a feature with a fixed ABI and not a property of
		// any one app - see DELEGATION_ABI.
		registry: deployments.get().contracts.Game.address,
		account,
		signer: signerAddress,
		fetchGate: chainFetchGate,
	});

	// The yes/no questions the app has to ask before going on: "carry on with
	// what you were doing?", "your wallet may still have this, really stop?".
	// One mechanism, one modal, and the words come from whoever asks.
	// See core/ui/confirm.
	const confirmation = createConfirmation();

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

	// Both executors' clients feed Account Data, so a transaction is recorded
	// whichever key signed it. Operations are keyed by the AUTHENTICATED account,
	// not by the sender, so the signer's moves and the account's transactions
	// belong to the same player and land in one list.
	const trackedWalletConnector = createTrackedWalletConnector({
		walletClient,
		executors: [accountExecutor, signerExecutor],
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
	// BALANCE AND COSTS
	// ----------------------------------------------------------------------------

	// One balance per executor, named the same way. A call site that named the
	// executor it sends from names the matching balance, so the two can never
	// drift apart the way a single "the balance" did.
	//
	// Both are plain pollers over one address, and both are inert until something
	// subscribes: an app that never shows the signer's gas never fetches it, and
	// a deployment with no signer never has an address to fetch.
	const accountBalance = createBalanceStore({
		publicClient,
		account: addressOf(accountExecutor),
	});

	// The signer's gas. Not the same thing as "what the app spends": the signer
	// pays for what the app does on the user's behalf, and it starts empty, so
	// this is what the credits UI reads to tell the user they cannot move yet.
	const signerBalance = createBalanceStore({
		publicClient,
		account: addressOf(signerExecutor),
	});

	// ----------------------------------------------------------------------------
	// THE GAME
	// ----------------------------------------------------------------------------
	//
	// Injected rather than imported, so this file stays the half that is merged
	// down from jolly-roger. It is built HERE, part-way through, rather than
	// before or after: the game needs the connection, the executors and the
	// balance check that already exist above, while the RPC-health store and the
	// refresh action below need the game's chain reads. Construction order is the
	// only thing that resolves that, so it is made explicit instead of worked
	// around with a placeholder store or a mutable hole.
	const services: CoreServices = {
		connection,
		publicClient,
		deployments,
		account,
		accountExecutor,
		signerExecutor,
		hasLocalSigner,
		signerBalance,
		accountBalance,
		balanceCheck,
		accountData,
		txObserver,
		clock,
		chainFetchGate,
		canReadChain,
		hasAppRpc,
	};
	const gameContext = params.createGame(services);

	// Both chain reads that a transaction of ours can invalidate: the board, and
	// whether the signer is still a delegate. The registration lands in a
	// transaction the app itself sent, so without the second one the UI would go
	// on refusing to send until the next slow poll.
	const onchainStateRefreshConnector = createOnchainStateRefreshConnector({
		txObserver,
		stores: [gameContext.onchainState, delegation],
	});

	// Health reflects whether we can read the chain right now. All inputs share
	// one transport, so any recent success (e.g. the 5s onchain-state poll, or a
	// user Retry) means the RPC is up and clears the banner, without waiting for
	// the slow gas poller to retry.
	const rpcHealth = createRpcHealthStore({
		inputs: [accountBalance, gasFee, gameContext.onchainState],
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
		void accountBalance.update();
		// No-op when there is no signer (the poller's gate refuses the fetch), so
		// this stays safe in an app that does not sign in.
		void signerBalance.update();
	};
	const offline = createOfflineStore();

	// Built here rather than in the component that shows it, because the account
	// panel and the insufficient-funds modal must drive the SAME flow: the modal
	// opens it for a transaction that is already blocked, and the panel opens it
	// on its own, and a second instance would let both run at once.
	//
	// For this template that second driver matters more than it does upstream:
	// the signer pays for every commit and every reveal, so it is the account
	// that runs dry, and it is the one a faucet aimed at the user's wallet can
	// never fix.
	const topUp = createTopUpFlow(
		{
			connection,
			payment,
			signerBalance,
			credits,
			deployments,
			accountExecutor,
			accountBalance,
			publicClient,
			balanceCheck,
			delegation,
			confirmation,
		},
		{
			faucetApi: PUBLIC_FAUCET_API,
			faucetLink: PUBLIC_FAUCET_LINK,
			hasFaucet,
		},
	);

	// Getting past "this browser may not act for you yet" WITHOUT losing what the
	// user was doing. Built here for the same reason the top-up flow is: the send
	// that was interrupted waits on it, and the modal that resumes it has to be
	// driven by the same instance. See ui/delegation/delegation-check.
	const delegationCheck = createDelegationCheckStore({
		delegation,
		topUp,
		confirmation,
	});

	// Debug store for tx-observer processing stats
	const txObserverDebug = writable<TxObserverDebugState>({
		processCount: 0,
		lastProcessTime: null,
		isLeader: false,
	});

	const context: Context = {
		fatal: {subscribe: fatal.subscribe},
		gasFee,
		accountBalance,
		signerBalance,
		credits,
		payment,
		rpcHealth,
		nonceCache,
		refreshChainData,
		hasAppRpc,
		canReadChain,
		forceRpcFailure,
		offline,
		connection,
		walletClient,
		accountExecutor,
		signerExecutor,
		hasLocalSigner,
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
		topUp,
		delegation,
		delegationCheck,
		confirmation,
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
			const unsubscribeFromBalance = accountBalance.subscribe(() => {});
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
