import {encodeAbiParameters, keccak256} from 'viem';

/** Mirrors `UsingGameTypes.ActionType`. The order is the enum's order. */
export const ActionType = {
	Enter: 0,
	Move: 1,
	Exit: 2,
} as const;

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

/** Exactly what the contract hashes: `abi.encode(secret, actions)`. */
export function encodeCommitment(
	secret: `0x${string}`,
	actions: readonly Action[],
): `0x${string}` {
	return encodeAbiParameters(
		[{type: 'bytes32'}, {type: 'tuple[]', components: ACTION_COMPONENTS}],
		[secret, actions as Action[]],
	);
}

/**
 * The commitment the contract recomputes at reveal:
 * `bytes24(keccak256(abi.encode(secret, actions)))`.
 *
 * `bytes24` is the LEFTMOST 24 bytes of the digest, which is 48 hex characters
 * after the `0x`. Truncating the wrong end produces a hash that is the right
 * SHAPE and never matches, and the failure arrives a phase later at reveal,
 * once the commitment is already immovable.
 *
 * It lives here rather than in the app because it has to agree with
 * `UsingGameInternal._checkHash` exactly, and here it is covered by tests that
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
