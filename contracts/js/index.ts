export * from './positions.js';

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
