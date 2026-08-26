import {defineConfig} from 'vitest/config';
import {playwright} from '@vitest/browser-playwright';
import tailwindcss from '@tailwindcss/vite';
import {execSync} from 'node:child_process';
import devtoolsJson from 'vite-plugin-devtools-json';
import {sveltekit} from '@sveltejs/kit/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import {existsSync} from 'fs';
import {
	ASSETS_FOLDER,
	MANIFEST_PATH,
	assetpackPlugin,
	writeEmptyManifest,
} from './vite.assetpack';
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

const env = process.env;

export default defineConfig(({mode}) => {
	const plugins = [
		devtoolsJson(FIRST_COMMIT ? {uuid: FIRST_COMMIT} : undefined),
		tailwindcss(),
		sveltekit(),
	];

	// The manifest is generated and gitignored, so a fresh clone does not have
	// one, and neither `svelte-check` nor `vitest` ever runs the pipeline that
	// would write it. Both resolve `$lib/manifest.json` as a module, so it has to
	// exist before anything decides whether to build the real one.
	if (!existsSync(MANIFEST_PATH)) writeEmptyManifest();

	// NOT under vitest. Nothing in the suite reads the manifest's CONTENT, and
	// running it there was actively harmful: each vitest project spins up its own
	// plugin instance, and their `fixManifest` read-modify-writes raced on one
	// file until it came out empty. See ./vite.assetpack.ts.
	if (existsSync(ASSETS_FOLDER) && !process.env.VITEST) {
		plugins.push(assetpackPlugin());
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
		build: {
			emptyOutDir: true,
			minify: true, // shrink chunks so large files don't stall on slow /
			// throttled connections (an unminified single bundle hung under
			// Chrome's request-level throttling)
			sourcemap: true,
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
