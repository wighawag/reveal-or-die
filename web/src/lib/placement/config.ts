/**
 * The template game's constants, read off the deployment.
 *
 * Everything here comes from the Game contract's `linkedData` (what the deploy
 * script recorded) rather than being duplicated in the front end, so changing
 * the phase durations or the placement cost in `contracts/deploy` cannot leave
 * the UI describing a different game from the one on chain.
 */
import type {TypedDeployments} from '$lib/core/connection/types';
import {resolveEpochConfig, type EpochConfig} from '$lib/game/core/epoch';

export type PlacementConfig = {
	epoch: EpochConfig;
	/** What one placement costs, taken from the player's reserve on reveal. */
	placementCost: bigint;
	/** The ERC20 the reserve is denominated in. */
	tokenAddress: `0x${string}`;
	/** Pixels per cell. Only the render layer cares, but the click maths needs it too. */
	cellSize: number;
};

type GameLinkedData = {
	startTime: unknown;
	commitPhaseDuration: unknown;
	revealPhaseDuration: unknown;
	placementCost: unknown;
	tokens: unknown;
};

export function resolvePlacementConfig(
	deployments: TypedDeployments,
): PlacementConfig {
	const linkedData = deployments.contracts.Game.linkedData as GameLinkedData;

	return {
		epoch: resolveEpochConfig(linkedData),
		placementCost: BigInt(linkedData.placementCost as string | number | bigint),
		tokenAddress: linkedData.tokens as `0x${string}`,
		cellSize: 10,
	};
}

/** What a set of placements will cost, and so what has to be bonded. */
export function costOfPlacements(
	config: PlacementConfig,
	count: number,
): bigint {
	return config.placementCost * BigInt(count);
}
