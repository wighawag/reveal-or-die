import {describe, expect, it} from 'vitest';
import {createWorldReader, createZonesForCamera} from '$lib/world/state';
import {
	ZONE_OFFSET,
	ZONE_SIZE,
	zoneCoord,
	zoneIDFromZoneCoords,
} from 'reveal-or-die-contracts';

/**
 * The zone id, transcribed straight from `PositionUtils.getZone`, as an
 * independent check on the helper the app actually calls.
 *
 * Solidity packs `(uint32(zoneY) << 32) + uint32(zoneX)`, and casting a
 * negative int32 is two's complement. That is the whole subtlety: a signed
 * packing agrees for every positive coordinate and disagrees for every negative
 * one, so the half of the board a hand-written test is least likely to cover is
 * exactly the half that breaks.
 */
function expectedZoneID(zoneX: number, zoneY: number): bigint {
	const asUint32 = (v: number) => BigInt.asUintN(32, BigInt(v));
	return (asUint32(zoneY) << 32n) + asUint32(zoneX);
}

/** The world rectangle a zone covers, from ZONE_SIZE and ZONE_OFFSET. */
function boundsOfZone(zoneX: number, zoneY: number) {
	return {
		left: zoneX * ZONE_SIZE - ZONE_OFFSET,
		right: zoneX * ZONE_SIZE - ZONE_OFFSET + ZONE_SIZE - 1,
		top: zoneY * ZONE_SIZE - ZONE_OFFSET,
		bottom: zoneY * ZONE_SIZE - ZONE_OFFSET + ZONE_SIZE - 1,
	};
}

describe('zoneIDFromZoneCoords', () => {
	it('matches the contract packing across both signs', () => {
		for (let zy = -4; zy <= 4; zy++) {
			for (let zx = -4; zx <= 4; zx++) {
				expect(zoneIDFromZoneCoords(zx, zy)).toEqual(expectedZoneID(zx, zy));
			}
		}
	});

	it('does not produce a negative id west or north of the origin', () => {
		// the mistake this guards: `(BigInt(zoneY) << 32n) + BigInt(zoneX)`
		expect(zoneIDFromZoneCoords(-1, 0)).toEqual(0xffffffffn);
		expect(zoneIDFromZoneCoords(0, -1) > 0n).toBe(true);
	});
});

/**
 * The camera-to-zones rule, with no travel allowance, which is the shape every
 * test below was written against. What the reach ADDS has its own block.
 */
const zonesForCamera = createZonesForCamera({reach: 0});

describe('zonesForCamera', () => {
	it('covers every zone the camera can see', () => {
		const camera = {x: 0, y: 0, width: 40, height: 40};
		const zones = new Set(zonesForCamera(camera));

		// Every corner of the visible rectangle must be in a zone that was asked
		// for, or avatars go missing at the edge.
		const half = {w: camera.width / 2, h: camera.height / 2};
		for (const x of [camera.x - half.w, camera.x + half.w]) {
			for (const y of [camera.y - half.h, camera.y + half.h]) {
				const id = zoneIDFromZoneCoords(zoneCoord(x), zoneCoord(y));
				expect(zones.has(id)).toBe(true);
			}
		}
	});

	it('includes the origin zone when the camera is on the origin', () => {
		const zones = zonesForCamera({x: 0, y: 0, width: 4, height: 4});
		expect(zones).toContain(zoneIDFromZoneCoords(0, 0));
	});

	it('works west and north of the origin, where the ids wrap', () => {
		const zones = zonesForCamera({x: -40, y: -40, width: 4, height: 4});
		expect(zones).toContain(
			zoneIDFromZoneCoords(zoneCoord(-40), zoneCoord(-40)),
		);
		// and none of them came out negative
		for (const z of zones) expect(z >= 0n).toBe(true);
	});

	it('returns no duplicates', () => {
		const zones = zonesForCamera({x: 3, y: -7, width: 60, height: 60});
		expect(new Set(zones).size).toEqual(zones.length);
	});

	it('caps how many zones one fetch may cover', () => {
		// zoomed far out: the count grows with the SQUARE of the extent, so
		// without a cap this asks for thousands and the read stops answering.
		const zones = zonesForCamera({x: 0, y: 0, width: 5000, height: 5000});
		expect(zones.length).toBeLessThanOrEqual(64);
	});

	it('agrees with the zone bounds it is derived from', () => {
		// a camera entirely inside one zone must ask for exactly that zone
		const b = boundsOfZone(2, -3);
		const camera = {
			x: (b.left + b.right) / 2,
			y: (b.top + b.bottom) / 2,
			width: 1,
			height: 1,
		};
		expect(zonesForCamera(camera)).toEqual([zoneIDFromZoneCoords(2, -3)]);
	});
});

