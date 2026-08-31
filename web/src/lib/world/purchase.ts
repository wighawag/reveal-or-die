/**
 * Getting an avatar, which is the one thing a new player cannot do without.
 *
 * `AvatarsSale.purchase` mints and deposits in a SINGLE transaction: it is
 * given the Game's address as the recipient, so the NFT is minted straight into
 * the contract's custody and `avatarsPerOwner` reports it immediately. There is
 * no separate approve-and-transfer step, and there should not be one, because
 * the two-step version leaves an avatar sitting in a wallet where it does
 * nothing and looks like a bug.
 *
 * The OWNER is carried in `data` rather than being the recipient. That is the
 * whole trick of the arrangement: `to` is where the token goes (the Game), and
 * the encoded address is who it belongs to. `AvatarsSale._executeMint` decodes
 * it and packs it into the token id, which is why the id can be computed here
 * before the transaction is even sent.
 *
 * Unlike a move, this SPENDS THE PLAYER'S OWN MONEY, so it goes through
 * `accountExecutor` and prompts the wallet, and through `balanceCheck` so a
 * player who cannot cover it is told before signing rather than after. Moves go
 * the other way (silent, signer-paid) and `commit-reveal.ts` explains why.
 *
 * ONE TRANSACTION FOR THE WHOLE OF ONBOARDING, which is the point of the order
 * below and worth stating because it is not obvious:
 *
 *   1. the owner SIGNS a delegation. Free, no transaction, and for a hosted
 *      account not even a prompt: `fetchDelegation` returns the credential that
 *      was minted at sign-in.
 *   2. the owner sends ONE transaction, which buys the avatar into the game and
 *      forwards a stipend to the local signer in the same call.
 *   3. the SIGNER registers itself, paying out of the stipend it just received.
 *
 * What this replaces asked for two transactions from the owner and, on a fresh
 * wallet, two faucet claims: the first flow forwarded almost everything the
 * faucet gave to the signer, and the purchase then found an empty wallet. The
 * signature route is what removes the second one, and it is strictly better for
 * a hosted account, which has no wallet to prompt at all.
 *
 * Step 3 failing is survivable and deliberately not rolled back: the player owns
 * an avatar and this browser is not yet authorised, which is exactly the state
 * the `authorise` setup step exists for.
 */
import {derived, get, readable, writable, type Readable} from 'svelte/store';
import {logs} from 'named-logs';
import type {Context} from '$lib/context/types';
import {
	avatarIDFor,
	purchaseArgs,
	purchaseValue,
	randomSubID,
} from 'reveal-or-die-contracts';
import {isRegistered} from '$lib/onchain/delegation';
import {
	InsufficientFundsError,
	isUserRejectionError,
	txErrorSummary,
} from '$lib/core/transaction';
import {createBalanceStore} from '$lib/core/connection/balance';
import {
	availablePaymentMethods,
	paymentMethods,
	spendableBalance,
	NO_PAYMENT_METHOD_EXPLANATION,
	type PaymentMethod,
	type PaymentMethodId,
} from '$lib/core/funding';
import {effectiveGasPrice} from '$lib/core/connection/gasFee';
import {registrationRequest} from '$lib/ui/delegation/registration';
import {
	fetchDelegation,
	signsWithoutPrompt,
	submitRegistration,
	type RegistrationWriter,
} from '$lib/ui/delegation/register-delegate';
import {consentBullets, type SignerGrant} from '$lib/ui/delegation/grant';
import {findPendingPurchase, type PendingPurchase} from './pending-purchase';
import type {WorldConfig} from './config';

/**
 * Onboarding is three steps across two senders, and only the middle one prompts.
 * Traced so a recording can tell "waiting for the wallet" from "the signer is
 * working" from "nothing is happening". Inert unless the namespace is enabled.
 */
const logger = logs('world:purchase');

