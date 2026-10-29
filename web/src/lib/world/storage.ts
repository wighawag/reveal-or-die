/**
 * Keeping the planned submission across a reload.
 *
 * A submission spans two phases and a page can be closed between them. The
 * secret and the exact actions are the only things that can open a commitment,
 * and they exist nowhere else: losing them costs the player the turn, and with
 * the missed-reveal guard re-enabled it also blocks the next one until they
 * acknowledge it. So this is load-bearing rather than a convenience.
 *
 * IN THE ACCOUNT DATA since step 8 of stratagems' plan (P8): the base's
 * storage (`$lib/game/core/commit-reveal/storage`) keeps the plan and every
 * committed turn there, synced and encrypted wherever the account data is,
 * keyed by chain, game and AVATAR. What is this game's is the FORMAT below:
 * how one action is written.
 */
import {
	createAccountDataSubmissionStorage,
	noSubmissionStorage as baseNoSubmissionStorage,
	type AccountDataSubmissionStorage,
	type SubmissionAccountData,
	type SubmissionStorageFormat,
} from '$lib/game/core/commit-reveal/storage';
import type {SubmissionStorage} from '$lib/game/core/submission';
import type {Action} from './commit-reveal';

type StoredAction = {actionType: number; data: string};

/**
 * HOW ONE ACTION IS WRITTEN, AND IT IS A WIRE.
 *
 * `data` is a packed position and can exceed Number.MAX_SAFE_INTEGER once y is
 * non-zero (it is shifted left 32 bits), so it is stored as a STRING. JSON has
 * no bigint, and letting it round-trip through a number would corrupt the
 * commitment silently: the reveal would hash different actions from the ones
 * committed and revert.
 *
 * The records MOVED from `localStorage` (`__world_submission_*`, whose reader
 * is deleted rather than kept as a fallback). That was free for the reason the
 * previous rename was: nothing of this game can be in flight. reveal-or-die and
 * bomber-world have no committed deployment records (`git ls-files
 * contracts/deployments` is empty on both), and an orphaned record here is the
 * recovery path's job anyway, because the secret is DERIVED and
 * `world/recover-submission.ts` searches the maze for the walk that hashes to
 * the commitment the chain holds. **Once this game has a live deployment its
 * players can reach, this format is an ABI**: change it the way you would
 * change the contract's.
 */
export const WORLD_STORAGE: SubmissionStorageFormat<Action> = {
	encode: (action): StoredAction => ({
		actionType: action.actionType,
		data: action.data.toString(),
	}),
	decode: (stored) => {
		const action = stored as StoredAction;
		return {actionType: Number(action.actionType), data: BigInt(action.data)};
	},
};

/**
 * One avatar's submission, in the account data.
 *
 * Keyed by the AVATAR, which the template's equivalent has no need for. This
 * client plays one avatar at a time and the player can switch, so a key without
 * it would load the previous avatar's planned actions and commit them for the
 * new one. The chain and game address are in it for the usual reason: the same
 * account may play the same game on two chains, or two deployments on one.
 */
export function createSubmissionStorage(params: {
	accountData: SubmissionAccountData;
	chainId: string | number;
	contract: `0x${string}`;
	avatarID: bigint;
}): AccountDataSubmissionStorage<Action> {
	return createAccountDataSubmissionStorage<Action, {}, bigint>({
		accountData: params.accountData,
		format: WORLD_STORAGE,
		chainId: params.chainId,
		contract: params.contract,
		identity: params.avatarID,
	});
}

/** A storage that keeps nothing, for SSR and for a player with no avatar. */
export const noSubmissionStorage: SubmissionStorage<Action> =
	baseNoSubmissionStorage<Action>();
