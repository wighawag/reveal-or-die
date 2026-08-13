import {
	createPollingStore,
	type PollingStore,
	type PollingValue,
} from '$lib/core/connection/polling-store';
import {derived, type Readable} from 'svelte/store';
import type {PublicClient} from 'viem';

/**
 * Whether this browser's signer may act for the account, read from the chain.
 *
 * The app has to know this BEFORE it lets a send through, or the user gets a
 * bare `NotDelegate` revert for a state the app could have seen coming. So it
 * is treated the way "needs funds" already is: a state the UI reads, explains,
 * and offers the remedy for.
 *
 * Kept live rather than read once, because it changes underneath the app: the
 * registration lands in a transaction the app itself sent, and the
 * authorisation can be withdrawn from the account panel or from another tab.
 *
 * `withdrawn` comes along because it decides which registration routes are
 * still open. It is PER DELEGATE: set only by a successful `revokeDelegate` for
 * the delegate that was current at the time, and cleared only by an
 * owner-sent `registerDelegate`. So once it is up the signature route for
 * THAT delegate is closed, but a different delegate can still be authorised
 * by a fresh signature - which is what lets a user replace one signer with
 * another without sending a transaction themselves.
 */
export type DelegationState = {
	/** The address currently allowed to act for the account; zero when none. */
	delegate: `0x${string}`;
	/** Whether the account has withdrawn its authorisation for this signer. */
	withdrawn: boolean;
};

/**
 * The delegation surface, as an ABI rather than as a named contract.
 *
 * This is the whole external shape of `core/UsingDelegation.sol`, which is what
 * a contract gets by adopting the library. Declared here, once, because
 * delegation is a FEATURE with a fixed interface and not a property of any
 * particular app: an app that adopts the library has exactly these functions,
 * whatever else it does and whatever it calls itself.
 *
 * This module used to reach for `deployments.contracts.GreetingsRegistry` by
 * name, which is the demo's contract. That works in exactly one repo. Every
 * descendant of this template replaces the demo, so every descendant had to
 * either keep a contract named after a greeting or fork this file - and the
 * failure was a type error at best and a read against `undefined` at worst.
 * The registry is an ADDRESS now, supplied by the app that knows which of its
 * contracts adopted the library.
 */
export const DELEGATION_ABI = [
	{
		inputs: [{internalType: 'address', name: 'owner', type: 'address'}],
		name: 'delegateOf',
		outputs: [{internalType: 'address', name: '', type: 'address'}],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{internalType: 'address', name: 'owner', type: 'address'},
			{internalType: 'address', name: 'delegate', type: 'address'},
		],
		name: 'delegationWithdrawn',
		outputs: [{internalType: 'bool', name: '', type: 'bool'}],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{internalType: 'address', name: 'delegate', type: 'address'},
			{internalType: 'address payable', name: 'payee', type: 'address'},
		],
		name: 'registerDelegate',
		outputs: [],
		stateMutability: 'payable',
		type: 'function',
	},
	{
		inputs: [
			{internalType: 'address', name: 'owner', type: 'address'},
			{internalType: 'string', name: 'origin', type: 'string'},
			{internalType: 'address', name: 'delegate', type: 'address'},
			{internalType: 'bytes', name: 'signature', type: 'bytes'},
		],
		name: 'registerDelegateViaSignature',
		outputs: [],
		stateMutability: 'payable',
		type: 'function',
	},
	{
		inputs: [],
		name: 'revokeDelegate',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
] as const;

/** Where the delegation registry lives, and how to talk to it. */
export type DelegationRegistry = {
	address: `0x${string}`;
	abi: typeof DELEGATION_ABI;
};

export type DelegationValue = PollingValue<DelegationState>;
/**
 * The live answer, plus WHERE it was read from.
 *
 * The registry is carried on the store rather than resolved again by each
 * caller, because every writer (registering, revoking, the top-up flow's
 * register-and-fund) has to address the same contract the reader just answered
 * about. Two lookups is two chances to disagree, and the disagreement would be
 * invisible: a UI that says "already authorised" while a send keeps reverting.
 */
