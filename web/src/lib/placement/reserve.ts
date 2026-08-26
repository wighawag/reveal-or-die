/**
 * The reserve: the tokens a player puts at risk in order to play.
 *
 * This is the template's answer to the second commit-reveal rule - something
 * must be at stake, or nobody has to reveal. A player who dislikes what they
 * committed to can always go quiet; the bond taken from this reserve at commit
 * time, and forfeited by `acknowledgeMissedReveal`, is what makes that cost
 * them. A game that gates differently (reveal-or-die holds custody of an NFT)
 * replaces this file; the framework only requires that SOMETHING is lost.
 */
import {get, writable, type Readable} from 'svelte/store';
import type {Context} from '$lib/context/types';
import type {PlacementConfig} from './config';

export type ReserveState =
	{step: 'Unloaded'} | {step: 'Loaded'; amount: bigint; tokenBalance: bigint};

export type ReserveStore = Readable<ReserveState> & {
	update(): Promise<void>;
	/** Mint test tokens, approve, and top the reserve up. Template-only. */
	fund(amount: bigint): Promise<void>;
	withdraw(amount: bigint): Promise<void>;
};

/**
 * What the reserve needs.
 *
 * `accountExecutor`, NOT `signerExecutor`: staking moves the player's real money, so it
 * is paid from the wallet they control, with a prompt, deliberately. The
 * reserve is CREDITED to the ACCOUNT, which is what owns the stake and the
 * cells won with it. The signer neither pays nor owns; it acts for the
 * account, and only once `registerDelegate` has authorised it onchain. The
 * contract's `addToReserve(player, amount)` takes the beneficiary separately
 * from the payer precisely so the two CAN differ, which is safe because a
 * reserve can only ever be withdrawn by its owner: topping up somebody else's
 * is a gift.
 */
export type ReserveDeps = Pick<
	Context,
	| 'connection'
	| 'accountExecutor'
	| 'deployments'
	| 'balanceCheck'
	| 'publicClient'
	| 'account'
	// The payer's gas, so the balance check measures the account that actually
	// pays. See EnsureCanAffordOptions.
	| 'accountBalance'
>;

