/**
 * Reading the board.
 *
 * Supplies the two game-shaped halves of the framework's polling state store:
 * which zones the camera implies, and how to read them. `getCellsInZones` exists
 * on the contract precisely so this can be a real camera-scoped read rather
 * than a whole-world fetch that only works while the world is small.
 */
import type {
	TypedDeployments,
	TypedPublicClient,
} from '$lib/core/connection/types';
import type {ZonesForCamera, ZonesReader} from '$lib/onchain/state';
import {zonesInRect} from './cells';

/** A cell as the board holds it: shared, with a total stake and a claimant count. */
export type Cell = {
	cellID: bigint;
	totalStake: bigint;
	numClaimants: number;
};

export type BoardState = {
	cells: Map<bigint, Cell>;
};

/**
 * How much beyond the visible area to load, as a fraction of the camera's own
 * size. Zones are the fetch unit and a zone is 16 cells across, so a small
 * margin costs nothing extra most of the time while keeping cells from popping
 * in at the edge during a pan.
 */
const CAMERA_MARGIN = 0.5;

export const zonesForCamera: ZonesForCamera = (camera) => {
	// The camera reports its CENTRE and its extent, so the visible rectangle is
	// half the extent either side. Getting this wrong is invisible in the middle
	// of the board and only shows up as missing cells at the edges.
	const halfWidth = (camera.width / 2) * (1 + CAMERA_MARGIN);
	const halfHeight = (camera.height / 2) * (1 + CAMERA_MARGIN);

	return zonesInRect({
		left: camera.x - halfWidth,
		right: camera.x + halfWidth,
		top: camera.y - halfHeight,
		bottom: camera.y + halfHeight,
	});
};

type CellAt = {cellID: bigint; totalStake: bigint; numClaimants: number};

/**
 * How many zones to ask for in one call.
 *
 * `getCellsInZones` walks all 16x16 cells of every zone it is given, twice
 * (once to count, once to fill), so its cost grows with the number of zones
 * and NOT with how much is actually on the board. Past a certain number the
 * read exceeds the node's `eth_call` gas cap and comes back as a revert - and
 * because the Game sits behind a router, that surfaces as the router's
 * "function selector was not recognized" rather than as anything resembling
 * out-of-gas. On a stock hardhat node the wall is 14 zones; a camera at the
 * default zoom already asks for 15, so this is not an edge case.
 *
 * Eight leaves generous headroom for a node with a lower cap. The proper fix
 * belongs in the contract (track the occupied cells of a zone, so a read costs
 * what the zone holds rather than a flat 256 slots); batching here is correct
 * regardless, since no single call can be allowed to grow without bound.
 */
const ZONES_PER_CALL = 8;

function chunk<T>(items: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

export function createBoardReader(params: {
	publicClient: TypedPublicClient;
	deployments: TypedDeployments;
}): ZonesReader<BoardState> {
	const {publicClient, deployments} = params;

	// `fromBlock`/`toBlock` are part of the seam because a game that builds its
	// state from LOGS needs them (conquest does). This game reads the board
	// straight out of contract storage, so the answer is whatever the node's
	// latest block says and the range is not used.
	return async ({zones, expectedEpoch}) => {
		if (zones.length === 0) return {cells: new Map(), epoch: expectedEpoch};

		const batches = await Promise.all(
			chunk(zones, ZONES_PER_CALL).map(
				(batch) =>
					publicClient.readContract({
						address: deployments.contracts.Game.address,
						abi: deployments.contracts.Game.abi,
						functionName: 'getCellsInZones',
						args: [batch],
					}) as Promise<[readonly CellAt[], bigint]>,
			),
		);

		const byID = new Map<bigint, Cell>();
		for (const [cells, epoch] of batches) {
			// Every batch has to be from the same epoch as the one asked for. A
			// batch that is not means the chain moved under the read, and stitching
			// the halves together would produce a board that never existed.
			// Returning undefined tells the framework the node has not caught up;
			// it retries rather than treating it as a failed read.
			if (Number(epoch) !== expectedEpoch) return undefined;

			for (const cell of cells) {
				byID.set(cell.cellID, {
					cellID: cell.cellID,
					totalStake: cell.totalStake,
					numClaimants: Number(cell.numClaimants),
				});
			}
		}

		return {cells: byID, epoch: expectedEpoch};
	};
}

export const emptyBoard = (): BoardState => ({cells: new Map()});
