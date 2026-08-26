import type {Abi_IGame} from '../generated/abis/IGame.js';
import type {Abi, ExtractAbiEvent, ExtractAbiEventNames} from 'abitype';
import {Methods, type EIP1193ProviderWithoutEvents} from 'eip-1193';
import {createCurriedJSONRPC, CurriedRPC} from 'remote-procedure-call';
import {
	decodeFunctionResult,
	encodeEventTopics,
	encodeFunctionData,
	parseEventLogs,
} from 'viem';

export type Avatar = {
	avatarID: bigint;
	position: bigint;
};

export type AvatarAction = {actionType: number; data: bigint};

export type AvatarWithLastActions = Avatar & {
	lastActions?: readonly AvatarAction[];
};

export type Avatars = Map<bigint, AvatarWithLastActions>;

/**
 * Calculate the zones visible from the camera view plus neighboring zones
 */
export function calculateVisibleZones(camera: {
	x: number;
	y: number;
	width: number;
	height: number;
}): bigint[] {
	const ZONE_SIZE = 16;
	const ZONE_OFFSET = 8;

	// Function to convert a coordinate to its zone
	function zoneCoord(a: number): number {
		if (a >= 0) {
			return Math.floor((a + ZONE_OFFSET) / ZONE_SIZE);
		} else {
			return -Math.floor((-a + ZONE_OFFSET) / ZONE_SIZE);
		}
	}

	// Calculate the min/max coordinates of the camera view
	const minX = Math.floor(camera.x - camera.width / 2);
	const maxX = Math.ceil(camera.x + camera.width / 2);
	const minY = Math.floor(camera.y - camera.height / 2);
	const maxY = Math.ceil(camera.y + camera.height / 2);

	// Convert to zone coordinates with a buffer of 1 zone in each direction
	const minZoneX = zoneCoord(minX) - 1;
	const maxZoneX = zoneCoord(maxX) + 1;
	const minZoneY = zoneCoord(minY) - 1;
	const maxZoneY = zoneCoord(maxY) + 1;

	// Collect all zones in the visible area plus neighbors
	const result: bigint[] = [];

	for (let zoneY = minZoneY; zoneY <= maxZoneY; zoneY++) {
		for (let zoneX = minZoneX; zoneX <= maxZoneX; zoneX++) {
			// Convert to uint64 format as in the original code
			// (uint64(uint32(zoneY)) << 32) + uint64(uint32(zoneX))
			const zone = (BigInt(zoneY >>> 0) << 32n) + BigInt(zoneX >>> 0);
			result.push(zone);
		}
	}

	return result;
}

function getEventFromAbi<
	abi extends Abi,
	eventName extends ExtractAbiEventNames<abi>,
>(abi: abi, eventName: eventName): ExtractAbiEvent<abi, eventName> {
	for (const item of abi) {
		if (item.type === 'event' && item.name === eventName) {
			return item as ExtractAbiEvent<abi, eventName>;
		}
	}
	throw new Error('Event not found');
}

export async function getAvatarsFromContract(
	rpc: CurriedRPC<Methods>,
	Game: {abi: Abi_IGame; address: `0x${string}`},
	zones: bigint[],
	startIndex: bigint,
	limit: bigint,
) {
	const calldata = encodeFunctionData({
		abi: Game.abi,
		functionName: 'getAvatarsInMultipleZones',
		args: [zones, startIndex, limit],
	});
	const callResult = await rpc.call('eth_call')([
		{data: calldata, to: Game.address},
	]);
	if (!callResult.success) {
		throw new Error(callResult.error.message, {cause: callResult.error});
	}
	const result = decodeFunctionResult({
		abi: Game.abi,
		functionName: 'getAvatarsInMultipleZones',
		data: callResult.value,
	});
	return result;
}

export function createReader(
	provider: EIP1193ProviderWithoutEvents,
	Game: {abi: Abi_IGame; address: `0x${string}`},
	options?: {maxAvatarsPerRequest?: number},
) {
	const rpc = createCurriedJSONRPC<Methods>(provider);

	async function getAvatarsFromCamera(
		epoch: number,
		camera: {x: number; y: number; width: number; height: number},
	): Promise<Avatars> {
		const zones = calculateVisibleZones(camera);
		return getAvatars(epoch, zones);
	}

	async function getAvatars(epoch: number, zones: bigint[]): Promise<Avatars> {
		let startIndex = 0;
		const limit = options?.maxAvatarsPerRequest || 100; // TODO option ?
		let allAvatars: Avatar[] = [];
		let hasMore = true;
		while (hasMore) {
			const [avatars, more] = await getAvatarsFromContract(
				rpc,
				Game,
				zones,
				BigInt(startIndex),
				BigInt(limit),
			);
			allAvatars = [...allAvatars, ...avatars];
			hasMore = more;

			if (hasMore) {
				startIndex += limit;
			}
		}

		const event = getEventFromAbi(Game.abi, 'CommitmentRevealed');

		const topics = encodeEventTopics({
			abi: [event],
			eventName: 'CommitmentRevealed',
			args: {
				epoch: BigInt(epoch - 1),
				zone: zones,
			},
		});
		const logResult = await rpc.call('eth_getLogs')([
			{
				address: Game.address,
				topics: topics as any, // TODO fix eip-1193 ?
			},
		]);
		if (!logResult.success) {
			throw new Error(logResult.error.message, {cause: logResult.error});
		}

		const logs = parseEventLogs({
			abi: Game.abi,
			logs: logResult.value as any, // TODO fix eip-1193 ?
			eventName: 'CommitmentRevealed',
		});

		const avatarsMap: Avatars = new Map();
		for (const avatar of allAvatars) {
			avatarsMap.set(avatar.avatarID, avatar);
		}
		for (const log of logs) {
			const avatar = avatarsMap.get(log.args.avatarID);
			if (avatar) {
				avatar.lastActions = log.args.actions;
			} else {
				// TODO ?
			}
		}

		return avatarsMap;
	}

	return {getAvatars, getAvatarsFromCamera};
}