export type PurchaseState =
	| {step: 'Idle'}
	/**
	 * Waiting for the player to say who pays.
	 *
	 * Only reached when there is a genuine choice. Asking someone to pick when
	 * one of the two is unavailable is a question with one answer.
	 */
	| {step: 'ChoosingPayer'; methods: readonly PaymentMethod[]}
	/** Nothing here can pay, with the reason. */
	| {step: 'NoPaymentMethod'; message: string}
	/**
	 * Waiting for the player to agree to authorise this browser, BEFORE their
	 * wallet is asked to sign anything.
	 *
	 * Only reached when a wallet will actually be prompted. A hosted account
	 * hands back a credential minted at sign-in with no dialog at all, and
	 * asking it to consent to something that is not about to happen would be
	 * ceremony. Same split the top-up flow makes.
	 */
	| {
			step: 'Consent';
			bullets: readonly string[];
			/** Who is paying, so the dialog can restate it rather than assume it. */
			payer: `0x${string}`;
			/** What they are about to pay, in wei. */
			total: bigint;
	  }
	/**
	 * Asking the owner to authorise this browser. A SIGNATURE, not a
	 * transaction: free, and for a hosted account not even a prompt, because the
	 * credential was minted at sign-in.
	 */
	| {step: 'Authorising'}
	/** The wallet has been asked to pay; the player may still refuse. */
	| {step: 'Purchasing'}
	/** Paid for. The signer is now registering itself out of its stipend. */
	| {step: 'Registering'}
	/**
	 * A purchase this browser is not running, but has already paid for.
	 *
	 * Read out of the operations ledger rather than remembered here, which is
	 * what makes it survive the reload that loses everything else. It is the
	 * state a player is in after closing the tab on a transaction that was still
	 * in flight, and the reason it is a STEP rather than a footnote is that
	 * `buy()` must refuse from it: the alternative is charging them twice for an
	 * avatar they are already getting.
	 */
	| {step: 'Pending'; hash?: `0x${string}`; landed: boolean}
	| {step: 'Error'; error: unknown; message: string};

export type PurchaseStore = Readable<PurchaseState> & {
	readonly value: PurchaseState;
	/** Buy one avatar, minted straight into the game. */
	buy(): Promise<void>;
	/** Answer `ChoosingPayer`. */
	choose(method: PaymentMethodId): Promise<void>;
	/** Answer `Consent`: yes, ask my wallet to sign it. */
	confirmConsent(): Promise<void>;
	/** Put an error away without buying. */
	dismiss(): void;
};

export type PurchaseDeps = Pick<
	Context,
	// The durable record of what this account has sent, which is where a purchase
	// that outlived its tab is found. See ./pending-purchase.ts.
	| 'accountData'
	| 'connection'
	| 'accountExecutor'
	| 'accountBalance'
	| 'gasFee'
	| 'balanceCheck'
	| 'deployments'
	| 'publicClient'
	// The signer registers ITSELF, paying from the stipend the purchase just
	// sent it. That is what keeps the owner down to one transaction.
	| 'signerExecutor'
	| 'delegation'
	/**
	 * A SECOND, WALLET-ONLY CONNECTION, because the payer is not necessarily the
	 * player. An account that signed in with email or a social login has no
	 * wallet at all and `accountExecutor` reports `cannot-send` for it, so
	 * without this the one thing a new player must do is impossible for them.
	 * See core/connection/remote.ts.
	 */
	| 'payment'
>;

/**
 * Gas to keep back when asking whether the account can afford the purchase.
 *
 * A contract call with a value transfer, generously rounded: being short here
 * offers a payer who then fails in the wallet, while being generous only sends
 * someone to the other payment method a little early.
 */
const PURCHASE_GAS = 400_000n;

/** The steps a fresh `buy()` may start from. */
function isRestable(step: PurchaseState['step']): boolean {
	return step === 'Idle' || step === 'Error' || step === 'NoPaymentMethod';
}

