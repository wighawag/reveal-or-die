export type AreaAsBigInts = {
	firstBytes32: bigint;
	secondBytes32: bigint;
	size: bigint;
};
export type AreaAsEnums = {
	cells: number[];
	size: number;
};
export function parseAsciiArea(txt: string): {
	areaAsBigInts: AreaAsBigInts;
	areaAsEnums: AreaAsEnums;
} {
	const lines = txt.split(`\n`).filter((v) => v.length > 0);
	const numLines = lines.length;
	let lineIndex = 0;
	let sizeN = numLines;

	if (sizeN != 16) {
		throw new Error(`invalid number of lines, need to be equal to 16`);
	}
	const size = BigInt(sizeN);
	const cells = new Array<number>(Number(size * size));
	let y = 0n;
	let firstBytes32 = 0n;
	let secondBytes32 = 0n;
	while (lineIndex < numLines) {
		const line = lines[lineIndex];
		const numCharacters = line.length;
		const numCells = numCharacters / 2;
		if (numCells != sizeN) {
			throw new Error(
				`invalid number of characters in the line ${lineIndex + 1}: ${numCells}`,
			);
		}
		let charIndex = 0;
		let x = 0n;
		while (charIndex < numCharacters) {
			const index = y * size + x;
			const perBytes32 = (size * size) / 2n;
			const lowerBytes = index < perBytes32;

			const bitIndex = lowerBytes
				? (perBytes32 - index - 1n) * 2n
				: (perBytes32 * 2n - index - 1n) * 2n;

			console.log(bitIndex, perBytes32, index);

			let bytes = lowerBytes ? firstBytes32 : secondBytes32;

			const char = line.charAt(charIndex);
			if (char == '#') {
				bytes += 2n ** bitIndex;
				cells[Number(index)] = 1;
			} else if (char == 'x') {
				bytes += 2n ** (bitIndex + 1n);
				cells[Number(index)] = 2;
			} else if (char == '!') {
				bytes += 2n ** bitIndex + 2n ** (bitIndex + 1n);
				cells[Number(index)] = 3;
			} else {
				cells[Number(index)] = 0;
			}
			charIndex += 2;

			if (lowerBytes) {
				firstBytes32 = bytes;
			} else {
				secondBytes32 = bytes;
			}
			x++;
		}
		y++;
		lineIndex++;
	}

	return {
		areaAsBigInts: {firstBytes32, secondBytes32, size},
		areaAsEnums: {cells, size: Number(size)},
	};
}
