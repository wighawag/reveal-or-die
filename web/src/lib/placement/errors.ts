/**
 * Recognising the one failure a player can actually do something about.
 *
 * A move is signed by the local signer, which holds nothing until someone puts
 * gas in it. When it runs dry every commit and every reveal fails, and a reveal
 * that fails costs the player their stake, so this is the failure most worth
 * naming precisely and offering a remedy for.
 *
 * Moves deliberately do NOT go through `balanceCheck.ensureCanAfford`, which is
 * the app's pre-flight check for user-initiated spending: it opens a modal for
 * the duration of the call, and a modal over the board on every commit and
 * every reveal is exactly the interruption the signer exists to remove. So the
 * shortfall is caught HERE, after the fact, from what the node said.
 *
 * Matching on message text is unpleasant and is done anyway, because there is
 * no structured signal: viem surfaces the node's own wording, and the nodes do
 * not agree. Hardhat says "sender doesn't have enough funds", geth and most
 * others say "insufficient funds". A missed match is not dangerous, it only
 * means the player is shown a generic failure instead of a top-up button, so
 * the patterns are kept broad and the fallback stays honest.
 *
 * This belongs upstream next to `txErrorSummary` once it has settled; it is
 * here for now so `$lib/core` stays mergeable with jolly-roger.
 */

/** A move that failed because the account sending it could not pay the gas. */
export class SignerOutOfFundsError extends Error {
	constructor(
		/** What the node actually said, kept for the details view. */
		readonly cause: unknown,
	) {
		super('Not enough gas to send this move.');
		this.name = 'SignerOutOfFundsError';
	}
}

const PATTERNS = [
	/insufficient funds/i,
	/doesn'?t have enough funds/i,
	/does not have enough funds/i,
	/exceeds the balance/i,
	/gas \* price \+ value/i,
];

/** Whether a failure was the sender being unable to pay for the transaction. */
export function isInsufficientFunds(error: unknown): boolean {
	if (error instanceof SignerOutOfFundsError) return true;

	// Walk the cause chain: viem wraps the node's message several layers deep,
	// and the useful wording is rarely on the outermost error.
	let current: unknown = error;
	for (let depth = 0; current && depth < 8; depth++) {
		const text = messageOf(current);
		if (text && PATTERNS.some((pattern) => pattern.test(text))) return true;
		current = (current as {cause?: unknown}).cause;
	}
	return false;
}

function messageOf(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value && typeof value === 'object') {
		const candidate = value as {
			message?: unknown;
			shortMessage?: unknown;
			details?: unknown;
		};
		return [candidate.shortMessage, candidate.message, candidate.details]
			.filter((part): part is string => typeof part === 'string')
			.join('\n');
	}
	return '';
}
