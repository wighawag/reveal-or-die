/**
 * Where a pending round is kept between page loads.
 *
 * The stake is real, so losing this file's contents costs the player money:
 * without the secret, a commitment cannot be opened and the bond is forfeited
 * by `acknowledgeMissedReveal`. Everything here is written with that in mind.
 *
 * Scoped to chain + contract + player, so that switching account or network
 * cannot surface someone else's pending round (which would then fail to reveal
 * and look like a bug in the contract).
 */
import type {RoundStorage, PersistedRound} from '$lib/game/core/round';
import type {Placement} from './commit-reveal';

const PREFIX = '__placement_round__';

type StoredRound = {
	epoch: number;
	/** bigint has no JSON representation, so cell ids travel as strings. */
	actions: string[];
	secret: `0x${string}`;
	committed: boolean;
};

export function roundStorageKey(params: {
	chainID: string | number;
	gameAddress: string;
	player: string;
}): string {
	return `${PREFIX}${params.chainID}_${params.gameAddress}_${params.player}`.toLowerCase();
}

/**
 * A `RoundStorage` backed by localStorage.
 *
 * Every operation is defensive: storage can be full, disabled, or hold
 * something from an older version of the app. A throw from here during a commit
 * would be the worst possible time for one, so failures degrade to "no pending
 * round" instead. The one case that is NOT swallowed is a failed write, which
 * is surfaced through `onWriteFailure` so the game can refuse to commit rather
 * than commit something it will not be able to open.
 */
export function createRoundStorage(params: {
	key: string;
	onWriteFailure?: (error: unknown) => void;
}): RoundStorage<Placement> {
	const {key} = params;

	return {
		load() {
			if (typeof localStorage === 'undefined') return undefined;
			try {
				const raw = localStorage.getItem(key);
				if (!raw) return undefined;
				const stored = JSON.parse(raw) as StoredRound;
				if (
					typeof stored?.epoch !== 'number' ||
					!Array.isArray(stored.actions) ||
					typeof stored.secret !== 'string'
				) {
					return undefined;
				}
				return {
					epoch: stored.epoch,
					actions: stored.actions.map((cellID) => ({cellID: BigInt(cellID)})),
					secret: stored.secret,
					committed: !!stored.committed,
				} satisfies PersistedRound<Placement>;
			} catch {
				// Unparseable is indistinguishable from absent as far as what can be
				// done about it, and throwing here would break the whole game.
				return undefined;
			}
		},

		save(round) {
			if (typeof localStorage === 'undefined') return;
			const stored: StoredRound = {
				epoch: round.epoch,
				actions: round.actions.map((placement) => placement.cellID.toString()),
				secret: round.secret,
				committed: round.committed,
			};
			try {
				localStorage.setItem(key, JSON.stringify(stored));
			} catch (error) {
				params.onWriteFailure?.(error);
			}
		},

		clear() {
			if (typeof localStorage === 'undefined') return;
			try {
				localStorage.removeItem(key);
			} catch {
				// Nothing useful to do; a stale entry is handled on load by the
				// round, which discards anything from a past epoch.
			}
		},
	};
}

/** A storage that keeps nothing, for SSR and for a disconnected player. */
export const noRoundStorage: RoundStorage<Placement> = {
	load: () => undefined,
	save: () => {},
	clear: () => {},
};
