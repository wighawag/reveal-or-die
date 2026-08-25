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
	/**
	 * Pixels per cell at 1:1 zoom.
	 *
	 * Only a scene-graph renderer cares: it is the unit pixi content is authored
	 * in. The camera and the click maths are in game units and do not use it.
	 */
	cellSize: number;
	/**
	 * What the camera may show, in CELLS.
	 *
	 * Here rather than in a canvas component because it is a statement about the
	 * GAME (how much board is playable at a glance), not about a rendering
	 * library, and because both canvas hosts have to agree on it.
	 */
	camera: {
		/** How much board is visible on the first frame. */
		initialVisible: {width: number; height: number};
		/** Zoom limits, as the smallest and largest slice of board on screen. */
		limits: {
			minWidth: number;
			minHeight: number;
			maxWidth: number;
			maxHeight: number;
		};
	};
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
		camera: {
			initialVisible: {width: 24, height: 24},
			limits: {minWidth: 10, minHeight: 10, maxWidth: 100, maxHeight: 100},
		},
	};
}

/** What a set of placements will cost, and so what has to be bonded. */
export function costOfPlacements(
	config: PlacementConfig,
	count: number,
): bigint {
	return config.placementCost * BigInt(count);
}