/**
 * What the player is shown: this browser's attempt, or the ledger's.
 *
 * THE LOCAL FLOW WINS whenever there is one, because it is more specific: it
 * knows which of "waiting for a signature", "waiting for a wallet" and "the
 * signer is registering" is happening, and it is the only one that can be
 * answered (`choose`, `confirmConsent`). The ledger is consulted only when this
 * browser is doing nothing, which is exactly the case a reload produces.
 *
 * An `Error` therefore also wins, and should: a purchase whose transaction
 * landed but whose registration failed has a real error to show, and covering
 * it with "still buying" would hide the one thing the player can act on.
 *
 * Pure, and exported for the tests, because it is the whole of the recovery
 * rule and neither half of it is reachable from a unit test otherwise.
 */
export function resolvePurchaseState(
	local: PurchaseState,
	pending: PendingPurchase | undefined,
): PurchaseState {
	if (local.step !== 'Idle' || !pending) return local;
	return {step: 'Pending', hash: pending.hash, landed: pending.landed};
}

/**
 * Re-read what the account owns once a recovered purchase is over.
 *
 * A purchase found in the ledger completes with nobody watching: this browser
 * did not send it, so none of the code that normally follows a purchase runs,
 * and without this the player sits on "finishing your purchase" until they
 * reload AGAIN - having already reloaded once, which is how they got here.
 *
 * Its own function, taking only the store it watches, for the same reason
 * `resumeWhenGasArrives` is: it is wiring that acts on the player's behalf,
 * that deserves a test, and that a test should not need an app context for.
 */
export function refreshWhenPendingPurchaseSettles(params: {
	purchase: Readable<PurchaseState>;
	onSettled: () => void;
}): () => void {
	let wasPending = false;
	return params.purchase.subscribe(($purchase) => {
		if ($purchase.step === 'Pending') {
			wasPending = true;
			return;
		}
		// Only a TRANSITION out of it, and only after one was actually seen. The
		// first reading is this browser learning what was already true, and firing
		// on it would re-read the account on every load for nothing.
		if (!wasPending) return;
		wasPending = false;
		params.onSettled();
	});
}

