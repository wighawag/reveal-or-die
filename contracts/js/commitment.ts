import {encodeAbiParameters, keccak256} from 'viem';

/** Mirrors `UsingGameTypes.ActionType`. The order is the enum's order. */
export const ActionType = {
	Enter: 0,
	Move: 1,
	Exit: 2,
} as const;

/**
 * Mirrors `UsingGameStore.ACTIONS_BESIDES_MOVES`: what the longest turn that can
 * resolve carries besides its moves, an Exit (an Enter is a turn of its own).
 *
 * A turn is ONE reveal here, and a reveal carrying more than the deployment's
 * `actionsPerReveal` is refused outright (`TooManyActions`), after the
 * commitment is already fixed. The contract refuses a deployment whose
 * `actionsPerReveal` is below `numMoves + ACTIONS_BESIDES_MOVES`, and the client
 * checks the same bound when it reads the deployment (`world/config.ts`), so
 * every turn the planner can build is a turn that can be revealed.
 */
export const ACTIONS_BESIDES_MOVES = 1;

export type ActionTypeValue = (typeof ActionType)[keyof typeof ActionType];

/**
 * Mirrors `UsingGameTypes.Action`.
 *
 * `data` is an ABSOLUTE packed position (`y << 32 | x`) for Enter and Move. It
 * is not a direction and not a distance, whatever the `NWSE` comment above the
 * dispatch in `_forEachActions` suggests.
 */
export type Action = {
	actionType: number;
	data: bigint;
};

const ACTION_COMPONENTS = [
	{name: 'actionType', type: 'uint8'},
	{name: 'data', type: 'uint128'},
] as const;

/**
 * `furtherActions`, the hash of the next chunk of a turn, is always zero here:
 * a turn is ONE chunk (`UsingGameInternal._reveal`). It is hashed anyway,
 * because the commit-reveal base has one encoding for every game.
 */
const NO_FURTHER_ACTIONS = `0x${'00'.repeat(24)}` as const;

/**
 * Exactly what the contract hashes:
 * `abi.encode(secret, actions, furtherActions)`, with `furtherActions` zero.
 */
export function encodeCommitment(
	secret: `0x${string}`,
	actions: readonly Action[],
): `0x${string}` {
	return encodeAbiParameters(
		[
			{type: 'bytes32'},
			{type: 'tuple[]', components: ACTION_COMPONENTS},
			{type: 'bytes24'},
		],
		[secret, actions as Action[], NO_FURTHER_ACTIONS],
	);
}

/**
 * The commitment the contract recomputes at reveal:
 * `bytes24(keccak256(abi.encode(secret, actions, bytes24(0))))`.
 *
 * `bytes24` is the LEFTMOST 24 bytes of the digest, which is 48 hex characters
 * after the `0x`. Truncating the wrong end produces a hash that is the right
 * SHAPE and never matches, and the failure arrives a phase later at reveal,
 * once the commitment is already immovable.
 *
 * It lives here rather than in the app because it has to agree with
 * `UsingGameInternal._digest` exactly, and here it is covered by tests that
 * run against a real chain.
 */
export function commitmentHash(
	secret: `0x${string}`,
	actions: readonly Action[],
): `0x${string}` {
	return keccak256(encodeCommitment(secret, actions)).slice(
		0,
		50,
	) as `0x${string}`;
}
