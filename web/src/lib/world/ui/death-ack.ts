/**
 * Remembering that a death has been acknowledged.
 *
 * The death itself is a fact on chain and stays one until the body is
 * withdrawn; the ACKNOWLEDGEMENT is a fact about this browser's UI and exists
 * nowhere on chain at all. So it is kept here, in local storage, scoped like
 * the round storage (chain + game), and the distinction matters: the rule this
 * repo keeps is "never persist a second copy of what the operations ledger
 * holds", and the ledger holds transactions. This holds a dismissal.
 *
 * ONE ENTRY PER AVATAR, holding the death it was last acknowledged for, rather
 * than one entry per death: a dead avatar that is withdrawn never comes back,
 * and one that is re-bought and dies AGAIN has a strictly later `lastEpoch`
 * (it only advances on reveals), so "stored >= this death" re-opens the notice
 * for the new death while keeping the old acknowledgement forever settled.
 */
const PREFIX = '__world_death_ack_';

/** The death being acknowledged, as the HUD model reports it. */
export type Death = {
	avatarID: bigint;
	/**
	 * The epoch of the reveal the avatar died in: its `lastEpoch` at the time.
	 *
	 * This is what makes the acknowledgement about ONE death rather than the
	 * avatar in general - see the module comment.
	 */
	deathEpoch: number;
};

/** The minimum of a storage the acknowledgement keeps. */
export type AckStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
};

export function deathAckKey(params: {
	chainID: string | number;
	gameAddress: string;
	avatarID: bigint | string;
}): string {
	return `${PREFIX}${params.chainID}_${params.gameAddress}_${params.avatarID}`.toLowerCase();
}

export function createDeathAcknowledgement(params: {
	chainID: string | number;
	gameAddress: string;
	/**
	 * Defaults to the global localStorage when there is one. A parameter so the
	 * tests can supply their own rather than needing a browser, and so an
	 * environment with no storage at all degrades to "the notice shows again"
	 * rather than throwing.
	 */
	storage?: AckStorage;
}): {
	/** Whether THIS death has been acknowledged. */
	isAcknowledged(death: Death): boolean;
	/** Record that it has been, so a reload does not repeat the news. */
	acknowledge(death: Death): void;
} {
	const storage =
		params.storage ??
		(typeof localStorage === 'undefined' ? undefined : localStorage);
	const keyOf = (avatarID: bigint) =>
		deathAckKey({
			chainID: params.chainID,
			gameAddress: params.gameAddress,
			avatarID,
		});

	return {
		isAcknowledged(death) {
			if (!storage) return false;
			try {
				// NOTHING STORED AND NOTHING READABLE BOTH READ AS "NOT
				// ACKNOWLEDGED", and the comparison already says so without a
				// guard: `Number(null)` is 0, which is below every epoch (the
				// contract starts them at 2), and anything unparseable is NaN,
				// which is below nothing at all. An old or corrupt entry must
				// never swallow a new death's notice, and this is the direction
				// the arithmetic already fails in.
				const stored = Number(storage.getItem(keyOf(death.avatarID)));
				return stored >= death.deathEpoch;
			} catch {
				return false;
			}
		},

		acknowledge(death) {
			if (!storage) return;
			try {
				storage.setItem(keyOf(death.avatarID), String(death.deathEpoch));
			} catch {
				// A full or disabled storage means the notice may come back after a
				// reload. Annoying, and the honest failure: there is nowhere to
				// record it, and pretending otherwise would hide the news instead.
			}
		},
	};
}
