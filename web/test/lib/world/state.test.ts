import {describe, expect, it} from 'vitest';
import {zonesForCamera} from '$lib/world/state';
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
		expect(zones).toContain(zoneIDFromZoneCoords(zoneCoord(-40), zoneCoord(-40)));
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