describe('the travel allowance on top of the camera', () => {
	/**
	 * Zones are what BOTH reads are scoped by: the avatars standing in them, and
	 * the `CommitmentRevealed` logs, which are filed under the zone an avatar
	 * ENDED its turn in. So a turn that crosses a boundary is only found when
	 * the destination zone is loaded, and an avatar that walks into view is only
	 * animated if the zone it walked from was loaded too.
	 *
	 * The proportional margin already covers this when zoomed out, and does not
	 * when zoomed in, which is where the reach earns its place: at four cells
	 * visible it is worth a fifth of a cell.
	 */
	it('loads a turn\u2019s travel beyond the camera when zoomed right in', () => {
		const camera = {x: 0, y: 0, width: 2, height: 2};
		const tight = new Set(createZonesForCamera({reach: 0})(camera));
		const roomy = new Set(createZonesForCamera({reach: 16})(camera));

		// (0,0) is in zone (0,0); sixteen cells west is the zone before it, which
		// only the second one asks for.
		const westward = zoneIDFromZoneCoords(zoneCoord(-16), zoneCoord(0));
		expect(tight.has(westward)).toBe(false);
		expect(roomy.has(westward)).toBe(true);
	});

	it('never asks for less than the camera alone would', () => {
		const camera = {x: 3, y: -7, width: 60, height: 60};
		const tight = createZonesForCamera({reach: 0})(camera);
		const roomy = new Set(createZonesForCamera({reach: 4})(camera));
		for (const zone of tight) expect(roomy.has(zone)).toBe(true);
	});

	it('still caps what one fetch may cover', () => {
		// The reach widens the box, so the cap has to hold against it too: a
		// zoomed-out camera plus a travel allowance is still a bounded read.
		const zones = createZonesForCamera({reach: 100})({
			x: 0,
			y: 0,
			width: 5000,
			height: 5000,
		});
		expect(zones.length).toBeLessThanOrEqual(64);
	});
});

/**
 * The reveal-log half of the reader.
 *
 * Storage says where an avatar IS; only `CommitmentRevealed` says how it got
 * there, and only that says which parts of a turn the contract accepted (it
 * emits `actions[0:numActionsResolved]`, and a refused action increments
 * nothing). Both are needed to draw a board that moves, so both are read here,
 * and the interesting behaviour is what happens when the second one fails.
 */
function fakeClient(options: {
	avatars?: {
		owner: `0x${string}`;
		avatarID: bigint;
		inGame: boolean;
		position: bigint;
		lastEpoch: bigint;
		life: number;
	}[];
	events?: {
		args: {
			avatarID: bigint;
			epoch: bigint;
			actions: {actionType: number; data: bigint}[];
		};
	}[];
	eventsFail?: boolean;
	epoch?: bigint;
}) {
	const calls: {
		logRanges: {from: bigint; to: bigint}[];
		readBlocks: (bigint | undefined)[];
	} = {logRanges: [], readBlocks: []};
	const client = {
		readContract: async (request: {blockNumber?: bigint}) => {
			calls.readBlocks.push(request.blockNumber);
			return [options.avatars ?? [], false, options.epoch ?? 7n];
		},
		getContractEvents: async (args: {fromBlock: bigint; toBlock: bigint}) => {
			calls.logRanges.push({from: args.fromBlock, to: args.toBlock});
			if (options.eventsFail) throw new Error('this RPC does not do logs');
			return options.events ?? [];
		},
	};
	return {client, calls};
}

