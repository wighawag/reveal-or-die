/**
 * Keeping the planned round across a reload.
 *
 * A commit-reveal round spans two phases and a page can be closed between them.
 * The secret and the exact actions are the only things that can open a
 * commitment, and they exist nowhere else: losing them costs the player the
 * turn, and with the missed-reveal guard re-enabled it also blocks the next
 * one until they acknowledge it. So this is load-bearing rather than a
 * convenience.
 */
import type {PersistedRound, RoundStorage} from '$lib/game/core/round';
import type {Action} from './commit-reveal';

const PREFIX = '__world_round_';

/**
 * Where one round is kept.
 *
 * Includes the AVATAR, which the template's equivalent has no need for. This
 * client plays one avatar at a time and the player can switch, so a key without
 * it would load the previous avatar's planned actions and commit them for the
 * new one. The chain and game address are in it for the usual reason: the same
 * browser may play the same game on two chains, or two deployments on one.
 */
export function roundStorageKey(params: {
	chainID: string | number;
	gameAddress: string;
	avatarID: bigint | string;
}): string {
	return `${PREFIX}${params.chainID}_${params.gameAddress}_${params.avatarID}`.toLowerCase();
}

type StoredAction = {actionType: number; data: string};

type StoredRound = {
	epoch: number;
	actions: StoredAction[];
	secret: string;
	committed: boolean;
};

/**
 * A `RoundStorage` backed by localStorage.
 *
 * Every operation is defensive: storage can be full, disabled, or hold
 * something from an older version of the app. A throw from here during a commit
 * would be the worst possible time for one, so failures degrade to "no pending
 * round" instead. The one case NOT swallowed is a failed write, surfaced
 * through `onWriteFailure` so the game can refuse to commit rather than commit
 * something it will not be able to open.
 */
export function createRoundStorage(params: {
	key: string;
	onWriteFailure?: (error: unknown) => void;
}): RoundStorage<Action> {
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
					// `data` is a packed position and can exceed Number.MAX_SAFE_INTEGER
					// once y is non-zero (it is shifted left 32 bits), so it is stored
					// as a STRING. JSON has no bigint, and letting it round-trip through
					// a number would corrupt the commitment silently: the reveal would
					// hash different actions from the ones committed and revert.
					actions: stored.actions.map((a) => ({
						actionType: Number(a.actionType),
						data: BigInt(a.data),
					})),
					secret: stored.secret as `0x${string}`,
					committed: !!stored.committed,
				} satisfies PersistedRound<Action>;
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
				actions: round.actions.map((a) => ({
					actionType: a.actionType,
					data: a.data.toString(),
				})),
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
				// Nothing useful to do; a stale entry is handled on load by the round,
				// which discards anything from a past epoch.
			}
		},
	};
}

/** A storage that keeps nothing, for SSR and for a player with no avatar. */
export const noRoundStorage: RoundStorage<Action> = {
	load: () => undefined,
	save: () => {},
	clear: () => {},
};
