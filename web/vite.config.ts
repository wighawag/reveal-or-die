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
} from './vite.assetpack.js';
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
			// HALF THE CORES, because a test run does not own the machine.
			//
			// Vitest defaults to one worker per core, and every worker that touches
			// the app barrel holds its own copy of a large module graph. That is fine
			// alone and falls apart the moment a second suite runs beside it: three of
			// these repos at once (16 cores, 30GB) drove the machine into swap and
			// `test/lib/context/fatal.test.ts` blew its 120s hang guard in ALL THREE,
			// with the whole run taking 27 minutes instead of 30 seconds. The failure
			// looks like a flaky test and is not one: it is 48 forks competing for 8GB.
			//
			// It is not a trade against speed, which is why it is a default rather
			// than something CI passes. Measured on this repo, solo: 19.3s -> 17.4s
			// wall, with transform 65s -> 34s and import 95s -> 46s, because the work
			// saved on contention more than pays for the workers given up. The same
			// three-way run that failed above passes in 80s with this set.
			//
			// A PERCENTAGE, not a number: these repos are cloned onto everything from
			// a laptop to a CI runner, and a hardcoded count is either oversubscribed
			// on the small machine or wasteful on the big one.
			maxWorkers: '50%',
			// THE TWO PROJECTS BELOW MUST NOT RUN AT THE SAME TIME, which is why
			// `test:unit` runs them as two commands rather than letting vitest start
			// both. Vitest runs projects concurrently, and these two do not share a
			// machine well: `client` drives a real headless chromium through
			// playwright while `server` fans a large module graph across forks.
			//
			// Together they are worse than the sum of their parts, measured on this
			// repo. Alone: server 17s, client 9s. Sequentially: 25s. Concurrently
			// (what one plain `vitest run` does): 43s. So splitting them is ~40%
			// FASTER even with the machine to yourself.
			//
			// And it is the difference between passing and hanging when the machine is
			// shared. Three of these repos running `vitest run` at once never
			// finished: killed at 15 minutes, every one of them, with
			// `test/lib/context/fatal.test.ts` blaming its own timeout. The same three
			// with the projects split finish in 1m50s. Neither project is at fault on
			// its own: three concurrent `server` runs pass in 80s and three concurrent
			// `client` runs pass in 50s.
			//
			// `test:unit:watch` deliberately keeps the single-process behaviour: watch
			// mode is one developer on one machine, and the ergonomics are worth more
			// there than the contention costs.
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