const deployments = {
	contracts: {
		Game: {address: '0x00000000000000000000000000000000000000aa', abi: []},
	},
} as never;

const someAvatar = {
	owner: '0x1111111111111111111111111111111111111111' as const,
	avatarID: 5n,
	inGame: true,
	position: 0n,
	lastEpoch: 6n,
	life: 1,
};

describe('reading what the chain resolved, not just where things stand', () => {
	it('hands each avatar the turn the chain says it took', async () => {
		const {client} = fakeClient({
			avatars: [someAvatar],
			events: [
				{
					args: {
						avatarID: 5n,
						epoch: 7n,
						actions: [{actionType: 1, data: 1n}],
					},
				},
			],
		});
		const read = createWorldReader({
			publicClient: client as never,
			deployments,
		});
		const state = await read({
			zones: [0n],
			fromBlock: 0,
			toBlock: 10,
			expectedEpoch: 7,
		});
		expect(state?.avatars.get(5n)?.lastTurn).toEqual({
			epoch: 7,
			actions: [{actionType: 1, data: 1n}],
		});
	});

	it('keeps the LATEST turn when two epochs were asked for', async () => {
		// Two epochs are fetched so a client arriving after a boundary still has
		// the turn that produced the board. The older one is history.
		const {client} = fakeClient({
			avatars: [someAvatar],
			events: [
				{args: {avatarID: 5n, epoch: 6n, actions: [{actionType: 1, data: 9n}]}},
				{args: {avatarID: 5n, epoch: 7n, actions: [{actionType: 1, data: 1n}]}},
			],
		});
		const read = createWorldReader({
			publicClient: client as never,
			deployments,
		});
		const state = await read({
			zones: [0n],
			fromBlock: 0,
			toBlock: 10,
			expectedEpoch: 7,
		});
		expect(state?.avatars.get(5n)?.lastTurn?.epoch).toEqual(7);
	});

	it('still reports the board when the logs cannot be read', async () => {
		// THE IMPORTANT ONE. A throw here would reach the polling store as a
		// failed read: exponential backoff behind an RPC-health banner, and a
		// blank board until the player happens to pan. Losing the animation is a
		// far smaller thing than losing the world.
		const {client} = fakeClient({avatars: [someAvatar], eventsFail: true});
		const read = createWorldReader({
			publicClient: client as never,
			deployments,
		});
		const state = await read({
			zones: [0n],
			fromBlock: 0,
			toBlock: 10,
			expectedEpoch: 7,
		});
		expect(state?.avatars.get(5n)?.position).toEqual({x: 0, y: 0});
		expect(state?.avatars.get(5n)?.lastTurn).toBeUndefined();
	});

	it('cuts the block range into pieces a provider will answer', async () => {
		// `eth_getLogs` ranges are capped, and providers disagree about where. A
		// single request over the whole range works against a local node and
		// fails against whichever public RPC a player happens to be on.
		const {client, calls} = fakeClient({avatars: [someAvatar]});
		const read = createWorldReader({
			publicClient: client as never,
			deployments,
		});
		await read({zones: [0n], fromBlock: 0, toBlock: 2500, expectedEpoch: 7});
		expect(calls.logRanges.length).toBeGreaterThan(1);
		for (const range of calls.logRanges) {
			expect(Number(range.to - range.from)).toBeLessThan(1000);
		}
		// and together they cover it exactly, with no gap to lose a reveal in
		expect(calls.logRanges[0].from).toEqual(0n);
		expect(calls.logRanges.at(-1)?.to).toEqual(2500n);
	});

	it('reads the entities from the SAME block the logs stop at', async () => {
		// THE PAIR MUST NOT SPLIT. The entity read and the log read are separate
		// RPC calls against a moving chain, and a reveal mined between them
		// leaves storage saying the avatar has moved while its turn is still
		// outside the log range. The position then lands one poll ahead of the
		// turn: the avatar jumps, and the turn that follows replays BACKWARDS
		// from where it already stands. Pinning both to `toBlock` makes the pair
		// move together - both see the reveal, or neither does.
		const {client, calls} = fakeClient({avatars: [someAvatar]});
		const read = createWorldReader({
			publicClient: client as never,
			deployments,
		});
		await read({zones: [0n], fromBlock: 0, toBlock: 42, expectedEpoch: 7});
		expect(calls.readBlocks.length).toBeGreaterThan(0);
		for (const block of calls.readBlocks) {
			expect(block).toEqual(42n);
		}
	});

	it('accepts a read from BEHIND the clock, whatever epoch the chain reports', async () => {
		// THE FALSE OUTAGE, FIXED. The client's clock crosses the epoch boundary
		// ahead of the chain, and refusing the read for that turned a two-clock
		// disagreement of seconds into a failed one: catchup budget expiring into
		// backoff, an UNHEALTHY line, the RPC banner over a board that was merely
		// a moment behind.
		const {client} = fakeClient({avatars: [someAvatar], epoch: 6n});
		const read = createWorldReader({
			publicClient: client as never,
			deployments,
		});
		const state = await read({
			zones: [0n],
			fromBlock: 0,
			toBlock: 10,
			expectedEpoch: 7,
		});
		expect(state?.avatars.get(5n)).toBeTruthy();
		// STAMPED WITH THE EPOCH THE FETCH WAS FOR, not the chain's answer: the
		// chain's counter only advances when a block is mined, and nothing the
		// board reads can change before one is (a reveal mined after the boundary
		// is refused with InCommitmentPhase, and commits move no avatar) - so a
		// fetch that lands after the clock ticks already holds the new round's
		// data, and the request is the honest answer to "is the board caught up".
		// Stamping the chain's epoch made the catch-up last until the next
		// TRANSACTION, some twenty seconds on a quiet node, while the data sat
		// there the whole time.
		expect(state?.epoch).toEqual(7);
	});

	it('accepts a read from AHEAD of the clock, whatever epoch the chain reports', async () => {
		// The other direction of the same disagreement, and the other half of why
		// an exact match was wrong: a chain a block ahead of the client's clock is
		// fresher data, not a failed read.
		const {client} = fakeClient({avatars: [someAvatar], epoch: 8n});
		const read = createWorldReader({
			publicClient: client as never,
			deployments,
		});
		const state = await read({
			zones: [0n],
			fromBlock: 0,
			toBlock: 10,
			expectedEpoch: 7,
		});
		expect(state?.epoch).toEqual(7);
	});

	it('refuses to stitch pages whose epochs disagree', async () => {
		// The ONE refusal that is left, and the reason it exists: pages are
		// pinned to one block, so disagreeing epochs mean a reorg replaced it
		// mid-read, and the halves describe different worlds. (The old check
		// conflated this with comparing against the clock.)
		let page = 0;
		const client = {
			readContract: async () => {
				page++;
				// `more` true on the first page so the read keeps paging and sees
				// the disagreement.
				return [
					page === 1 ? [someAvatar] : [],
					page === 1,
					page === 1 ? 6n : 7n,
				];
			},
			getContractEvents: async () => [],
		};
		const read = createWorldReader({
			publicClient: client as never,
			deployments,
		});
		const state = await read({
			zones: [0n],
			fromBlock: 0,
			toBlock: 10,
			expectedEpoch: 7,
		});
		expect(state).toBeUndefined();
	});

	it('asks for nothing at all when the camera has no zones', async () => {
		const {client, calls} = fakeClient({});
		const read = createWorldReader({
			publicClient: client as never,
			deployments,
		});
		await read({zones: [], fromBlock: 0, toBlock: 10, expectedEpoch: 7});
		expect(calls.logRanges).toEqual([]);
	});
});
