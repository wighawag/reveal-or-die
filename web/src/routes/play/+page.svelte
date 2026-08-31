<!--
	reveal-or-die.

	A shared world of avatars: click to plan where yours appears or which way it
	steps, the round commits as the phase closes, and reveals in the reveal
	phase. The seams in `$lib/game/core/seams.ts` are what it plugs into - the
	state store, the commit-reveal adapter, the view merge and the renderer are
	all filled by `$lib/world`, against a real chain.
-->
<script lang="ts">
	import {browser} from '$app/environment';
	import {getAppContext} from '$lib';
	import DefaultHead from '$lib/metadata/DefaultHead.svelte';
	import GameHud from '$lib/world/ui/GameHud.svelte';
	import DeathNotice from '$lib/world/ui/DeathNotice.svelte';
	import PurchaseModal from '$lib/world/ui/PurchaseModal.svelte';
	import Tutorial from '$lib/world/ui/Tutorial.svelte';
	import {loadCanvasComponent} from '$lib/world/render';
	import {gridTileCells} from '$lib/game/render/grid';

	const {render, game} = getAppContext();

	/**
	 * The canvas is loaded dynamically, and only in the browser.
	 *
	 * A static import would put it in the SERVER's module graph, and it renders
	 * only in the browser anyway (a canvas host needs a real canvas), so the
	 * server would be paying to evaluate a renderer it can never use. It also
	 * keeps the rendering library out of the bundle for every route that is not
	 * the game.
	 *
	 * This used to be load-bearing for a sharper reason: `pixi-viewport` shipped
	 * no `exports` field, so SSR resolved its UMD build and the page 500d in dev
	 * with "Named export 'Viewport' not found". That dependency is gone, so the
	 * failure is gone with it, but the two reasons above are not, and a renderer
	 * is exactly the kind of dependency that acquires such a problem again.
	 * Worth knowing if it ever recurs: `pnpm build` does NOT catch it, because
	 * prerendering resolves dependencies differently and succeeds. It shows up
	 * only in `pnpm web:dev`.
	 *
	 * WHICH canvas is not decided here: `$lib/world/render` names it, next to
	 * the renderer that has to match it. Both hosts take the same props, so this
	 * page is identical whichever is chosen.
	 */
	const canvasModule = browser ? loadCanvasComponent() : undefined;

	/**
	 * THE KEYBOARD AND ANY GAMEPAD LISTEN FOR AS LONG AS THIS PAGE IS MOUNTED.
	 *
	 * A decision, not a detail, and the two alternatives are each wrong in a way
	 * somebody would have to debug:
	 *
	 * - THE CANVAS'S lifetime is shorter than the game's. It mounts late (the
	 *   dynamic import above) and not at all when the chunk fails, so binding
	 *   input to it means keys that do nothing for the first moments of every
	 *   visit and a board that is silently uncontrollable whenever the `:catch`
	 *   branch is up. That coupling is what `docs/audits/03-renderer.md` 4.2 says
	 *   to undo, and the previous build had it: input was owned by the renderer,
	 *   and its teardown called `removeAllListeners()` on an emitter the canvas
	 *   was using too.
	 *
	 * - THE APP'S lifetime is longer. `context.start()` runs from the layout for
	 *   the whole session (`context/Context.svelte`), so binding there would leave
	 *   the arrow keys planning moves while the player is reading the account
	 *   panel on another route - invisibly, since the board is not on screen to
	 *   show it.
	 *
	 * The route is exactly the span where a key press means a move, which is why
	 * the binding lives in this file and the MAPPING does not: `game.controls`
	 * is built in the context, so the d-pad and this share one set of rules.
	 */
	$effect(() => game.controls.listen());
</script>

<DefaultHead />

<!--
	The game fills the space the app shell leaves, rather than the whole viewport:
	it is a route inside the template, not a replacement for it.

	`h-full`, and that is the whole calculation now. The shell (ADR-0007,
	`core/ui/AppShell.svelte`) renders every page into a region that is EXACTLY the
	viewport minus whatever chrome is up, so `100%` here means the screen minus the
	navbar minus however many condition bars are live, without this file knowing
	which bars exist or how tall they are.

	IT USED TO SAY `h-[calc(100dvh-3rem)]`, with a comment that `3rem` was the
	navbar's own `h-12` and there was no variable to track. Both halves were the
	bug. The number was a fourth spelling of the navbar's height, and subtracting
	the navbar ALONE is right for zero bars and wrong for every other case: with
	offline, no-RPC, a stale nonce cache or a dispatch in flight, this box was one
	bar taller than the space it had, the document grew a scrollbar this
	`overflow-hidden` could not absorb, and `GameHud` below is `absolute inset-0
	... justify-between`, so its BOTTOM row went under the fold. The casualty was
	the phase clock, which is the thing a player needs to see, and nothing looked
	broken until a condition fired.

	It stays in NORMAL FLOW. `absolute inset-0` looks like the obvious way to fill
	the page and is wrong here: with no positioned ancestor it pins to the
	viewport, so the canvas slides up underneath the `z-50` navbar, which then
	covers the top of the HUD. Same casualty, reached from the other direction.
-->
<div class="relative h-full w-full overflow-hidden">
	<!-- pixi needs a real canvas and a WebGL context, so it only mounts in the
	     browser; the page still prerenders (see ADR-0002). -->
	{#if canvasModule}
		{#await canvasModule then { default: GameCanvas }}
			<GameCanvas
				cameraControl={render.cameraControl}
				renderer={render.gameRenderer}
				eventEmitter={render.eventEmitter}
				cellSize={game.config.cellSize}
				gridCells={gridTileCells(game.config.camera.limits)}
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
		<!-- Both are surfaces over the board rather than parts of it, and both are
		     inside the `{#if}` because neither means anything without a canvas
		     under it. -->
		<DeathNotice />
		<PurchaseModal />
		<Tutorial />
	{/if}
</div>
