import {describe, expect, it, vi} from 'vitest';
import {writable} from 'svelte/store';
import {findPendingPurchase} from '$lib/world/pending-purchase';
import {
	createPurchase,
	refreshWhenPendingPurchaseSettles,
	resolvePurchaseState,
	type PurchaseDeps,
	type PurchaseState,
} from '$lib/world/purchase';
import type {OnchainOperation} from '$lib/account/AccountData';
import type {WorldConfig} from '$lib/world/config';

/**
 * A purchase that outlived its tab.
 *
 * The failure this is all about: reload while the transaction is in flight, and
 * the setup gate went back to "Buy an avatar" for someone whose money was
 * already spent. `subID` is random, so the second purchase did not collide with
 * the first - it minted another avatar and charged for it again.
 */

const SALE = '0x00000000000000000000000000000000000000fe' as const;
const OTHER = '0x00000000000000000000000000000000000000ff' as const;

function operation(overrides: {
	to?: `0x${string}` | null;
	functionName?: string;
	unknownMetadata?: boolean;
	state?: {inclusion: string; status?: string; final?: boolean};
	hash?: `0x${string}`;
}): OnchainOperation {
	const metadata = overrides.unknownMetadata
		? {type: 'unknown' as const, name: 'topUp', data: []}
		: {
				type: 'functionCall' as const,
				functionName: overrides.functionName ?? 'purchase',
				args: [],
			};
	return {
		metadata: {
			...metadata,
			tx: {to: overrides.to === undefined ? SALE : overrides.to},
		},
		transactionIntent: {
			transactions: [{hash: overrides.hash ?? '0xabc'}],
			state: overrides.state,
		},
	} as unknown as OnchainOperation;
}

const find = (operations: Record<string, OnchainOperation>) =>
	findPendingPurchase({operations, sale: SALE});

describe('finding a purchase in the operations ledger', () => {
	it('finds one that is still in the mempool', () => {
		const found = find({'100': operation({state: {inclusion: 'InMemPool'}})});
		expect(found?.id).toBe('100');
		expect(found?.landed).toBe(false);
	});

	it('finds one that has not been given a state yet', () => {
		// The window this exists for is the narrowest one: broadcast, and the tab
		// closed before the observer said anything about it.
		expect(find({'100': operation({})})?.id).toBe('100');
	});

	it('finds one that landed but is not final, and says so', () => {
		// The avatar exists on chain from this moment; what is left is the ledger
		// retiring the operation. Different sentence to the player, same refusal
		// to sell them a second avatar.
		const found = find({
			'100': operation({
				state: {inclusion: 'Included', status: 'Success', final: false},
			}),
		});
		expect(found?.landed).toBe(true);
	});

	it('does not count a purchase that reverted', () => {
		// It charged gas and minted nothing, so the player has to be able to try
		// again. Treating it as pending would lock them out of the game with a
		// spinner.
		expect(
			find({
				'100': operation({
					state: {inclusion: 'Included', status: 'Failure', final: true},
				}),
			}),
		).toBeUndefined();
	});

	it('does not count one the chain never took', () => {
		expect(
			find({'100': operation({state: {inclusion: 'Dropped'}})}),
		).toBeUndefined();
		expect(
			find({'101': operation({state: {inclusion: 'NotFound'}})}),
		).toBeUndefined();
	});

	it('ignores a `purchase` sent to some other contract', () => {
		// Matching on the function name alone is enough today and stops being
		// enough the moment anything else in the app has one. Being wrong here
		// costs the player the ability to buy at all, silently.
		expect(find({'100': operation({to: OTHER})})).toBeUndefined();
	});

	it('ignores this game\u2019s other transactions', () => {
		expect(find({'100': operation({functionName: 'commit'})})).toBeUndefined();
		// A plain transfer carries `unknown` metadata and no function name at all:
		// the top-up flow sends those, to this very account, all the time.
		expect(find({'101': operation({unknownMetadata: true})})).toBeUndefined();
		expect(find({'102': operation({to: null})})).toBeUndefined();
	});

	it('reports the most recent one when a player has bought more than once', () => {
		const found = find({
			'100': operation({state: {inclusion: 'InMemPool'}, hash: '0xold'}),
			'300': operation({state: {inclusion: 'InMemPool'}, hash: '0xnew'}),
			'200': operation({state: {inclusion: 'InMemPool'}, hash: '0xmid'}),
		});
		// Ids are clock timestamps, so this is "latest" rather than "last in
		// whatever order the object happened to enumerate".
		expect(found?.hash).toBe('0xnew');
	});

	it('finds nothing in an empty ledger', () => {
		expect(find({})).toBeUndefined();
	});
});

