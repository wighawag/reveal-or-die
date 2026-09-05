/**
 * Finding a purchase this browser has already paid for.
 *
 * WHY THIS IS NOT A FLAG IN A STORE. `purchase.ts` holds the state of an
 * attempt, and a store dies with the tab. Reload while the transaction is in
 * flight and the setup gate went back to "Buy an avatar" for someone whose
 * money was already spent: `subID` is random, so a second attempt does not
 * collide with the first, it mints a SECOND avatar and charges again.
 *
 * The evidence that a purchase exists is a transaction, and this app already
 * keeps a durable, per-account record of transactions: the operations ledger in
 * account data, which is what the signer's own moves are recovered from across
 * a reload. So this reads THAT rather than writing a second copy of it beside
 * it. Writing the subID (or a "purchasing" flag) into local storage would be
 * exactly that second copy, with its own staleness, its own cleanup and its own
 * way of disagreeing with the chain.
 *
 * It became possible only recently: until the payment rail's client was wrapped
 * by the tracker upstream, a purchase paid from a second wallet never reached
 * the ledger at all. See docs/plans/web-port.md.
 *
 * Pure and taking a snapshot, so the whole rule is testable without a chain, a
 * browser or an app context.
 */
import type {OnchainOperation} from '$lib/account/AccountData';
import {getOperationStatusInfo} from '$lib/view/operation';

export type PendingPurchase = {
	/** The operation's id in the ledger. */
	id: string;
	/** The transaction to point a player at, when there is one. */
	hash?: `0x${string}`;
	/**
	 * Included and successful, but not final yet.
	 *
	 * The avatar exists on chain from this moment, so what is being waited for is
	 * only the ledger dropping the operation. Worth telling apart: it is the
	 * difference between "your money is in the mempool" and "you own an avatar
	 * and the page has not caught up".
	 */
	landed: boolean;
};

/**
 * The purchase this account has in flight, if any.
 *
 * IDENTIFIED BY WHAT IT CALLS AND WHERE. The tracker populates
 * `{type: 'functionCall', functionName}` for every `writeContract`, and the
 * sale's address pins it to this game's contract, so nothing else the player
 * does can be mistaken for buying an avatar. Matching on the function name
 * alone would be enough today and would stop being enough the moment any other
 * contract in the app gains a `purchase`.
 *
 * WHOSE list it is does not need checking: account data is keyed by the
 * authenticated account, so an operation here belongs to the player whether
 * they paid from their own wallet or somebody else's paid on their behalf.
 * That is the same reasoning `partitionOperationsBySender` records, from the
 * other side.
 *
 * A FAILED transaction is not pending, deliberately: it charged gas, it minted
 * nothing, and the player has to be able to try again. Only a transaction that
 * is still going, or one that has succeeded and not yet been retired from the
 * ledger, stands between them and a second attempt.
 */
export function findPendingPurchase(params: {
	operations: Record<string, OnchainOperation>;
	/** The AvatarsSale address, from the resolved world config. */
	sale: `0x${string}`;
}): PendingPurchase | undefined {
	const {operations, sale} = params;
	const wanted = sale.toLowerCase();

	let found: PendingPurchase | undefined;
	let newest = -Infinity;

	for (const [id, operation] of Object.entries(operations)) {
		const metadata = operation.metadata;
		if (metadata.type !== 'functionCall') continue;
		if (metadata.functionName !== 'purchase') continue;
		// `call.to`: what was ASKED is one fact per operation now, hoisted out of
		// the metadata it used to be nested beside.
		if (operation.call.to?.toLowerCase() !== wanted) continue;

		// The same rule the transaction list and the pending badge use, rather than
		// a second reading of the observer's state here. Two answers to "is this
		// still happening" is how a spinner and a list end up contradicting each
		// other in front of the player.
		const status = getOperationStatusInfo(operation.state).kind;
		if (status !== 'pending' && status !== 'success') continue;

		// Ids are generated from the clock, so the largest is the most recent. It
		// only matters when there is more than one, which means a player who
		// bought a second avatar deliberately: report the one still happening now.
		const at = Number(id);
		if (!(at > newest)) continue;
		newest = at;
		found = {
			id,
			// The first broadcast, exactly as before: `attempts` is the app's own
			// list of dispatches, in the order it made them.
			hash: operation.attempts[0]?.hash,
			landed: status === 'success',
		};
	}

	return found;
}
