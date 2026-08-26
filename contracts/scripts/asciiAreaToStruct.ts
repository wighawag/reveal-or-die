import {parseAsciiArea} from '../data/parseAsciiArea.js';
import Handlebars from 'handlebars';
import fs from 'node:fs';
import path from 'node:path';

type AreaAsBigIntStrings = {
	firstBytes32: string;
	secondBytes32: string;
	size: number;
};
type AreaAsEnumArrays = {
	cells: number[];
	size: number;
};
export type AreaData = {
	ascii: string;
	areaAsBigInts: AreaAsBigIntStrings;
	areaAsEnumArrays: AreaAsEnumArrays;
};

function wallsToString(walls: bigint, size: bigint): string {
	const pad = size * size;
	return (walls >> (128n - pad))
		.toString(2)
		.padStart(Number(pad), '0')
		.match(/(.{1,11})/g)
		?.join(`\n`) as string;
}

function fileToData(filename: string): AreaData {
	const areaTXT = fs.readFileSync(filename, 'utf-8');
	const {areaAsBigInts, areaAsEnums} = parseAsciiArea(areaTXT);

	// console.log(wallsToString(southWalls, size));
	// console.log(`------------------`);
	// console.log(wallsToString(eastWalls, size));
	return {
		areaAsBigInts: {
			// firstBytes32: `0b${areaAsBigInts.firstBytes32.toString(2).padStart(256, '0')}`,
			// secondBytes32: `0b${areaAsBigInts.secondBytes32.toString(2).padStart(256, '0')}`,
			firstBytes32: `0x${areaAsBigInts.firstBytes32.toString(16).padStart(64, '0')}`,
			secondBytes32: `0x${areaAsBigInts.secondBytes32.toString(16).padStart(64, '0')}`,
			size: Number(areaAsBigInts.size),
		},
		areaAsEnumArrays: areaAsEnums,
		ascii: areaTXT,
	};
}

function main(args: string[]) {
	const folder = args[0];
	const files = fs.readdirSync(folder);
	const areasAsBigIntStrings: (AreaAsBigIntStrings & {ascii: string})[] = [];
	const areaAsEnumArrays: (AreaAsEnumArrays & {ascii: string})[] = [];
	for (const file of files) {
		console.log(`paring ${file}...`);
		const data = fileToData(path.join(folder, file));
		areasAsBigIntStrings.push({...data.areaAsBigInts, ascii: data.ascii});
		areaAsEnumArrays.push({...data.areaAsEnumArrays, ascii: data.ascii});
	}

	const templateTXT = fs.readFileSync('./data/Areas.sol.hbs', 'utf-8');
	const template = Handlebars.compile(templateTXT);
	const fileContent = template({areas: areasAsBigIntStrings});
	try {
		fs.mkdirSync('./src/game/data/generated/', {recursive: true});
	} catch {}
	fs.writeFileSync(`./src/game/data/generated/Areas.sol`, fileContent);

	const TStemplateTXT = fs.readFileSync('./data/Areas.ts.hbs', 'utf-8');
	const TStemplate = Handlebars.compile(TStemplateTXT);
	const TSfileContent = TStemplate({areas: areaAsEnumArrays});
	try {
		fs.mkdirSync('./js/generated', {recursive: true});
	} catch {}
	fs.writeFileSync(`./js/generated/Areas.ts`, TSfileContent);
}

main(process.argv.slice(2));