describe('which of the two states the player is shown', () => {
	const pending = {id: '100', hash: '0xabc' as const, landed: false};

	it('reports a purchase found in the ledger when this tab is doing nothing', () => {
		expect(resolvePurchaseState({step: 'Idle'}, pending)).toEqual({
			step: 'Pending',
			hash: '0xabc',
			landed: false,
		});
	});

	it('leaves this tab\u2019s own flow alone', () => {
		// The local flow is more specific - it knows whether a signature, a wallet
		// or the signer is being waited on, and it is the only one that can be
		// answered by `choose` or `confirmConsent`. Covering it with the ledger's
		// coarser view would break the dialogs mid-purchase.
		const local: PurchaseState = {
			step: 'Consent',
			bullets: [],
			payer: SALE,
			total: 1n,
		};
		expect(resolvePurchaseState(local, pending)).toBe(local);
		expect(resolvePurchaseState({step: 'Purchasing'}, pending)).toEqual({
			step: 'Purchasing',
		});
	});

	it('leaves an error showing, even with the purchase itself in flight', () => {
		// The reachable case: the purchase landed and the signer's registration
		// failed. There is something to act on, and hiding it behind "still buying"
		// would leave the player waiting for a step that already finished.
		const local: PurchaseState = {
			step: 'Error',
			error: new Error('x'),
			message: 'x',
		};
		expect(resolvePurchaseState(local, pending)).toBe(local);
	});

	it('is idle when there is nothing anywhere', () => {
		expect(resolvePurchaseState({step: 'Idle'}, undefined)).toEqual({
			step: 'Idle',
		});
	});
});

describe('the guard that stops a second charge', () => {
	/**
	 * The store itself, built over a ledger and nothing else.
	 *
	 * `buy()` asks whether a purchase is already under way BEFORE it looks at
	 * payment methods or wallets, so a deps object with only account data in it
	 * is enough to exercise the guard - and a purchase that got past it would
	 * announce itself loudly here by reaching for one of the things that is not
	 * there.
	 */
	function store(operations: Record<string, OnchainOperation>) {
		const deps = {
			accountData: {watchField: () => writable(operations)},
		} as unknown as PurchaseDeps;
		return createPurchase({
			deps,
			config: {
				sale: {address: SALE, price: 1n, stipend: 0n},
			} as unknown as WorldConfig,
			owner: writable(undefined),
			grant: {action: 'play your moves'},
		});
	}

	it('refuses to buy while the ledger says one is already paid for', async () => {
		// THE WHOLE POINT. After a reload this tab is doing nothing, its own state
		// is Idle, and the setup gate would happily offer "Buy an avatar" again -
		// for real money, for a second avatar, because the subID is random and the
		// two do not collide.
		const purchase = store({
			'100': operation({state: {inclusion: 'InMemPool'}}),
		});
		expect(purchase.value.step).toBe('Pending');
		await purchase.buy();
		expect(purchase.value.step).toBe('Pending');
	});

	it('tells anything watching, not just its own guard', () => {
		// The HUD subscribes: it is what turns this into "finishing a purchase you
		// already paid for" on screen and disables the button. A store whose guard
		// knew about the ledger while its subscribers did not would refuse the
		// purchase behind a button still reading "Buy an avatar", which looks like
		// the app is broken rather than careful.
		const purchase = store({
			'100': operation({state: {inclusion: 'InMemPool'}}),
		});
		const seen: PurchaseState[] = [];
		purchase.subscribe((state) => seen.push(state))();
		expect(seen.at(-1)?.step).toBe('Pending');
	});

	it('still lets a player buy when the ledger holds nothing', async () => {
		// Guards the guard: a refusal that refused everything would pass the test
		// above and lock every new player out of the game.
		const purchase = store({});
		expect(purchase.value.step).toBe('Idle');
		await purchase.buy();
		// It gets as far as needing an owner, which is the next thing `buy` checks.
		expect(purchase.value.step).toBe('Error');
	});
});

describe('catching up once a recovered purchase finishes', () => {
	it('re-reads the account when the purchase stops being pending', () => {
		// Nothing else will: this browser did not send the transaction, so none of
		// the code that normally follows a purchase runs.
		const purchase = writable<PurchaseState>({
			step: 'Pending',
			landed: false,
		});
		const onSettled = vi.fn();
		refreshWhenPendingPurchaseSettles({purchase, onSettled});
		expect(onSettled).not.toHaveBeenCalled();

		purchase.set({step: 'Idle'});
		expect(onSettled).toHaveBeenCalledTimes(1);
	});

	it('does nothing for a session that never had one', () => {
		// The first reading is this browser learning what was already true.
		// Firing on it would re-read the account on every single load.
		const purchase = writable<PurchaseState>({step: 'Idle'});
		const onSettled = vi.fn();
		refreshWhenPendingPurchaseSettles({purchase, onSettled});
		purchase.set({step: 'Idle'});
		expect(onSettled).not.toHaveBeenCalled();
	});

	it('re-reads once per purchase, not once per emission', () => {
		const purchase = writable<PurchaseState>({step: 'Pending', landed: false});
		const onSettled = vi.fn();
		refreshWhenPendingPurchaseSettles({purchase, onSettled});
		purchase.set({step: 'Idle'});
		purchase.set({step: 'Idle'});
		expect(onSettled).toHaveBeenCalledTimes(1);
	});

	it('stops watching when it is torn down', () => {
		const purchase = writable<PurchaseState>({step: 'Pending', landed: false});
		const onSettled = vi.fn();
		const stop = refreshWhenPendingPurchaseSettles({purchase, onSettled});
		stop();
		purchase.set({step: 'Idle'});
		expect(onSettled).not.toHaveBeenCalled();
	});
});