export type DelegationStore = PollingStore<DelegationState> & {
	readonly registry: DelegationRegistry;
};

export const ZERO_ADDRESS =
	'0x0000000000000000000000000000000000000000' as const;

/**
 * Whether `signer` is the registered delegate of the account this value
 * describes.
 *
 * Unknown reads as NOT registered, deliberately. The consequence of guessing
 * wrong in that direction is a prompt to register that turns out to be
 * unnecessary; guessing the other way sends a transaction that reverts.
 */
export function isRegistered(
	value: DelegationValue,
	signer: `0x${string}` | undefined,
): boolean {
	if (!signer) return false;
	if (value.step !== 'Loaded') return false;
	return value.delegate.toLowerCase() === signer.toLowerCase();
}

/** What the polling engine fetches: the account and its signer as one scope. */
type DelegationScope = {
	owner: `0x${string}`;
	signer: `0x${string}`;
} | undefined;

export function createDelegationState(params: {
	publicClient: PublicClient;
	/**
	 * The deployed contract that adopted `core/UsingDelegation.sol`.
	 *
	 * An address, not a name: see {@link DELEGATION_ABI}. In this template it is
	 * the Game, because the Game is what a player's moves are sent to and what
	 * their reserve is held by, so it is the account authority that matters.
	 */
	registry: `0x${string}`;
	/** The authenticated account. The read is scoped to it, and resets with it. */
	account: Readable<`0x${string}` | undefined>;
	/**
	 * This browser's signer address. The `withdrawn` read is scoped to it,
	 * because withdrawal is per delegate: a withdrawn signer does not block a
	 * different one.
	 */
	signer: Readable<`0x${string}` | undefined>;
	/** Optional gate, for an app that can only reach the chain via the wallet. */
	fetchGate?: Readable<boolean>;
	fetchInterval?: number;
}): DelegationStore {
	const {publicClient, account, signer, fetchGate} = params;
	const registry: DelegationRegistry = {
		address: params.registry,
		abi: DELEGATION_ABI,
	};

	// The polling engine takes ONE source, so the account, the signer and the
	// gate are folded into one: a closed gate reads as "no account to look up",
	// which is already the state that stops the fetch and resets the value.
	// The signer is part of the scope because `delegationWithdrawn` is now
	// keyed per delegate - a change in the signer (e.g. after re-derivation)
	// changes the answer.
	const source: Readable<DelegationScope> = fetchGate
		? derived(
				[account, signer, fetchGate],
				([$account, $signer, $open]) =>
					$open && $account && $signer
						? {owner: $account, signer: $signer}
						: undefined,
			)
		: derived([account, signer], ([$account, $signer]) =>
				$account && $signer
					? {owner: $account, signer: $signer}
					: undefined,
			);

	const store = createPollingStore(
		async (scope: DelegationScope) => {
			// Never reached with an absent scope: the engine treats a falsy source as
			// "nothing to fetch". Narrowed for the type rather than for the case.
			if (!scope) throw new Error('no account to read delegation for');
			const {owner, signer} = scope;
			const [delegate, withdrawn] = await Promise.all([
				publicClient.readContract({
					...registry,
					functionName: 'delegateOf',
					args: [owner],
				}),
				publicClient.readContract({
					...registry,
					functionName: 'delegationWithdrawn',
					args: [owner, signer],
				}),
			]);
			return {delegate, withdrawn};
		},
		{
			// Slower than the message poll: this changes about once per account, so
			// the value of a tighter loop is nil and the cost is two reads.
			fetchInterval: params.fetchInterval ?? 15_000,
			source: {
				store: source,
				// The source is an object that is recreated on every notification,
				// so identity comparison would see every derived update as a change.
				// The scope is meaningful when either the owner or the signer moves.
				key: (scope) => (scope ? `${scope.owner}:${scope.signer}` : undefined),
			},
		},
	);

	// Carried on the store so every writer addresses the contract the reader just
	// answered about. See {@link DelegationStore}.
	return Object.assign(store, {registry});
}