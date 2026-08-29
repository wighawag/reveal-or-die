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

/**
 * Whether world `(x, y)` cannot be stood on.
 *
 * Mirrors `GameUtils.obstacleAt`: the area is looked up from the zone hash, the
 * coordinates are made zone-local, and cell types 1 (`#`) and 2 (`x`) are
 * obstacles while 0 and 3 are not.
 *
 * Worth having on the client rather than only in Solidity. `_isValidMove`
 * refuses a move onto an obstacle and `_move` then sets `stopProcessing`, which
 * DROPS every remaining action in the same reveal. So a single unwalkable step
 * planned by mistake silently discards the rest of the turn, and the player is
 * told nothing. Checking here is what stops that being plannable at all.
 */
export function isObstacle(x: number, y: number): boolean {
	const cell = cellTypeAt(x, y);
	return cell === CellType.Wall || cell === CellType.Box;
}

/**
 * What the generated areas put at world `(x, y)`.
 *
 * The numbers are the ones `scripts/asciiAreaToStruct.ts` emits and
 * `GameUtils.obstacleAt` reads, so they are the map format rather than a
 * rendering choice: `#` and `x` are the two the contract refuses to stand on.
 */
export const CellType = {
	Floor: 0,
	/** `#` in the ascii source. */
	Wall: 1,
	/** `x` in the ascii source. */
	Box: 2,
	/** `!` in the ascii source. The way out. */
	Exit: 3,
} as const;

export type CellTypeValue = (typeof CellType)[keyof typeof CellType];

/**
 * The raw cell, for anything that has to DRAW the world rather than judge it.
 *
 * Split out of `isObstacle` rather than duplicated beside it, and that is the
 * point: the renderer and the move rules now read the same lookup, so a map the
 * player can see is a map the contract agrees with. Drawing from a second copy
 * is how you get a wall you can walk through, or worse, an invisible one you
 * cannot.
 */
export function cellTypeAt(x: number, y: number): number {
	const area = areaAt(x, y);
	const xx = zoneLocalCoord(x);
	const yy = zoneLocalCoord(y);
	return area.cells[yy * ZONE_SIZE + xx] ?? CellType.Floor;
}

/** Orthogonally adjacent and walkable, which is what `_isValidMove` allows. */
export function isValidMove(
	from: {x: number; y: number},
	to: {x: number; y: number},
): boolean {
	if (isObstacle(to.x, to.y)) return false;
	const dx = Math.abs(from.x - to.x);
	const dy = Math.abs(from.y - to.y);
	return dx + dy === 1;
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
