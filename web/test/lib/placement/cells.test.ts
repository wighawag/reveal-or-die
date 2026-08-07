import {describe, expect, it} from 'vitest';
import {
	cellID,
	positionOf,
	zoneCoord,
	zoneID,
	zoneOfCell,
	zonesInRect,
} from '$lib/placement/cells';

/**
 * `PositionUtils.zoneCoord`, transcribed line for line, with BigInt standing in
 * for Solidity's integers.
 *
 * The point of the transcription is the division: Solidity truncates TOWARDS
 * ZERO and BigInt division does the same, while `Math.floor` rounds towards
 * minus infinity. The two disagree exactly on the negative half of the board,
 * which is the half a hand-written test is least likely to cover. Checking the
 * real implementation against this over a range makes that class of mistake
 * impossible to miss.
 */
function solidityZoneCoord(a: number): number {
	const ZONE_SIZE = 16n;
	const ZONE_OFFSET = 8n;
	const av = BigInt(a);
	if (av >= 0n) {
		return Number((av + ZONE_OFFSET) / ZONE_SIZE);
	}
	const absA = -av;
	const negPart = (absA + ZONE_OFFSET - 1n) / ZONE_SIZE; // ceil division
	return Number(-negPart);
}

describe('cell ids', () => {
	it('round-trips positions, including negative coordinates', () => {
		const positions = [
			{x: 0, y: 0},
			{x: 3, y: 4},
			{x: 2, y: -3},
			{x: -1, y: -1},
			{x: 2147483647, y: -2147483648},
		];
		for (const position of positions) {
			expect(positionOf(cellID(position.x, position.y))).toEqual(position);
		}
	});

	it('packs y into the high 32 bits, like PositionUtils.fromXY', () => {
		// The contract test uses exactly this packing to address cells, so a
		// change here would desynchronise the client from every existing board.
		expect(cellID(3, 4)).toBe((4n << 32n) + 3n);
		expect(cellID(-1, 0)).toBe(0xffffffffn);
	});
});

describe('zones', () => {
	it('matches the contract implementation across the origin', () => {
		for (let a = -200; a <= 200; a++) {
			expect(zoneCoord(a), `zoneCoord(${a})`).toBe(solidityZoneCoord(a));
		}
	});

	it('puts the origin in the middle of zone 0, not at its corner', () => {
		// `contracts/test/Game.test.ts` asserts the same span from the other
		// side, by placing cells at (0,0) and (2,-3) and reading them back out
		// of zone 0.
		expect(zoneCoord(-8)).toBe(0);
		expect(zoneCoord(7)).toBe(0);
		expect(zoneCoord(-9)).toBe(-1);
		expect(zoneCoord(8)).toBe(1);
	});

	it('agrees with the contract about which zone a cell is in', () => {
		expect(zoneOfCell(cellID(0, 0))).toBe(0n);
		expect(zoneOfCell(cellID(2, -3))).toBe(0n);
		expect(zoneOfCell(cellID(-8, 7))).toBe(0n);
		expect(zoneOfCell(cellID(8, 0))).toBe(zoneID(8, 0));
		expect(zoneOfCell(cellID(8, 0))).toBe(cellID(1, 0));
		expect(zoneOfCell(cellID(-9, -9))).toBe(cellID(-1, -1));
	});
});

describe('zonesInRect', () => {
	it('covers a rectangle inside one zone with that one zone', () => {
		expect(zonesInRect({left: -2, top: -2, right: 2, bottom: 2})).toEqual([0n]);
	});

	it('covers every zone the rectangle touches', () => {
		// -9 falls in zone -1 and 8 in zone 1, so this spans 3x3 zones.
		const zones = zonesInRect({left: -9, top: -9, right: 8, bottom: 8});
		expect(zones).toHaveLength(9);
		expect(new Set(zones).size).toBe(9);
		for (const zy of [-1, 0, 1]) {
			for (const zx of [-1, 0, 1]) {
				expect(zones).toContain(cellID(zx, zy));
			}
		}
	});

	it('is stable, so the same rectangle is the same cache key', () => {
		const rect = {left: -20, top: -3, right: 20, bottom: 3};
		expect(zonesInRect(rect)).toEqual(zonesInRect(rect));
	});

	it('includes the zone of a fractional edge', () => {
		// Camera edges are fractional; rounding the wrong way drops the strip of
		// cells the player can actually see at the boundary.
		const zones = zonesInRect({left: 7.2, top: 0, right: 8.4, bottom: 0});
		expect(zones).toContain(cellID(0, 0));
		expect(zones).toContain(cellID(1, 0));
	});
});
