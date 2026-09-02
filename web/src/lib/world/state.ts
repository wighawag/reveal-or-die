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
import type {Action} from './commit-reveal';

/**
 * A turn the chain has resolved, as `CommitmentRevealed` reports it.
 *
 * THE ACCEPTED PREFIX. `_reveal` emits `actions[0:numActionsResolved]`, and an
 * action the contract refuses sets `stopProcessing` without incrementing that
 * counter, so what arrives here is exactly what was carried out: three steps
 * revealed and two accepted is two actions. It is the only place the chain
 * says which parts of a turn happened - storage keeps the result, not the
 * route - and it is per AVATAR, so it answers for everybody on the board and
 * not only for the player.
 */
export type ResolvedTurn = {
	epoch: number;
	actions: readonly Action[];
};

/** An avatar as the world holds it. */
export type Avatar = {
	avatarID: bigint;
	owner: `0x${string}`;
	inGame: boolean;
	position: Position;
	lastEpoch: number;
	life: number;
	/** What its last resolved turn was, when a log for it was fetched. */
	lastTurn?: ResolvedTurn;
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

/**
 * Which zones to load for a camera, given how far an avatar can travel.
 *
 * TWO MARGINS, and the reason for the second one is movement. Zones are what
 * both reads are scoped by - the avatars standing in them, and the
 * `CommitmentRevealed` logs filed under them - and an avatar's log is filed
 * under the zone it ENDED its turn in. So a turn that crosses a zone boundary
 * is only found if the destination zone is fetched, and a turn that walks into
 * view is only animated if we were already loading the zone it came from.
 * Loading a turn's worth of travel beyond the camera is what makes both true,
 * and it matters most when zoomed IN, where the proportional margin below is
 * only a cell or two.
 *
 * A factory rather than a constant because the reach is `numMoves`, which is
 * the contract's, read from `linkedData` at construction like the rest of the
 * world config.
 */
export function createZonesForCamera(params: {
	/** Cells an avatar can cover in one turn: the contract's `MAX_MOVES`. */
	reach: number;
}): ZonesForCamera {
	const reach = Math.max(0, params.reach);
	return (camera) => {
		// The camera reports its CENTRE and its extent, so the visible rectangle is
		// half the extent either side. Getting this wrong is invisible in the middle
		// of the board and shows up only as missing avatars at the edges.
		const halfWidth =
			camera.width / 2 + Math.max((camera.width * CAMERA_MARGIN) / 2, reach);
		const halfHeight =
			camera.height / 2 + Math.max((camera.height * CAMERA_MARGIN) / 2, reach);

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
}

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

/**
 * How many blocks one `eth_getLogs` may span.
 *
 * Providers cap this and disagree about where: a thousand is the lowest cap in
 * common use, so the range is cut into pieces that size and fetched together.
 * The alternative is a read that works against a local node and fails against
 * whichever public RPC a player happens to be on.
 */
const MAX_BLOCK_RANGE = 1000;

/**
 * How many epochs of reveals to ask for.
 *
 * Two: the epoch in progress, whose reveals are landing right now and are what
 * the animation replays, and the one before it, so a client that arrives just
 * after an epoch boundary still has the turn that produced the board it is
 * looking at.
 */
const REVEAL_EPOCHS = 2;

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

	/**
	 * The turns the chain has resolved recently, per avatar.
	 *
	 * WHY THIS IS A SECOND READ. Storage keeps where an avatar IS; only
	 * `CommitmentRevealed` says how it got there, and only that says which parts
	 * of a turn the contract accepted. Both are needed to draw a board that
	 * MOVES: without the log the renderer can only teleport every avatar to its
	 * new cell on the tick after a reveal.
	 *
	 * Scoped exactly like the entity read - the same zones, because the event's
	 * `zone` topic is the zone the avatar ENDED in, which is where storage lists
	 * it too - and to the last couple of epochs. `fromBlock`/`toBlock` come from
	 * the framework, which is why the seam carries them (see `ZonesReader`).
	 *
	 * NEVER FATAL. A failure here loses the animation; throwing would lose the
	 * BOARD, because the polling store reads a throw as a failed read and starts
	 * backing off behind an RPC-health banner. So it is caught and the turn
	 * history is simply absent, which every consumer already treats as "nothing
	 * to replay".
	 */
	async function readResolvedTurns(params: {
		zones: readonly bigint[];
		epoch: number;
		fromBlock: number;
		toBlock: number;
	}): Promise<Map<bigint, ResolvedTurn>> {
		const byAvatar = new Map<bigint, ResolvedTurn>();
		const Game = deployments.contracts.Game;
		const epochs: bigint[] = [];
		for (let i = 0; i < REVEAL_EPOCHS; i++) {
			const epoch = params.epoch - i;
			if (epoch > 0) epochs.push(BigInt(epoch));
		}

		const ranges: {from: bigint; to: bigint}[] = [];
		for (
			let from = params.fromBlock;
			from <= params.toBlock;
			from += MAX_BLOCK_RANGE
		) {
			ranges.push({
				from: BigInt(from),
				to: BigInt(Math.min(from + MAX_BLOCK_RANGE - 1, params.toBlock)),
			});
		}

		try {
			const batches = await Promise.all(
				ranges.map((range) =>
					publicClient.getContractEvents({
						address: Game.address,
						abi: Game.abi,
						eventName: 'CommitmentRevealed',
						// Both are INDEXED, so this is a node-side topic filter rather
						// than a download of every reveal in the world.
						args: {epoch: epochs, zone: [...params.zones]},
						strict: true,
						fromBlock: range.from,
						toBlock: range.to,
					}),
				),
			);

			for (const event of batches.flat()) {
				const args = event.args as unknown as {
					avatarID: bigint;
					epoch: bigint;
					actions: readonly Action[];
				};
				const epoch = Number(args.epoch);
				const held = byAvatar.get(args.avatarID);
				// One avatar can only reveal once per epoch, so the only way to see
				// two is to have asked for two epochs. The later one is its last turn.
				if (held && held.epoch >= epoch) continue;
				byAvatar.set(args.avatarID, {epoch, actions: args.actions});
			}
		} catch (err) {
			console.warn(
				'[world] could not read the reveal logs, so this frame has no turn ' +
					'history to replay. The board itself is unaffected.',
				err,
			);
		}

		return byAvatar;
	}

	return async ({zones, expectedEpoch, fromBlock, toBlock}) => {
		if (zones.length === 0) return {avatars: new Map(), epoch: expectedEpoch};

		const Game = deployments.contracts.Game;

		async function readBatch(
			batch: bigint[],
			toBlock: number,
		): Promise<{avatars: PublicAvatar[]; epoch: number} | undefined> {
			const collected: PublicAvatar[] = [];
			/**
			 * The epoch of the first page, which every later page must agree with.
			 *
			 * THE ONLY REASON A READ IS REFUSED. All the pages are pinned to one
			 * block, so they normally cannot disagree; one that does means a reorg
			 * replaced the block mid-read, and stitching the halves would produce a
			 * world that never existed.
			 */
			let readEpoch: number | undefined;
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
					// PINNED TO THE SAME BLOCK THE LOGS STOP AT, and this is not an
					// optimisation. The two reads are separate RPC calls against a chain
					// that is moving, and a reveal landing between them splits the pair:
					// storage already says the avatar has moved while
					// `CommitmentRevealed` is still outside the log range. The position
					// then arrives one poll ahead of the turn, which draws as a jump
					// followed by a walk that runs BACKWARDS from the destination and
					// then forward again - observed on a second browser, which has
					// nothing but the poller to tell it a reveal happened. The same
					// block for both means the pair moves together: either both see
					// the reveal, or neither does, and the next poll carries both.
					blockNumber: BigInt(toBlock),
				})) as [readonly PublicAvatar[], boolean, bigint];

				const at = Number(epoch);
				if (readEpoch === undefined) readEpoch = at;
				else if (at !== readEpoch) return undefined;

				collected.push(...avatars);

				// `more` is true when the page exactly exhausted the list (the
				// contract tests `fromIndex + limit > total`, so an exact fit takes
				// the `else`). That costs one extra call returning nothing, which is
				// why the empty page rather than `more` is what ends the loop.
				if (!more || avatars.length === 0) {
					return {avatars: collected, epoch: readEpoch};
				}
				fromIndex += BigInt(avatars.length);
			}
			return {avatars: collected, epoch: readEpoch!};
		}

		// TOGETHER, because they describe the same moment and the reveal window is
		// short: reading them one after the other would leave the turn history a
		// round trip behind the board it belongs to.
		const [batches, turns] = await Promise.all([
			Promise.all(
				chunk(zones, ZONES_PER_CALL).map((batch) => readBatch(batch, toBlock)),
			),
			readResolvedTurns({zones, epoch: expectedEpoch, fromBlock, toBlock}),
		]);

		const byID = new Map<bigint, Avatar>();
		let chainEpoch: number | undefined;
		for (const batch of batches) {
			if (batch === undefined) return undefined;
			// Every batch reads the same pinned block, so they agree; a
			// disagreement is the same reorg case the pages guard against.
			if (chainEpoch === undefined) chainEpoch = batch.epoch;
			else if (batch.epoch !== chainEpoch) return undefined;
			for (const a of batch.avatars) {
				byID.set(a.avatarID, {
					avatarID: a.avatarID,
					owner: a.owner,
					inGame: a.inGame,
					position: bigIntIDToXY(a.position),
					lastEpoch: Number(a.lastEpoch),
					life: Number(a.life),
					lastTurn: turns.get(a.avatarID),
				});
			}
		}

		// STAMPED WITH THE EPOCH THE FETCH WAS FOR, not the one the chain's
		// latest block reports, and both halves of that are deliberate.
		//
		// THE READ IS ACCEPTED whatever the chain's epoch is: the client's clock
		// interpolates from the wall clock between blocks and crosses the epoch
		// boundary BEFORE the chain has mined a block past it, and refusing the
		// read for that turned a two-clock disagreement of seconds into a FAILED
		// one - the poller's catchup budget expiring into backoff, an UNHEALTHY
		// line, the RPC banner over a board that was never anything but a moment
		// behind. bomber-world's fetcher only refuses one direction and even
		// that as an error; `expectedEpoch` keeps the job it is fit for (the
		// SCOPE the framework refetches on) without being allowed to fail a
		// read over it.
		//
		// THE STAMP IS THE REQUEST because that is what "caught up" means for
		// the board. Stamping the CHAIN's epoch instead made the catch-up last
		// until a block past the boundary was mined - on a node that mines only
		// on transactions, that is the next commit, some twenty seconds in - and
		// it was a wait for a COUNTER while the DATA had already arrived: a
		// reveal mined after the boundary is refused with `InCommitmentPhase`
		// (the epoch it lands in is the new one, and it is a commit phase), and
		// commits move no avatar, so nothing the board reads can change between
		// the clock crossing and the chain crossing. Anything that does change
		// on-chain state is a transaction, which mines the block itself. So a
		// fetch that lands after the clock ticks already holds the new round's
		// data in full, and the epoch it was FOR is the honest answer to "is the
		// board caught up".
		return {avatars: byID, epoch: expectedEpoch};
	};
}