export function createPurchase(params: {
	deps: PurchaseDeps;
	config: WorldConfig;
	/** The account the avatar will belong to. */
	owner: Readable<`0x${string}` | undefined>;
	/**
	 * What this app's browser key is for, for the consent step.
	 *
	 * A parameter rather than a context field, because `context/game.ts` already
	 * holds the one this app declares (`SIGNER_GRANT`) and importing it back from
	 * there would be a cycle. Same list the top-up flow shows, from the same
	 * source, so the two cannot describe two different keys.
	 */
	grant: SignerGrant;
	/** Called once the avatar is on chain, so the deposited read can catch up. */
	onPurchased?: () => void;
}): PurchaseStore {
	const {deps, config, owner} = params;

	/** What THIS browser is doing. Dies with the tab, deliberately. */
	const state = writable<PurchaseState>({step: 'Idle'});
	let local: PurchaseState = {step: 'Idle'};
	state.subscribe((v) => (local = v));

	/**
	 * What this ACCOUNT has in flight, which outlives the tab.
	 *
	 * `watchField` is lazy: nothing is read until something subscribes, so this
	 * stays a synchronous, IO-free construction (ADR-0002) and the server never
	 * touches storage. That is also why `value` below resolves on demand rather
	 * than being kept up to date by a permanent subscription here.
	 */
	const pending = derived(deps.accountData.watchField('operations'), ($ops) =>
		findPendingPurchase({operations: $ops, sale: config.sale.address}),
	);

	const state$ = derived([state, pending], ([$local, $pending]) =>
		resolvePurchaseState($local, $pending),
	);

	/**
	 * The same answer the subscribers get, for the code paths that ask directly.
	 *
	 * It matters most for `buy()`: the guard against buying twice is a question
	 * about the ACCOUNT, not about this tab, and asking the local store alone is
	 * the bug this whole file's recovery exists to fix.
	 */
	function value(): PurchaseState {
		return resolvePurchaseState(local, get(pending));
	}

	/**
	 * Authorise this browser, without a transaction from the owner.
	 *
	 * Returns the credential, or undefined when the signer is already registered
	 * and there is nothing to do. Gathered BEFORE the purchase on purpose: it is
	 * the step the player can refuse, and refusing it should cost them nothing.
	 */
	async function credentialIfNeeded(owner: `0x${string}`) {
		const $delegation = get(deps.delegation);
		if (isRegistered($delegation)) return undefined;

		const $signer = get(deps.signerExecutor);
		if ($signer.status !== 'ready') {
			// No signer means nothing to authorise and nothing to fund. The purchase
			// still works; the player just plays through their wallet.
			return undefined;
		}

		logger.debug(`authorising: asking the owner for a delegation credential`);
		state.set({step: 'Authorising'});
		const deployments = get(deps.deployments);
		return {
			delegate: $signer.address,
			credential: await fetchDelegation({
				connection: deps.connection,
				target: {
					chainId: deployments.chain.id,
					contract: deployments.contracts.Game.address,
				},
				delegate: $signer.address,
			}),
		};
	}

	/**
	 * Who could pay for the avatar, and whether there is anything to ask.
	 *
	 * THE PAYER IS NOT NECESSARILY THE PLAYER, which is the whole reason the
	 * template carries a second, wallet-only connection. An account that signed
	 * in with email or a social login has no wallet, `accountExecutor` reports
	 * `cannot-send`, and this used to throw "This account cannot send
	 * transactions in this mode" at exactly the moment such a player is starting.
	 * They can still play: somebody connects a wallet and pays, and the avatar is
	 * minted to the GAME on the player's behalf regardless. Nothing about the
	 * purchase requires the payer to be the owner, because the owner is the
	 * encoded payload rather than `msg.sender`.
	 *
	 * The SET is computed by `$lib/ui/credits/payment-methods`, which the top-up
	 * flow already uses and which is tested on its own. Reusing it rather than
	 * writing a second rule here is what keeps the two from disagreeing about
	 * whether an account can pay, which is the sort of difference a player would
	 * experience as the app contradicting itself.
	 */
	function offeredMethods(total: bigint): readonly PaymentMethod[] {
		const $account = get(deps.accountExecutor);
		const $balance = get(deps.accountBalance);
		const $gasFee = get(deps.gasFee);
		// `Loaded` or nothing: an unknown fee reserves nothing, which errs towards
		// offering the account and letting the wallet refuse, rather than hiding a
		// payer that can in fact pay.
		const maxFeePerGas =
			$gasFee.step === 'Loaded' ? effectiveGasPrice($gasFee) : 0n;
		const balance =
			$balance.step === 'Loaded' && $balance.value !== undefined
				? $balance.value
				: 0n;

		// What the account could send AFTER the gas of sending it, compared
		// against the whole price plus stipend rather than the price alone: an
		// account that can cover only part of it cannot pay at all.
		//
		// `core/funding`, not arithmetic of our own. This was four lines of
		// duplicated multiplication until the rules were lifted into core, which
		// is where a descendant can find them; keeping a private copy now would be
		// keeping a second answer to a question that has one.
		const spendable = spendableBalance({
			balance,
			maxFeePerGas,
			gas: PURCHASE_GAS,
		});

		return paymentMethods({
			accountSpendable: spendable >= total ? spendable : 0n,
			ownerCanSend: $account.status === 'ready',
			walletsAvailable: get(deps.payment.connection).wallets.length,
		});
	}

	/** Resolve a chosen method into something that can send. */
	async function payerFor(method: PaymentMethodId) {
		if (method === 'account') {
			const $account = get(deps.accountExecutor);
			if ($account.status !== 'ready') {
				throw new Error('This account cannot send a transaction.');
			}
			return {
				kind: 'account' as const,
				client: $account.client,
				account: $account.account,
				address: $account.address,
				balance: deps.accountBalance,
			};
		}

		// Disconnect first: @etherplay/connect remembers the last wallet AND the
		// last account, and who pays is routinely a different account from last
		// time, so the picker has to appear. Same reasoning as the top-up flow's.
		await deps.payment.connection.disconnect();
		const $payment = await deps.payment.connection.ensureConnected();
		const address = $payment.account.address;
		return {
			kind: 'wallet' as const,
			client: deps.payment.walletClient,
			account: address,
			address,
			// Built here rather than held in the context, because WHICH wallet pays
			// is chosen inside the wallet and is not known until the line above
			// resolves. Read through the rail's own public client, which is the one
			// pointed at whatever chain that wallet connected to.
			balance: createBalanceStore({
				publicClient: deps.payment.publicClient,
				account: readable(address),
			}),
		};
	}

	/**
	 * Start a purchase: work out who could pay, and ask only if there is a choice.
	 */
	async function buy() {
		// NEVER TWICE AT ONCE. `subID` is random, so a second run does not collide
		// with the first: it mints a SECOND avatar and charges for it again. The
		// guard is here rather than in the button because a disabled button is a
		// suggestion and this is the player's money.
		//
		// `value()` and not the local store, which is the whole of the reload fix:
		// after a reload this tab is doing nothing at all, and the only thing that
		// knows a purchase is already paid for is the operations ledger.
		if (!isRestable(value().step)) return;

		if (!get(owner)) {
			state.set({
				step: 'Error',
				error: new Error('not signed in'),
				message: 'Sign in first, so the avatar has an owner.',
			});
			return;
		}

		const total = purchaseValue({
			price: config.sale.price,
			stipend: config.sale.stipend,
		});
		const offered = offeredMethods(total);
		const usable = availablePaymentMethods(offered);

		if (usable.length === 0) {
			// A real, reachable state: no wallet on the account and none installed.
			// It gets the honest explanation rather than a disabled button.
			state.set({
				step: 'NoPaymentMethod',
				message: NO_PAYMENT_METHOD_EXPLANATION,
			});
			return;
		}
		if (offered.length === 1) {
			// Genuinely nothing to choose between: one method exists at all.
			await run(usable[0].id);
			return;
		}
		// SHOWN WHENEVER THERE IS MORE THAN ONE METHOD, available or not, rather
		// than only when more than one CAN be used.
		//
		// Skipping to the single usable method looked like a kindness and was not.
		// A player whose account holds nothing went straight into a wallet picker
		// having never been told that paying from their account was an option, let
		// alone why it was refused. `paymentMethods` gives every entry an
		// `unavailableReason` precisely so it can be shown greyed out WITH the
		// reason, which is the difference between a choice and a closed door.
		state.set({step: 'ChoosingPayer', methods: offered});
	}

	async function choose(method: PaymentMethodId) {
		if (value().step !== 'ChoosingPayer') return;
		await run(method);
	}

	/** Whether authorising this browser will actually open the owner's wallet. */
	function needsConsent(): boolean {
		if (isRegistered(get(deps.delegation))) return false;
		if (get(deps.signerExecutor).status !== 'ready') return false;
		// A hosted account signs without prompting, so there is nothing to warn
		// about and nothing to agree to in advance.
		return !signsWithoutPrompt(get(deps.connection));
	}

	/**
	 * The payer resolved by `run`, held across the consent step.
	 *
	 * Kept rather than re-derived, because re-deriving means calling `payerFor`
	 * again, and for the rail that opens the wallet picker a SECOND time. Asking
	 * someone to choose a wallet twice for one purchase is how they conclude the
	 * first answer was not heard.
	 */
	let awaitingConsent: Awaited<ReturnType<typeof payerFor>> | undefined;

	async function confirmConsent() {
		if (value().step !== 'Consent' || !awaitingConsent) return;
		const payer = awaitingConsent;
		awaitingConsent = undefined;
		await execute(payer);
	}

	/**
	 * Connect the chosen payer, then ask for consent if a wallet is going to be
	 * asked to sign.
	 *
	 * THE PAYER IS CONNECTED FIRST, and the order is the whole point. It used to
	 * take the delegation signature before connecting, so the sequence was:
	 * choose "pay with another wallet", get a signature request out of nowhere,
	 * and only then be asked WHICH wallet. The question the player had just
	 * answered was interrupted by an unrelated one, and the thread between
	 * choosing to pay and picking a payer was cut.
	 *
	 * Connecting immediately keeps that thread. The signature comes after, with
	 * a dialog that restates who is paying and how much, so the consent step
	 * carries the context the wallet picker used to lose.
	 */
	async function run(method: PaymentMethodId) {
		const $owner = get(owner);
		if (!$owner) return;

		try {
			await deps.connection.ensureConnected();

			// Leaves `ChoosingPayer` before the wallet picker opens: the question is
			// answered, and a chooser still on screen behind a picker invites a
			// second answer.
			state.set({step: 'Purchasing'});
			const payer = await payerFor(method);
			logger.debug(`payer connected: ${payer.kind} ${payer.address}`);

			if (needsConsent()) {
				awaitingConsent = payer;
				state.set({
					step: 'Consent',
					bullets: consentBullets(params.grant),
					payer: payer.address,
					// Restated here because the player last saw a figure on a button,
					// several dialogs ago, and is about to be asked to sign something.
					total: purchaseValue({
						price: config.sale.price,
						stipend: config.sale.stipend,
					}),
				});
				return;
			}

			await execute(payer);
		} catch (error) {
			fail(error);
		}
	}

	async function execute(payer: Awaited<ReturnType<typeof payerFor>>) {
		const $owner = get(owner);
		if (!$owner) return;

		try {
			const deployments = get(deps.deployments);

			// The signature, now that the player has agreed to it and knows who is
			// paying. Still before the transaction: it is free and refusable, and it
			// decides whether the purchase needs to carry a stipend at all.
			const authorisation = await credentialIfNeeded($owner);

			// Only fund a signer that is going to be registered. Sending a stipend
			// to a key that cannot act for the account would be money parked where
			// the player cannot easily get it back.
			const stipendTo = authorisation?.delegate;
			const stipend = stipendTo ? config.sale.stipend : 0n;

			logger.debug(
				`purchasing: price=${config.sale.price} stipend=${stipend} to=${stipendTo ?? 'nobody'}`,
			);
			state.set({step: 'Purchasing'});

			const request = {
				address: config.sale.address,
				abi: deployments.contracts.AvatarsSale.abi,
				functionName: 'purchase',
				args: purchaseArgs({
					gameAddress: deployments.contracts.Game.address,
					owner: $owner,
					subID: randomSubID(),
					stipendTo,
					stipend,
				}),
				// `purchaseValue`, not `config.sale.price`. The sale subtracts the
				// stipend from `msg.value` and then requires the remainder to equal
				// the price EXACTLY, so the two have to be computed together or the
				// purchase reverts with `WrongPaymentAmount`.
				value: purchaseValue({price: config.sale.price, stipend}),
				account: payer.account,
			};

			// EVERY payer goes through the balance check, including a payment
			// wallet. Skipping it for the rail was wrong and it is what produced a
			// bare "does not have enough funds" with no remedy: `ensureCanAfford` is
			// the thing that opens the insufficient-funds modal, names WHO is short,
			// offers the faucet, and waits for the balance to catch up afterwards.
			// A payer that cannot pay should meet all of that, not a red sentence.
			// One cast, at the one place the mismatch is: viem types `writeContract`
			// for a call site that names the function literally, and the ABI and
			// entry point here are values. Same cast, same reason, as the top-up
			// flow's registration writer.
			const checked = await deps.balanceCheck.ensureCanAfford(
				{contract: request as never},
				{balance: payer.balance, sender: payer.address},
			);
			const hash = await (
				payer.client as unknown as {
					writeContract: (r: unknown) => Promise<`0x${string}`>;
				}
			).writeContract(checked);

			// Waiting matters here. `writeContract` resolves on BROADCAST, and the
			// next two things that happen both depend on this having landed: the
			// signer spends the stipend to register, and the caller re-reads
			// `avatarsPerOwner` to unlock the board.
			const receipt = await deps.publicClient.waitForTransactionReceipt({hash});
			if (receipt.status === 'reverted') {
				throw new Error('The purchase was rejected by the contract.');
			}

			// The avatar exists and is deposited from here on, so the player has got
			// what they paid for whatever happens next.
			if (authorisation) {
				// No prompt for this one: the signer sends it itself out of the
				// stipend that just arrived. Worth a line, because on screen it is a
				// wait the player was never asked about.
				logger.debug(`registering: signer submits its own delegation`);
				state.set({step: 'Registering'});
				const $signer = get(deps.signerExecutor);
				if ($signer.status === 'ready') {
					await submitRegistration({
						registry: {
							address: deployments.contracts.Game.address,
							abi: deployments.contracts.Game.abi,
						},
						// One cast, at the one place the mismatch is: viem's
						// `writeContract` types are built for a call site that names one
						// function literally, and the entry point here is chosen at
						// runtime. Same cast, same reason, as the top-up flow's.
						client: $signer.client as unknown as RegistrationWriter,
						publicClient: deps.publicClient,
						account: $signer.account,
						request: registrationRequest({
							owner: $owner,
							delegate: authorisation.delegate,
							// The signature variant forces the payee to the delegate, and
							// the delegate is already funded, so there is nothing to send.
							value: 0n,
							credential: authorisation.credential,
						}),
					});
					await deps.delegation.update();
				}
			}

			state.set({step: 'Idle'});
			params.onPurchased?.();
		} catch (error) {
			fail(error);
		}
	}

	/**
	 * One place decides what a failure is worth saying.
	 *
	 * Shared by `run` and `execute` because the consent step splits one attempt
	 * across two functions, and a rejection means the same thing whichever half
	 * it happened in.
	 */
	function fail(error: unknown) {
		logger.debug(`failed at step "${value().step}": ${String(error)}`);
		// REJECTING IS AN ANSWER, NOT A FAULT. The player pressed no in their
		// wallet, which is a decision they made deliberately and already know
		// about; reporting it back to them as an error, in viem's words, is the
		// app telling them off for using it correctly. Back to Idle, so the
		// button simply reads as ready again.
		if (isUserRejectionError(error)) {
			state.set({step: 'Idle'});
			return;
		}
		// ALREADY REPORTED, and far better than this could. `ensureCanAfford`
		// throws this only after the insufficient-funds modal has named the
		// account, shown the shortfall, offered the faucet and waited for the
		// balance to arrive; the player then chose to stop. Painting a summary
		// underneath is the app telling them again, worse, in a panel with no
		// remedy on it. Same reasoning as the rejection above.
		if (error instanceof InsufficientFundsError) {
			state.set({step: 'Idle'});
			return;
		}
		state.set({
			step: 'Error',
			error,
			// SUMMARISED, not `error.message`. A viem error message is the whole
			// request pretty-printed - from, to, value, data, gas, nonce, the ABI
			// signature, every argument, a docs link and a version - and it was
			// being rendered verbatim into a panel over the board. `txErrorSummary`
			// is the app's own one-sentence version, and the full text is still
			// reachable through the error-details modal.
			message: txErrorSummary(error),
		});
	}

	return {
		subscribe: state$.subscribe,
		get value() {
			return value();
		},
		buy,
		choose,
		confirmConsent,
		dismiss: () => state.set({step: 'Idle'}),
	};
}

/**
 * Re-exported so a caller does not have to reach past this module for them.
 *
 * Both live in the CONTRACTS package rather than here, deliberately: the id
 * packing and the argument order both have to match Solidity exactly, and
 * `contracts/test/js/Game.test.ts` purchases with `purchaseArgs` and then
 * commits for `avatarIDFor`, so both are pinned against a real chain on every
 * contract test run. A copy here would be a copy that can drift.
 */
export {avatarIDFor, purchaseArgs};
