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
 * `getCellsInZones` now reads a per-zone index of claimed cells, so a viewport
 * costs what the board HOLDS there. Keep batching anyway: the cost is bounded
 * by occupancy rather than by geometry, and occupancy is exactly the thing
 * that grows as a game is played, so an unbatched read would be cheap for as
 * long as it was never tested and expensive once the board filled up.
 *
 * Eight is inherited from when this was a workaround rather than a policy, and
 * the failure it worked around is worth keeping written down, because the
 * shape of it is not obvious: the getter used to walk all 16x16 cells of every
 * zone TWICE, so an empty viewport cost the same as a full one, and past ~14
 * zones the read exceeded the node's `eth_call` gas cap. Because the Game sits
 * behind a router, that surfaced as the router's "function selector was not
 * recognized" rather than as anything resembling out-of-gas. A camera at the
 * default zoom asks for 15 zones, so it was hit immediately, and the same walk
 * cost ~280ms of a local node's single thread per 8 empty zones - enough for a
 * few browsers polling to stall every other call to the chain.
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
	// straight out of contract storage, so the range is not used for content -
	// but `toBlock` still pins WHICH block every call reads, see below.
	return async ({zones, expectedEpoch, toBlock}) => {
		if (zones.length === 0) return {cells: new Map(), epoch: expectedEpoch};

		const batches = await Promise.all(
			chunk(zones, ZONES_PER_CALL).map(
				(batch) =>
					publicClient.readContract({
						address: deployments.contracts.Game.address,
						abi: deployments.contracts.Game.abi,
						functionName: 'getCellsInZones',
						args: [batch],
						// PINNED TO ONE BLOCK. The batches are separate RPC calls
						// against a moving chain, so without this a reveal landing
						// between two of them stitches half a board from before it to
						// half from after: a board that never existed at any moment.
						// It also makes the agreement check below meaningful, since
						// pinned calls can only disagree if the block itself was
						// replaced. A game that reads logs beside this needs the same
						// pin for a further reason: the two reads must not straddle a
						// reveal, or the new state arrives one poll ahead of the event
						// that explains it.
						blockNumber: BigInt(toBlock),
					}) as Promise<[readonly CellAt[], bigint]>,
			),
		);

		const byID = new Map<bigint, Cell>();
		let chainEpoch: number | undefined;
		for (const [cells, epoch] of batches) {
			// THE ONLY REASON A READ IS REFUSED: the batches disagreeing with EACH
			// OTHER. They all read one pinned block, so they normally cannot; one
			// that does means a reorg replaced that block mid-read, and stitching
			// the halves would produce a board that never existed.
			//
			// WHAT IS NO LONGER REFUSED is a chain epoch that differs from the one
			// asked for. This used to require an exact match, which turned a
			// two-clock disagreement of SECONDS into a failed read: the client's
			// clock interpolates from the wall clock between blocks, so it crosses
			// a round boundary before the chain has mined a block past it, and the
			// contract answers from its latest block with the previous round.
			// Refusing that ran the framework's catch-up budget out and turned it
			// into exponential backoff behind an RPC-health banner, over a board
			// that was a moment behind and nothing worse.
			const at = Number(epoch);
			if (chainEpoch === undefined) chainEpoch = at;
			else if (at !== chainEpoch) return undefined;

			for (const cell of cells) {
				byID.set(cell.cellID, {
					cellID: cell.cellID,
					totalStake: cell.totalStake,
					numClaimants: Number(cell.numClaimants),
				});
			}
		}

		// STAMPED WITH THE EPOCH THE FETCH WAS FOR, not the one the chain's latest
		// block reports, because that is what "has the board caught up" means for
		// everything downstream. Stamping the CHAIN's epoch instead makes the
		// catch-up last until a block past the boundary is mined - on a node that
		// mines only on transactions, that is the next commit, some twenty seconds
		// in - and all of it is a wait for a COUNTER when the data has already
		// arrived. Nothing the board reads can change in that gap: a reveal mined
		// after the boundary is refused (`InCommitmentPhase`) and a commit places
		// nothing, so a fetch landing after the clock ticks already holds the new
		// round in full.
		return {cells: byID, epoch: expectedEpoch};
	};
}

export const emptyBoard = (): BoardState => ({cells: new Map()});
