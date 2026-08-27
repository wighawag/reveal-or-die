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
import {get, writable, type Readable} from 'svelte/store';
import {logs} from 'named-logs';
import type {Context} from '$lib/context/types';
import {
	avatarIDFor,
	purchaseArgs,
	purchaseValue,
	randomSubID,
} from 'reveal-or-die-contracts';
import {isRegistered} from '$lib/onchain/delegation';
import {registrationRequest} from '$lib/ui/delegation/registration';
import {
	fetchDelegation,
	submitRegistration,
	type RegistrationWriter,
} from '$lib/ui/delegation/register-delegate';
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
	 * Asking the owner to authorise this browser. A SIGNATURE, not a
	 * transaction: free, and for a hosted account not even a prompt, because the
	 * credential was minted at sign-in.
	 */
	| {step: 'Authorising'}
	/** The wallet has been asked to pay; the player may still refuse. */
	| {step: 'Purchasing'}
	/** Paid for. The signer is now registering itself out of its stipend. */
	| {step: 'Registering'}
	| {step: 'Error'; error: unknown; message: string};

export type PurchaseStore = Readable<PurchaseState> & {
	readonly value: PurchaseState;
	/** Buy one avatar, minted straight into the game. */
	buy(): Promise<void>;
	/** Put an error away without buying. */
	dismiss(): void;
};

export type PurchaseDeps = Pick<
	Context,
	| 'connection'
	| 'accountExecutor'
	| 'accountBalance'
	| 'balanceCheck'
	| 'deployments'
	| 'publicClient'
	// The signer registers ITSELF, paying from the stipend the purchase just
	// sent it. That is what keeps the owner down to one transaction.
	| 'signerExecutor'
	| 'delegation'
>;

export function createPurchase(params: {
	deps: PurchaseDeps;
	config: WorldConfig;
	/** The account the avatar will belong to. */
	owner: Readable<`0x${string}` | undefined>;
	/** Called once the avatar is on chain, so the deposited read can catch up. */
	onPurchased?: () => void;
}): PurchaseStore {
	const {deps, config, owner} = params;

	const state = writable<PurchaseState>({step: 'Idle'});
	let value: PurchaseState = {step: 'Idle'};
	state.subscribe((v) => (value = v));

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

	async function buy() {
		// NEVER TWICE AT ONCE. `subID` is random, so a second run does not collide
		// with the first: it mints a SECOND avatar and charges for it again. The
		// guard is here rather than in the button because a disabled button is a
		// suggestion and this is the player's money.
		if (value.step !== 'Idle' && value.step !== 'Error') return;

		const $owner = get(owner);
		if (!$owner) {
			state.set({
				step: 'Error',
				error: new Error('not signed in'),
				message: 'Sign in first, so the avatar has an owner.',
			});
			return;
		}

		try {
			await deps.connection.ensureConnected();
			const $executor = get(deps.accountExecutor);
			if ($executor.status === 'cannot-send') {
				throw new Error('This account cannot send transactions in this mode.');
			}
			if ($executor.status !== 'ready') {
				throw new Error('No account connected.');
			}
			const deployments = get(deps.deployments);

			// Signature first: free, refusable, and it decides whether the purchase
			// needs to carry a stipend at all.
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
			const hash = await $executor.client.writeContract(
				(await deps.balanceCheck.ensureCanAfford(
					{
						contract: {
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
							// `purchaseValue`, not `config.sale.price`. The sale subtracts
							// the stipend from `msg.value` and then requires the remainder
							// to equal the price EXACTLY, so the two have to be computed
							// together or the purchase reverts with `WrongPaymentAmount`.
							value: purchaseValue({price: config.sale.price, stipend}),
							account: $executor.account,
						},
					},
					{balance: deps.accountBalance, sender: $executor.address},
				)) as never,
			);

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
			logger.debug(`failed at step "${value.step}": ${String(error)}`);
			state.set({
				step: 'Error',
				error,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return {
		subscribe: state.subscribe,
		get value() {
			return value;
		},
		buy,
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
