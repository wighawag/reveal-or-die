/**
 * WHAT IS AT STAKE: custody of the avatar you play.
 *
 * This is the branch's answer to the second commit-reveal rule - something
 * must be at stake, or nobody has to reveal. A player who dislikes what they
 * committed to can always go quiet; here that costs them the avatar itself,
 * seized by `acknowledgeMissedReveal`, rather than a bond taken out of a
 * reserve of tokens.
 *
 * ON `main` THIS FILE READS AN ERC20 RESERVE, and it says in as many words
 * that "a game that gates differently (holding custody of an item the player
 * bought, say) replaces this file". This is that replacement, and the shape it
 * keeps is what makes it cheap: the same store type, the same two methods, the
 * same `{step, amount}` the setup gate reads. So `context/game.ts` wires it
 * identically and `setupNeeded` is untouched - `amount === 0n` still means
 * "you have nothing to play with", it just means an avatar rather than tokens.
 *
 * IT DERIVES RATHER THAN READING. The chain read it would need is the one the
 * identity provider already makes (`$lib/game/identity`), and doing it twice
 * would be two polls of the same state that can disagree for a frame - with
 * the gate and the board drawn from different answers. The identity store is
 * the authority on custody, because on this branch custody IS identity.
 */
import {derived, get, type Readable} from 'svelte/store';
import type {Context} from '$lib/context/types';
import {onchainIdentity, type ActiveIdentityStore} from '$lib/game/identity';
import type {PlacementConfig} from './config';

export type ReserveState =
	{step: 'Unloaded'} | {step: 'Loaded'; amount: bigint; tokenBalance: bigint};

export type ReserveStore = Readable<ReserveState> & {
	update(): Promise<void>;
	withdraw(amount: bigint): Promise<void>;
};

/**
 * What the stake needs.
 *
 * `accountExecutor`, NOT `signerExecutor`: taking the avatar back out is the
 * player's own act, so it is sent from the wallet they control, with a prompt,
 * deliberately. `withdrawAvatar` checks `msg.sender` against the recorded
 * owner instead of going through `_playerOf`, which is the same line `main`
 * draws at `withdrawFromReserve`: a delegate may PLAY the stake and may never
 * take it out, which is what makes a disposable browser key safe to hold.
 */
export type ReserveDeps = Pick<
	Context,
	| 'connection'
	| 'accountExecutor'
	| 'deployments'
	| 'balanceCheck'
	| 'publicClient'
	| 'account'
	| 'accountBalance'
>;

export function createReserve(params: {
	deps: ReserveDeps;
	config: PlacementConfig;
	/**
	 * WHO PLAYS, which on this branch is also WHAT IS AT STAKE.
	 *
	 * The one store, rather than a second reader of the same chain state. Its
	 * `loaded` is what keeps the setup gate honest: an unfinished read must not
	 * look like an account with no avatar, or the gate covers a playable board
	 * on every load.
	 */
	identity: ActiveIdentityStore;
}): ReserveStore {
	const {deps} = params;

	const state = derived(
		[params.identity, params.identity.loaded],
		([$identity, $loaded]): ReserveState => {
			if (!$loaded) return {step: 'Unloaded'};
			return {
				step: 'Loaded',
				// ONE OR NONE, counted rather than valued. The gate asks whether this
				// is zero and nothing else does arithmetic on it; several avatars per
				// account is D6, and when it lands this becomes the count.
				amount: $identity === undefined ? 0n : 1n,
				// No token stands behind an avatar, and reporting a balance of zero
				// is more honest than reporting the account's ERC20 holdings, which
				// this game cannot stake and does not read.
				tokenBalance: 0n,
			};
		},
	);

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
	 * Take the avatar out of the game, ending its time at stake.
	 *
	 * The signature is `main`'s and the argument is ignored, which is a real
	 * cost recorded rather than hidden: there is nothing partial to withdraw
	 * here, an avatar is in or out. Keeping the shape is what lets the store be
	 * wired identically; the day something calls this with a number that means
	 * anything, the type has to change on both sides.
	 */
	async function withdraw(_amount: bigint) {
		const {executor, deployments} = await ready();
		// `=== undefined`, not falsy: an avatar id can be zero in general, even
		// though this game's sale never mints one.
		const identity = get(params.identity);
		if (identity === undefined) {
			throw new Error('There is no avatar to take out.');
		}

		const hash = await executor.client.writeContract({
			address: deployments.contracts.Game.address,
			abi: deployments.contracts.Game.abi,
			functionName: 'withdrawAvatar',
			args: [onchainIdentity(identity), executor.address],
			account: executor.account,
			chain: null,
		} as never);
		const receipt = await deps.publicClient.waitForTransactionReceipt({hash});
		if (receipt.status === 'reverted') {
			// The commonest reason by far, and the one worth naming: an open
			// commitment pins the avatar, which is what stops "commit, then walk
			// away with the stake" from being a move.
			throw new Error(
				'Taking the avatar out was rejected. A commitment that has not been revealed or settled keeps it in the game.',
			);
		}
		await params.identity.update();
	}

	return {
		subscribe: state.subscribe,
		update: () => params.identity.update(),
		withdraw,
	};
}
