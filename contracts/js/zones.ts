import {encodePacked, keccak256} from 'viem';
import {Areas} from './generated/Areas.js';

export const ZONE_SIZE = 16;
export const ZONE_OFFSET = 8;

export function zoneCoord(a: number): number {
	if (a >= 0) {
		return Math.floor((a + ZONE_OFFSET) / ZONE_SIZE);
	} else {
		// For negative numbers, we want the next higher (less negative) integer
		// when we're exactly on a boundary like -24, -8, etc.
		return -Math.ceil((-a - ZONE_OFFSET) / ZONE_SIZE);
	}
}

/**
 * The id the contract uses for the zone containing world `(x, y)`.
 *
 * Must match `PositionUtils.getZone` exactly, including how it treats negative
 * coordinates: Solidity packs `(uint32(zoneY) << 32) + uint32(zoneX)`, and the
 * cast of a negative `int32` is two's complement, so zone -1 is 0xFFFFFFFF and
 * not a negative number. `BigInt.asUintN(32, ...)` is that cast.
 *
 * Getting this wrong is invisible around the origin, where every coordinate is
 * positive, and only shows up as an empty board once a player walks west or
 * north of it.
 */
export function zoneID(x: number, y: number): bigint {
	return zoneIDFromZoneCoords(zoneCoord(x), zoneCoord(y));
}

/** The same, when the zone coordinates are already known. */
export function zoneIDFromZoneCoords(zoneX: number, zoneY: number): bigint {
	const zx = BigInt.asUintN(32, BigInt(zoneX));
	const zy = BigInt.asUintN(32, BigInt(zoneY));
	return (zy << 32n) + zx;
}

export function zoneLocalCoord(x: number): number {
	const zone_coord = zoneCoord(x);
	if (zone_coord >= 0) {
		return x - (zone_coord * ZONE_SIZE - ZONE_OFFSET);
	} else {
		return x - (zone_coord * ZONE_SIZE - ZONE_OFFSET);
	}
}

export function wallAt(
	walls: readonly boolean[],
	x: number,
	y: number,
): boolean {
	const xx = zoneLocalCoord(x);
	const yy = zoneLocalCoord(y);
	const i = yy * ZONE_SIZE + xx;
	const wall = walls[i];
	if (wall == undefined) {
		return false;
	}
	return wall;
	// return ((walls >> (127n - i)) & 1n) == 1n;
}

const areaCache: Map<string, {cells: readonly number[]; size: number}> =
	new Map();
export function areaAt(x: number, y: number) {
	// TODO add in genesis hash ?
	const areaX = zoneCoord(x);
	const areaY = zoneCoord(y);

	const key = `${areaX},${areaY}`;
	const fromCache = areaCache.get(key);

	if (fromCache) {
		return fromCache;
	}

	// TODO use evm execution diretly ?
	const areaHash = BigInt(
		keccak256(encodePacked(['int32', 'int32'], [areaX, areaY])),
	);
	const area = Areas[Number(areaHash % BigInt(Areas.length))];
	areaCache.set(key, area);
	return area;
}
