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
 */
import {get, writable, type Readable} from 'svelte/store';
import type {Context} from '$lib/context/types';
import {avatarIDFor, purchaseArgs, randomSubID} from 'reveal-or-die-contracts';
import type {WorldConfig} from './config';

export type PurchaseState =
	| {step: 'Idle'}
	/** The wallet has been asked; the player may still refuse. */
	| {step: 'Purchasing'}
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

	async function buy() {
		// NEVER TWICE AT ONCE. `subID` is random, so a second run does not collide
		// with the first: it mints a SECOND avatar and charges for it again. The
		// guard is here rather than in the button because a disabled button is a
		// suggestion and this is the player's money.
		if (value.step === 'Purchasing') return;

		const $owner = get(owner);
		if (!$owner) {
			state.set({
				step: 'Error',
				error: new Error('not signed in'),
				message: 'Sign in first, so the avatar has an owner.',
			});
			return;
		}

		state.set({step: 'Purchasing'});
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
							}),
							// EXACT, not a minimum: `purchase` reverts with
							// `WrongPaymentAmount` on anything else, including too much.
							value: config.sale.price,
							account: $executor.account,
						},
					},
					{balance: deps.accountBalance, sender: $executor.address},
				)) as never,
			);

			// Waiting matters here. `writeContract` resolves on BROADCAST, and the
			// caller's next act is to re-read `avatarsPerOwner` and unlock the board;
			// doing that against a transaction that has not been mined reports no
			// avatar and puts the player back in front of the buy button they just
			// used.
			const receipt = await deps.publicClient.waitForTransactionReceipt({hash});
			if (receipt.status === 'reverted') {
				throw new Error('The purchase was rejected by the contract.');
			}

			state.set({step: 'Idle'});
			params.onPurchased?.();
		} catch (error) {
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
