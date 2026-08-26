/**
 * Cell and zone maths, mirroring `contracts/src/utils/PositionUtils.sol`.
 *
 * This is the template GAME's code, not the framework's: a descendant deletes
 * `$lib/placement` wholesale and writes its own world. What it must keep is the
 * property this file exists to guarantee - that the client and the contract
 * agree on which zone a cell belongs to. They are two implementations of one
 * definition, so any change here is a change there.
 *
 * A disagreement is silent and nasty: the poller asks for zone A, the contract
 * files the cell under zone B, and the board renders empty while every call
 * succeeds. That is why the edges (zone 0 spans -8..7, not 0..15) are pinned by
 * tests rather than trusted.
 */

/** Cells per zone side. `PositionUtils.ZONE_SIZE`. */
export const ZONE_SIZE = 16;

/**
 * Zones straddle the origin rather than starting at it: zone 0 covers -8..7 on
 * both axes, so the origin sits in the middle of a zone instead of at the
 * corner of four. `PositionUtils.ZONE_OFFSET`.
 */
export const ZONE_OFFSET = 8;

export type Position = {x: number; y: number};

const u32 = (v: number): bigint => BigInt.asUintN(32, BigInt(v));

/**
 * Pack a coordinate pair into the uint64 the contract uses as a cell id: y in
 * the high 32 bits, x in the low 32, both two's-complement int32.
 */
export function cellID(x: number, y: number): bigint {
	return (u32(y) << 32n) + u32(x);
}

/** The inverse of {@link cellID}. */
export function positionOf(id: bigint): Position {
	return {
		x: Number(BigInt.asIntN(32, id & 0xffffffffn)),
		y: Number(BigInt.asIntN(32, BigInt.asUintN(32, id >> 32n))),
	};
}

/**
 * One axis of the zone a coordinate falls in.
 *
 * The two branches are not symmetric, and copying the positive one for both
 * would be wrong: Solidity's integer division truncates TOWARDS ZERO, so the
 * contract computes the negative side by negating a ceiling division instead.
 * This reproduces that, rather than reproducing what the maths "should" be.
 */
export function zoneCoord(a: number): number {
	if (a >= 0) {
		return Math.floor((a + ZONE_OFFSET) / ZONE_SIZE);
	}
	const negPart = Math.floor((-a + ZONE_OFFSET - 1) / ZONE_SIZE);
	// `-negPart` would be -0 for the negative half of zone 0 (-8..-1). Harmless
	// in arithmetic, but -0 survives into anything that compares identities
	// (Object.is, a keyed cache, a snapshot), where it is a different value from
	// the 0 the positive half produces for the same zone.
	return negPart === 0 ? 0 : -negPart;
}

/** The zone id for a coordinate pair, packed like a cell id. */
export function zoneID(x: number, y: number): bigint {
	return cellID(zoneCoord(x), zoneCoord(y));
}

/** The zone a cell belongs to. `PositionUtils.getZone`. */
export function zoneOfCell(id: bigint): bigint {
	const {x, y} = positionOf(id);
	return zoneID(x, y);
}

/**
 * Every zone touching an axis-aligned rectangle of cells, inclusive of both
 * ends. Ordered so that the same rectangle always yields the same list, which
 * is what lets the poller treat the zone set as a cache key.
 */
export function zonesInRect(rect: {
	left: number;
	top: number;
	right: number;
	bottom: number;
}): bigint[] {
	const zoneLeft = zoneCoord(Math.floor(rect.left));
	const zoneRight = zoneCoord(Math.ceil(rect.right));
	const zoneTop = zoneCoord(Math.floor(rect.top));
	const zoneBottom = zoneCoord(Math.ceil(rect.bottom));

	const zones: bigint[] = [];
	for (let zy = zoneTop; zy <= zoneBottom; zy++) {
		for (let zx = zoneLeft; zx <= zoneRight; zx++) {
			zones.push(cellID(zx, zy));
		}
	}
	return zones;
}
