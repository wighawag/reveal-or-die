/**
 * The sprite pipeline: `../assets` into `static/assets`, plus a manifest.
 *
 * THIS GAME'S, and in its own file for that reason. `vite.config.ts` is the
 * template's, merged down from `template-commit-reveal`, and this was ~300
 * lines of art build sitting in the middle of it: every upstream change to the
 * vite config had to be merged around a block that has nothing to do with vite
 * config in general. Here it is a file upstream does not have, so it can never
 * conflict, and `vite.config.ts` is back to a three-line reference to it.
 *
 * The template has no art build at all, deliberately: a commit-reveal app need
 * not be a game with art. So there is nothing upstream to converge with, which
 * is exactly what makes a separate file the right shape rather than a patch.
 */
import type {Plugin, ResolvedConfig} from 'vite';
import {AssetPack, type AssetPackConfig} from '@assetpack/core';
import {pixiPipes} from '@assetpack/core/pixi';
import {readFileSync, writeFileSync} from 'fs';

/** Where the authored art lives, outside `web/` so it is not served raw. */
export const ASSETS_FOLDER = '../assets';

/**
 * Where the built sprites go: `static/`, because that is what SvelteKit serves,
 * and at `/assets/` because that is the prefix `fixManifest` writes.
 *
 * NAMED EXPLICITLY, and it has to be. Assetpack's default output is `./dist`,
 * so leaving it out does not mean "no opinion", it means "somewhere the app
 * does not serve from". See the note in `fixManifest`.
 */
export const OUTPUT_FOLDER = './static/assets';

/**
 * The generated manifest, which is GITIGNORED.
 *
 * It lives under `src/` because the app imports it as a module
 * (`$lib/manifest.json`, read by `lib/world/render/assets.ts`) rather than
 * fetching it, so it has to be resolvable at build time.
 */
export const MANIFEST_PATH = './src/lib/manifest.json';

/**
 * A manifest with nothing in it.
 *
 * Written whenever the real one is absent, which is the normal state of a fresh
 * clone: the file is generated and gitignored, and `svelte-check` and `vitest`
 * both resolve the import without ever running the pipeline. Without this they
 * fail on a missing module, which reads as a broken checkout.
 */
export function writeEmptyManifest() {
	writeFileSync(
		MANIFEST_PATH,
		JSON.stringify({bundles: [{name: 'default', assets: []}]}, null, 2),
	);
}

/**
 * Rewrite the manifest's paths to the ones the browser will ask for.
 *
 * Works around https://github.com/pixijs/assetpack/issues/148: assetpack records
 * paths relative to its OUTPUT folder, and the app loads them from the site
 * root. So `sprites-X.png.json` has to become `/assets/sprites-X.png.json`.
 *
 * This prefix and `OUTPUT_FOLDER` are two halves of one decision and will break
 * silently if they drift, because nothing checks that a path in the manifest
 * resolves to a file that exists: the symptom is a 404 at runtime inside
 * `Assets.loadBundle`, on a URL nobody typed.
 */
function fixManifest() {
	const jsonContent = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));

	function transform(value: string | {src: string}): string | {src: string} {
		if (typeof value === 'string') {
			return value.startsWith('/') ? value : `/assets/${value}`;
		}
		if (!value.src.startsWith('/')) value.src = `/assets/${value.src}`;
		return value;
	}

	for (const bundle of jsonContent.bundles) {
		for (const asset of bundle.assets) {
			asset.src = asset.src.map(transform);
		}
	}
	writeFileSync(MANIFEST_PATH, JSON.stringify(jsonContent, null, 2));
}

export function assetpackPlugin(): Plugin {
	const apConfig: AssetPackConfig = {
		entry: ASSETS_FOLDER,
		output: OUTPUT_FOLDER,
		logLevel: 'verbose',
		strict: true,
		pipes: [
			...pixiPipes({
				resolutions: {default: 1},
				compression: {png: true, jpg: true, webp: false},
				manifest: {
					output: MANIFEST_PATH,
					includeFileSizes: 'raw',
					includeMetaData: true,
					trimExtensions: true,
				},
			}),
		],
		assetSettings: [
			{
				files: ['**/sprites'],
				metaData: {tps: true},
			},
		],
	};

	let mode: ResolvedConfig['command'];
	let ap: AssetPack | undefined;

	return {
		name: 'assetpack',
		configResolved: (resolvedConfig) => {
			mode = resolvedConfig.command;
		},
		buildStart: async () => {
			if (mode === 'serve') {
				if (ap) return;
				ap = new AssetPack(apConfig);
				void ap.watch(() => fixManifest());
			} else {
				await new AssetPack(apConfig).run();
				fixManifest();
			}
		},
		buildEnd: async () => {
			if (ap) {
				await ap.stop();
				ap = undefined;
			}
		},
	};
}
