/**
 * Keeping the planned submission across a reload.
 *
 * A submission spans two phases and a page can be closed between them. The
 * secret and the exact actions are the only things that can open a commitment,
 * and they exist nowhere else: losing them costs the player the turn, and with
 * the missed-reveal guard re-enabled it also blocks the next one until they
 * acknowledge it. So this is load-bearing rather than a convenience.
 */
import type {
	PersistedSubmission,
	SubmissionStorage,
} from '$lib/game/core/submission';
import type {Action} from './commit-reveal';

const PREFIX = '__world_submission_';

/**
 * Where one submission is kept.
 *
 * Includes the AVATAR, which the template's equivalent has no need for. This
 * client plays one avatar at a time and the player can switch, so a key without
 * it would load the previous avatar's planned actions and commit them for the
 * new one. The chain and game address are in it for the usual reason: the same
 * browser may play the same game on two chains, or two deployments on one.
 */
export function submissionStorageKey(params: {
	chainID: string | number;
	gameAddress: string;
	avatarID: bigint | string;
}): string {
	return `${PREFIX}${params.chainID}_${params.gameAddress}_${params.avatarID}`.toLowerCase();
}

type StoredAction = {actionType: number; data: string};

/**
 * THE ON-DISK SHAPE, AND IT WAS RENAMED OUTRIGHT.
 *
 * This type and `PREFIX` above are a WIRE: `load()` discards any record it
 * cannot read, so renaming either normally orphans a commitment in flight and
 * costs the player the AVATAR this game puts at stake. That is the third
 * commit-reveal rule in `AGENTS.md`, and it is why this was held back once
 * already.
 *
 * It was renamed anyway, in reveal-or-die, and the reason was CHECKED FOR THAT
 * REPO rather than inherited from the template. The template could rename its
 * own because it has no committed deployment at all; that argument does not
 * transfer, because reveal-or-die HAS one (`contracts/deployments/rise-testnet`).
 * Three things made it free there regardless (and bomber-world, which inherits
 * this file, deleted its records when it was ported, so nothing of its can be
 * in flight at all):
 *
 * 1. THAT DEPLOYMENT IS ALREADY UNREACHABLE by this build. Its `Game` ABI
 *    carries none of `delegationStatus`, `registerDelegate`,
 *    `registerDelegateViaSignature` or `revokeDelegate`, which
 *    `onchain/delegation.ts` calls unconditionally - today's `IGame` composes
 *    `IDelegation` and that deployment predates it. A player cannot get as far
 *    as having a submission in flight against it.
 * 2. A RECORD IS ONLY EVER ACTED ON INSIDE ITS OWN CYCLE. `reveal()` clears it
 *    and reports `Missed` when the cycle has moved on, and `adopt()` refuses
 *    one from another cycle. On that deployment's own config (40s commit, 4s
 *    reveal) the window in which a rename could strand anything is 44 seconds.
 * 3. AND AN ORPHANED RECORD HERE IS NOT A LOST STAKE, it is the recovery
 *    path's job. The secret is DERIVED from a signature, not random, so it is
 *    recomputable; `world/recover-submission.ts` then searches the maze for the
 *    walk that hashes to the commitment the chain is holding.
 *    `web/e2e/tests/recover-submission.e2e.ts` proves exactly this by deleting
 *    every one of these keys and asserting the turn comes back with nothing
 *    asked of the player. The one case that cannot be searched (an ENTRY)
 *    degrades to the documented "ask the player" fallback, still inside the
 *    cycle.
 *
 * So the rule still holds and this is not an exception to it: the rule is about
 * a stake that can actually be in flight, and here none can. **Once this game
 * has a live deployment its players can reach, this type and `PREFIX` are an
 * ABI**: change them the way you would change the contract's.
 */
type StoredSubmission = {
	cycleNumber: number;
	actions: StoredAction[];
	secret: string;
	committed: boolean;
};

/**
 * A `SubmissionStorage` backed by localStorage.
 *
 * Every operation is defensive: storage can be full, disabled, or hold
 * something from an older version of the app. A throw from here during a commit
 * would be the worst possible time for one, so failures degrade to "no pending
 * submission" instead. The one case NOT swallowed is a failed write, surfaced
 * through `onWriteFailure` so the game can refuse to commit rather than commit
 * something it will not be able to open.
 */
export function createSubmissionStorage(params: {
	key: string;
	onWriteFailure?: (error: unknown) => void;
}): SubmissionStorage<Action> {
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
				} satisfies PersistedSubmission<Action>;
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
				actions: submission.actions.map((a) => ({
					actionType: a.actionType,
					data: a.data.toString(),
				})),
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

/** A storage that keeps nothing, for SSR and for a player with no avatar. */
export const noSubmissionStorage: SubmissionStorage<Action> = {
	load: () => undefined,
	save: () => {},
	clear: () => {},
};