export function createReserve(params: {
	deps: ReserveDeps;
	config: PlacementConfig;
	/**
	 * The address that PLAYS, and so the one whose reserve this is. Passed in
	 * rather than read off the context: which address a game plays as is the
	 * game's own decision, not something the core knows about.
	 */
	gameIdentity: Readable<`0x${string}` | undefined>;
}): ReserveStore {
	const {deps} = params;
	const state = writable<ReserveState>({step: 'Unloaded'});

	async function update() {
		// The reserve is filed under the address that OWNS it; the tokens sit with
		// the address that PAYS. Both are the account here, since that is what this
		// game plays as and what it stakes from. They keep separate names because
		// `addToReserve` lets a payer credit someone else, and a game that takes
		// that up should not have to untangle one name doing two jobs.
		const player = get(params.gameIdentity);
		const payer = get(deps.account);
		if (!player || !payer) {
			state.set({step: 'Unloaded'});
			return;
		}
		const $deployments = get(deps.deployments);

		const [amount, tokenBalance] = await Promise.all([
			deps.publicClient.readContract({
				address: $deployments.contracts.Game.address,
				abi: $deployments.contracts.Game.abi,
				functionName: 'getReserve',
				args: [player],
			}) as Promise<bigint>,
			deps.publicClient.readContract({
				address: $deployments.contracts.GameToken.address,
				abi: $deployments.contracts.GameToken.abi,
				functionName: 'balanceOf',
				args: [payer],
			}) as Promise<bigint>,
		]);

		state.set({step: 'Loaded', amount, tokenBalance});
	}

	/**
	 * Send and wait for inclusion.
	 *
	 * Not merely cosmetic: `fund` reads the allowance the `approve` before it
	 * set, and tops up a reserve the `mint` before it paid for. `writeContract`
	 * resolves on BROADCAST, so without waiting, each step would race the one it
	 * depends on. A local node with automine hides this; anything else does not.
	 */
	async function sendAndWait(
		executor: {
			client: {writeContract: (request: never) => Promise<`0x${string}`>};
		},
		request: unknown,
		what: string,
	) {
		const hash = await executor.client.writeContract(request as never);
		const receipt = await deps.publicClient.waitForTransactionReceipt({hash});
		if (receipt.status === 'reverted') {
			throw new Error(`${what} failed`);
		}
	}

	async function ready() {
		await deps.connection.ensureConnected();
		const $executor = get(deps.accountExecutor);
		if ($executor.status === 'cannot-send') {
			throw new Error('This account cannot send transactions in this mode.');
		}
		if ($executor.status !== 'ready') {
			throw new Error('No account connected.');
		}
		return {executor: $executor, deployments: get(deps.deployments)};
	}

	/**
	 * Top up the reserve, minting and approving first if needed.
	 *
	 * Three transactions in the worst case, which is a poor experience and
	 * deliberately not hidden: the template's token is freely mintable so that
	 * the game is playable the moment it is deployed locally, and a real game
	 * would acquire tokens some other way entirely.
	 */
	async function fund(amount: bigint) {
		const {executor, deployments} = await ready();
		// The wallet pays; the ACCOUNT is credited. The signer neither pays nor
		// owns; it plays the moves later, once registered as a delegate.
		const payer = executor.address;
		const player = get(params.gameIdentity);
		if (!player) {
			throw new Error(
				'Sign in first, so the game has a key to play your moves with.',
			);
		}

		const balance = (await deps.publicClient.readContract({
			address: deployments.contracts.GameToken.address,
			abi: deployments.contracts.GameToken.abi,
			functionName: 'balanceOf',
			args: [payer],
		})) as bigint;

		if (balance < amount) {
			await sendAndWait(
				executor,
				await deps.balanceCheck.ensureCanAfford(
					{
						contract: {
							address: deployments.contracts.GameToken.address,
							abi: deployments.contracts.GameToken.abi,
							functionName: 'mint',
							args: [payer, amount - balance],
							account: executor.account,
						},
					},
					{balance: deps.accountBalance, sender: payer},
				),
				'Minting tokens',
			);
		}

		const allowance = (await deps.publicClient.readContract({
			address: deployments.contracts.GameToken.address,
			abi: deployments.contracts.GameToken.abi,
			functionName: 'allowance',
			args: [payer, deployments.contracts.Game.address],
		})) as bigint;

		if (allowance < amount) {
			await sendAndWait(
				executor,
				await deps.balanceCheck.ensureCanAfford(
					{
						contract: {
							address: deployments.contracts.GameToken.address,
							abi: deployments.contracts.GameToken.abi,
							functionName: 'approve',
							args: [deployments.contracts.Game.address, amount],
							account: executor.account,
						},
					},
					{balance: deps.accountBalance, sender: payer},
				),
				'Approving the game to hold your stake',
			);
		}

		await sendAndWait(
			executor,
			await deps.balanceCheck.ensureCanAfford(
				{
					contract: {
						address: deployments.contracts.Game.address,
						abi: deployments.contracts.Game.abi,
						functionName: 'addToReserve',
						args: [player, amount],
						account: executor.account,
					},
				},
				{balance: deps.accountBalance, sender: payer},
			),
			'Adding to your reserve',
		);

		// The HUD shows the reserve, and it is the number the player just changed.
		await update();
	}

	async function withdraw(amount: bigint) {
		const {executor, deployments} = await ready();
		const payer = executor.address;
		await sendAndWait(
			executor,
			await deps.balanceCheck.ensureCanAfford(
				{
					contract: {
						address: deployments.contracts.Game.address,
						abi: deployments.contracts.Game.abi,
						functionName: 'withdrawFromReserve',
						args: [amount],
						account: executor.account,
					},
				},
				{balance: deps.accountBalance, sender: payer},
			),
			'Withdrawing from your reserve',
		);
		await update();
	}

	return {subscribe: state.subscribe, update, fund, withdraw};
}
