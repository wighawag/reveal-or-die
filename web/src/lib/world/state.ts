/**
 * Reading the world.
 *
 * Supplies the two game-shaped halves of the framework's polling state store:
 * which zones the camera implies, and how to read them. This game's board is
 * the set of avatars standing in those zones, so `getAvatarsInMultipleZones` is
 * the read, and it is camera-scoped rather than whole-world because the world
 * has no edge to stop at.
 */
import type {
	TypedDeployments,
	TypedPublicClient,
} from '$lib/core/connection/types';
import type {ZonesForCamera, ZonesReader} from '$lib/onchain/state';
import {
	bigIntIDToXY,
	zoneCoord,
	zoneIDFromZoneCoords,
	type Position,
} from 'reveal-or-die-contracts';

/** An avatar as the world holds it. */
export type Avatar = {
	avatarID: bigint;
	owner: `0x${string}`;
	inGame: boolean;
	position: Position;
	lastEpoch: number;
	life: number;
};

export type WorldState = {
	avatars: Map<bigint, Avatar>;
};

export const emptyWorld = (): WorldState => ({avatars: new Map()});

/**
 * How much beyond the visible area to load, as a fraction of the camera's own
 * size. Zones are the fetch unit and a zone is 16 cells across, so a small
 * margin usually costs nothing extra while keeping avatars from popping in at
 * the edge during a pan.
 */
const CAMERA_MARGIN = 0.5;

/**
 * Ceiling on how many zones one fetch may cover.
 *
 * Zoom is continuous and the number of zones grows with its SQUARE, so without
 * a cap a player who zooms far out asks for thousands of zones and the read
 * stops answering. Clamping degrades to "the middle of what you can see is
 * live" instead, which is wrong in a way the player can understand.
 */
const MAX_ZONES = 64;

export const zonesForCamera: ZonesForCamera = (camera) => {
	// The camera reports its CENTRE and its extent, so the visible rectangle is
	// half the extent either side. Getting this wrong is invisible in the middle
	// of the board and shows up only as missing avatars at the edges.
	const halfWidth = (camera.width / 2) * (1 + CAMERA_MARGIN);
	const halfHeight = (camera.height / 2) * (1 + CAMERA_MARGIN);

	const zx0 = zoneCoord(Math.floor(camera.x - halfWidth));
	const zx1 = zoneCoord(Math.ceil(camera.x + halfWidth));
	const zy0 = zoneCoord(Math.floor(camera.y - halfHeight));
	const zy1 = zoneCoord(Math.ceil(camera.y + halfHeight));

	const zones: bigint[] = [];
	for (let zy = zy0; zy <= zy1; zy++) {
		for (let zx = zx0; zx <= zx1; zx++) {
			zones.push(zoneIDFromZoneCoords(zx, zy));
			if (zones.length >= MAX_ZONES) return zones;
		}
	}
	return zones;
};

/**
 * How many zones to ask for in one call.
 *
 * The getter walks each zone's avatar array, so a call costs what the world
 * HOLDS there rather than what it spans. Occupancy is the thing that grows as
 * a game is played, which is exactly why this is batched now: an unbatched
 * read is cheap for as long as nobody is playing.
 */
const ZONES_PER_CALL = 8;

/** Avatars per page within one batch. See the pagination note in the reader. */
const PAGE_SIZE = 200n;

/** Refuses to loop forever if `more` never goes false. */
const MAX_PAGES = 50;

type PublicAvatar = {
	owner: `0x${string}`;
	avatarID: bigint;
	inGame: boolean;
	position: bigint;
	lastEpoch: bigint;
	life: number;
};

function chunk<T>(items: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

export function createWorldReader(params: {
	publicClient: TypedPublicClient;
	deployments: TypedDeployments;
}): ZonesReader<WorldState> {
	const {publicClient, deployments} = params;

	// `fromBlock`/`toBlock` are part of the seam because a game that builds its
	// state from LOGS needs them. This game reads standing avatars straight out
	// of contract storage, so the range is unused here. Revealed-action history,
	// which IS a log read, is a separate concern and not part of this store.
	return async ({zones, expectedEpoch}) => {
		if (zones.length === 0) return {avatars: new Map(), epoch: expectedEpoch};

		const Game = deployments.contracts.Game;

		async function readBatch(
			batch: bigint[],
		): Promise<PublicAvatar[] | undefined> {
			const collected: PublicAvatar[] = [];
			// `fromIndex` is a FLAT index across the whole batch of zones, not a
			// per-zone one, so paging walks the concatenation of their avatar
			// arrays.
			let fromIndex = 0n;
			for (let page = 0; page < MAX_PAGES; page++) {
				const [avatars, more, epoch] = (await publicClient.readContract({
					address: Game.address,
					abi: Game.abi,
					functionName: 'getAvatarsInMultipleZones',
					args: [batch, fromIndex, PAGE_SIZE],
				})) as [readonly PublicAvatar[], boolean, bigint];

				// Every page must be from the epoch we asked about. One that is not
				// means the chain moved under the read, and stitching the halves
				// together would produce a world that never existed. Undefined tells
				// the framework to retry rather than treating it as a failed read.
				if (Number(epoch) !== expectedEpoch) return undefined;

				collected.push(...avatars);

				// `more` is true when the page exactly exhausted the list (the
				// contract tests `fromIndex + limit > total`, so an exact fit takes
				// the `else`). That costs one extra call returning nothing, which is
				// why the empty page rather than `more` is what ends the loop.
				if (!more || avatars.length === 0) return collected;
				fromIndex += BigInt(avatars.length);
			}
			return collected;
		}

		const batches = await Promise.all(
			chunk(zones, ZONES_PER_CALL).map(readBatch),
		);

		const byID = new Map<bigint, Avatar>();
		for (const batch of batches) {
			if (batch === undefined) return undefined;
			for (const a of batch) {
				byID.set(a.avatarID, {
					avatarID: a.avatarID,
					owner: a.owner,
					inGame: a.inGame,
					position: bigIntIDToXY(a.position),
					lastEpoch: Number(a.lastEpoch),
					life: Number(a.life),
				});
			}
		}

		return {avatars: byID, epoch: expectedEpoch};
	};
}
