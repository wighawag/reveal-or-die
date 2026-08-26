import {defineConfig, type Plugin, type ResolvedConfig} from 'vitest/config';
import {playwright} from '@vitest/browser-playwright';
import tailwindcss from '@tailwindcss/vite';
import {execSync} from 'node:child_process';
import devtoolsJson from 'vite-plugin-devtools-json';
import {sveltekit} from '@sveltejs/kit/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import {AssetPack, type AssetPackConfig} from '@assetpack/core';
import {pixiPipes} from '@assetpack/core/pixi';
import {readFileSync, writeFileSync, existsSync} from 'fs';
import {hookup} from 'named-logs-console';

hookup();

let FIRST_COMMIT: string | undefined;

try {
	FIRST_COMMIT = execSync('git rev-list --max-parents=0 HEAD', {
		stdio: ['ignore', 'pipe', 'ignore'],
	})
		.toString()
		.trim();
} catch (e) {
	console.error(e);
}

// ---------------------------------------------------------------------------
// Sprite pipeline. This is reveal-or-die's own: the template has no art build,
// so nothing upstream owns it. It turns ../assets into static/assets plus a
// manifest the pixi renderer loads as a bundle.
// ---------------------------------------------------------------------------
const assetsFolder = '../assets';
const manifestSrcPath = './src/lib/manifest.json';

function assetpackPlugin(): Plugin {
	const apConfig: AssetPackConfig = {
		entry: assetsFolder,
		logLevel: 'verbose',
		strict: true,
		pipes: [
			...pixiPipes({
				resolutions: {default: 1},
				compression: {png: true, jpg: true, webp: false},
				manifest: {
					output: manifestSrcPath,
					includeFileSizes: 'raw',
					includeMetaData: true,
					trimExtensions: true,
				},
			}),
		],
		assetSettings: [
			{
				files: ['**/sprites'],
				metaData: {
					tps: true,
				},
			},
		],
	};
	let mode: ResolvedConfig['command'];
	let ap: AssetPack | undefined;

	function fixManifest() {
		// works around https://github.com/pixijs/assetpack/issues/148 : the
		// manifest records paths relative to the output folder, but the app
		// loads them from the site root.
		const content = readFileSync(manifestSrcPath, 'utf-8');
		const jsonContent = JSON.parse(content);
		function transform(value: string | {src: string}): string | {src: string} {
			if (typeof value === 'string') {
				if (value.startsWith('/')) {
					return value;
				}
				return `/assets/${value}`;
			} else {
				if (value.src.startsWith('/')) {
					return value;
				}
				value.src = `/assets/${value.src}`;
				return value;
			}
		}
		for (const bundle of jsonContent.bundles) {
			for (const asset of bundle.assets) {
				asset.src = asset.src.map(transform);
			}
		}
		writeFileSync(manifestSrcPath, JSON.stringify(jsonContent, null, 2));
	}

	return {
		name: 'assetpack',
		configResolved: (resolvedConfig) => {
			mode = resolvedConfig.command;
		},
		buildStart: async () => {
			if (mode === 'serve') {
				if (ap) return;
				ap = new AssetPack(apConfig);
				void ap.watch(() => {
					fixManifest();
				});
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

const env = process.env;

export default defineConfig(({mode}) => {
	const plugins = [
		devtoolsJson(FIRST_COMMIT ? {uuid: FIRST_COMMIT} : undefined),
		tailwindcss(),
		sveltekit(),
	];

	if (existsSync(assetsFolder)) {
		plugins.push(assetpackPlugin());
	} else {
		// keep the import in src/ resolvable when the art folder is absent
		writeFileSync(
			manifestSrcPath,
			JSON.stringify({bundles: [{name: 'default', assets: []}]}),
		);
	}

	if (env.USE_LOCALHOST_SSL) {
		// not recommended, see https://v4.vitejs.dev/config/server-options.html#server-https
		plugins.push(
			basicSsl({
				name: 'test',
				domains: ['*.custom.com'],
				certDir: `${env.HOME}/.devServer/cert`,
			}),
		);
	}

	return {
		plugins,
		define: {
			// ethereumjs reaches for process.* inside the embedded-chain worker
			'process.env': '{}',
			process: '{}',
		},
		build: {
			emptyOutDir: true,
			minify: true, // shrink chunks so large files don't stall on slow /
			// throttled connections (an unminified single bundle hung under
			// Chrome's request-level throttling)
			sourcemap: true,
		},
		worker: {
			format: 'es',
		},
		ssr: {
			// DROP with the renderer port: pixi-viewport goes away with it
			noExternal: ['pixi-viewport'],
		},
		server: {
			host: '127.0.0.1',
			// Allow all hosts in dev mode so tunnels work instantly
			allowedHosts: mode === 'development' ? true : [],
		},
		test: {
			expect: {requireAssertions: true},
			projects: [
				{
					extends: './vite.config.ts',
					test: {
						name: 'client',
						browser: {
							enabled: true,
							provider: playwright(),
							instances: [{browser: 'chromium', headless: true}],
						},
						include: ['test/**/*.svelte.{test,spec}.{js,ts}'],
						exclude: ['test/lib/server/**'],
					},
				},

				{
					extends: './vite.config.ts',
					test: {
						name: 'server',
						environment: 'node',
						include: ['test/**/*.{test,spec}.{js,ts}'],
						exclude: ['test/**/*.svelte.{test,spec}.{js,ts}'],
					},
				},
			],
		},
	};
});
