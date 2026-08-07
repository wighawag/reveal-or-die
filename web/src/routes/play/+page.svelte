<!--
	The template's game.

	A grid of shared cells: click to plan placements, the round commits as the
	phase closes, and reveals in the reveal phase. It exists to prove the seams
	in `$lib/game/core/seams.ts` fit together - the state store, the
	commit-reveal adapter, the view merge and the renderer are all exercised
	here, against a real chain.
-->
<script lang="ts">
	import {browser} from '$app/environment';
	import {getAppContext} from '$lib';
	import DefaultHead from '$lib/metadata/DefaultHead.svelte';
	import GameHud from '$lib/placement/ui/GameHud.svelte';

	const {render, game} = getAppContext();

	/**
	 * The canvas is loaded dynamically, and only in the browser.
	 *
	 * A static import would put it in the SERVER's module graph, and it renders
	 * only in the browser anyway (pixi needs a real canvas and a WebGL context),
	 * so the server would be paying to evaluate a renderer it can never use. It
	 * cannot, in fact: `pixi-viewport` ships no `exports` field, so resolution
	 * falls back to its UMD build, and SSR fails with "Named export 'Viewport'
	 * not found ... is a CommonJS module". The page 500s in dev.
	 *
	 * Worth knowing that `pnpm build` does NOT catch this - prerendering resolves
	 * the dependency differently and succeeds - so it only ever shows up in
	 * `pnpm web:dev`. Fixing it here rather than with `ssr.noExternal` in the vite
	 * config, because the point is that this module has no business on the server,
	 * not that the server should try harder to load it. It also keeps pixi out of
	 * the bundle for every route that is not the game.
	 */
	const canvasModule = browser
		? import('$lib/game/render/pixi/PixiCanvas.svelte')
		: undefined;
</script>

<DefaultHead />

<!--
	The game fills the space the app shell leaves below the navbar, rather than the
	whole viewport: it is a route inside the template, not a replacement for it.

	It stays in NORMAL FLOW to do that. `absolute inset-0` looks like the obvious
	way to fill the page and is wrong here: with no positioned ancestor it pins to
	the viewport, so the canvas slides up underneath the sticky `z-50` navbar,
	which then covers the top of the HUD. The casualty is the phase clock, which is
	exactly the thing a player needs to see, and the canvas looks fine while it
	happens, so nothing about it reads as broken until you look.

	Staying in flow also means the banners (offline, RPC health) push the game down
	instead of being drawn over.

	`3rem` is the navbar's own `h-12`; there is no variable for it to track.
-->
<div class="relative h-[calc(100dvh-3rem)] w-full overflow-hidden">
	<!-- pixi needs a real canvas and a WebGL context, so it only mounts in the
	     browser; the page still prerenders (see ADR-0002). -->
	{#if canvasModule}
		{#await canvasModule then { default: PixiCanvas }}
			<PixiCanvas
				cameraControl={render.cameraControl}
				renderer={render.gameRenderer}
				eventEmitter={render.eventEmitter}
				cellSize={game.config.cellSize}
			/>
		{:catch error}
			<!--
				An `{#await}` with no `:catch` renders nothing when the promise
				rejects, so a failed chunk load would leave a blank rectangle and no
				explanation - which is exactly what the SSR failure this dynamic import
				fixes used to look like from the outside.
			-->
			<div class="absolute inset-0 flex items-center justify-center p-4">
				<p class="max-w-md text-center text-sm text-red-400">
					The game canvas failed to load. {error instanceof Error
						? error.message
						: String(error)}
				</p>
			</div>
		{/await}
		<GameHud />
	{/if}
</div>
