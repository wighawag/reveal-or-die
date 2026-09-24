#!/usr/bin/env node
/**
 * RUN THIS THE MOMENT A MERGE IS RESOLVED, BEFORE ANYTHING EXPENSIVE.
 *
 *     node scripts/check-dangling-imports.mjs
 *
 * It is the hand path's half of `scripts/dangling-imports.mjs` - read that file
 * for why this exists and what it deliberately does not check. The short
 * version: a cascade into this repo has twice been broken by a hunk that merged
 * cleanly, so `git status` after the merge said nothing was wrong, and
 * `--verify` would have caught it one step later than the mistake. This runs
 * in about a second with no install and no compile, so it can be run inside a
 * conflicted merge.
 *
 * Exits non-zero with the list, so it can also be a git hook or a CI step.
 */
import {findDanglingImports} from './dangling-imports.mjs';

const dangling = findDanglingImports();

if (dangling.length === 0) {
	console.log('✓ every import names a path that exists');
	process.exit(0);
}

console.error(
	`✗ ${dangling.length} import${dangling.length === 1 ? '' : 's'} name a path this repo does not have:\n`,
);
for (const {file, specifier} of dangling) {
	console.error(`  ${file}\n      ${specifier}`);
}
console.error(
	`\nAfter a cascade this usually means one of two things, and they are the same\n` +
		`defect from opposite sides:\n\n` +
		`  - the merge DELETED something this repo still imports, or\n` +
		`  - a file ARRIVED importing something this repo deleted long ago\n` +
		`    (\`$lib/placement\` is the template's game; this one is \`$lib/world\`).\n\n` +
		`Neither shows up as a conflict, which is why this check exists.\n`,
);
process.exit(1);
