/**
 * Where a pending submission is kept between page loads.
 *
 * The stake is real, so losing this file's contents costs the player money:
 * without the secret, a commitment cannot be opened and the bond is forfeited
 * by `acknowledgeMissedReveal`. Everything here is written with that in mind.
 *
 * Scoped to chain + contract + player, so that switching account or network
 * cannot surface someone else's pending submission (which would then fail to
 * reveal and look like a bug in the contract).
 */
import type {
	SubmissionStorage,
	PersistedSubmission,
} from '$lib/game/core/submission';
import type {GameIdentity} from '$lib/game/identity';
import type {Placement} from './commit-reveal';

const PREFIX = '__placement_submission__';

/**
 * THE ON-DISK SHAPE, and renaming anything in it is a decision rather than a
 * tidy-up.
 *
 * This type and the key above are a SERIALISED SHAPE, so they are the one place
 * in this game where a rename can cost a player their stake. Once a game built
 * on this template has users, renaming the key or a field means `load()` cannot
 * read what the previous build wrote; it discards the record, and with it the
 * secret that opens a commitment in flight, which is the bond gone.
 *
 * The failure is silent in the worst way: every suite stays green, because the
 * tests are renamed alongside the code and nothing reads a record written by an
 * older build. It would be found by a player, at their own expense.
 *
 * Renaming it here was free, and that was CHECKED rather than assumed: this
 * repo has no committed deployment records, so nothing is deployed and no
 * record can be in flight. A game built from this template starts at its own
 * first deploy and cannot hold a record written by a previous build of the
 * TEMPLATE, so it inherits this shape without inheriting the problem. Once that
 * game ships, this comment is the one to read before touching either name.
 */
type StoredSubmission = {
	cycleNumber: number;
	/** bigint has no JSON representation, so cell ids travel as strings. */
	actions: string[];
	secret: `0x${string}`;
	committed: boolean;
};

/**
 * Scoped to chain + contract + WHO PLAYS.
 *
 * The last part is the identity rather than the account, which is the whole
 * difference between one pending submission per account and one per thing the
 * account plays with. A game that keys by a token and scoped this by the
 * account instead would load the previous token's planned actions and commit
 * them for the next one.
 */
export function submissionStorageKey(params: {
	chainID: string | number;
	gameAddress: string;
	player: GameIdentity;
}): string {
	return `${PREFIX}${params.chainID}_${params.gameAddress}_${params.player}`.toLowerCase();
}

/**
 * A `SubmissionStorage` backed by localStorage.
 *
 * Every operation is defensive: storage can be full, disabled, or hold
 * something from an older version of the app. A throw from here during a commit
 * would be the worst possible time for one, so failures degrade to "no pending
 * submission" instead. The one case that is NOT swallowed is a failed write,
 * which is surfaced through `onWriteFailure` so the game can refuse to commit
 * rather than commit something it will not be able to open.
 */
export function createSubmissionStorage(params: {
	key: string;
	onWriteFailure?: (error: unknown) => void;
}): SubmissionStorage<Placement> {
	const {key} = params;

	return {
		load() {
			if (typeof localStorage === 'undefined') return undefined;
			try {
				const raw = localStorage.getItem(key);
				if (!raw) return undefined;
				const stored = JSON.parse(raw) as StoredSubmission;
				if (
					typeof stored?.cycleNumber !== 'number' ||
					!Array.isArray(stored.actions) ||
					typeof stored.secret !== 'string'
				) {
					return undefined;
				}
				return {
					cycleNumber: stored.cycleNumber,
					actions: stored.actions.map((cellID) => ({cellID: BigInt(cellID)})),
					secret: stored.secret,
					committed: !!stored.committed,
				} satisfies PersistedSubmission<Placement>;
			} catch {
				// Unparseable is indistinguishable from absent as far as what can be
				// done about it, and throwing here would break the whole game.
				return undefined;
			}
		},

		save(submission) {
			if (typeof localStorage === 'undefined') return;
			const stored: StoredSubmission = {
				cycleNumber: submission.cycleNumber,
				actions: submission.actions.map((placement) =>
					placement.cellID.toString(),
				),
				secret: submission.secret,
				committed: submission.committed,
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
				// submission, which discards anything from a past cycle.
			}
		},
	};
}

/** A storage that keeps nothing, for SSR and for a disconnected player. */
export const noSubmissionStorage: SubmissionStorage<Placement> = {
	load: () => undefined,
	save: () => {},
	clear: () => {},
};
