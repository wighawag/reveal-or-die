<script lang="ts">
	import {route} from '$lib';
	import {url} from '$lib/kit/paths';
	import Button from '$lib/shadcn/ui/button/button.svelte';
	import DefaultHead from '../lib/metadata/DefaultHead.svelte';
	import {brand} from '$lib/metadata/brand';
</script>

<!-- THE GAME MENU, AND THE SAME FILE IN EVERY GAME. What differs between games is
     the title, and that comes from `src/web-config.json` through
     `$lib/metadata/brand`: a `logo` if the game has one, its `name` as text if
     it does not. Rebrand there, not here, so that whatever improves this page
     reaches every game without a conflict. -->

<DefaultHead />

<div
	class="flex min-h-full flex-col items-center justify-center gap-12 px-4 py-12"
>
	<!-- The heading is the title either way, so it is named by `name` in both
	     cases: the image's `alt` becomes the heading's accessible name. -->
	<h1 class="text-center">
		{#if brand.logo}
			<img
				src={url(brand.logo)}
				alt={brand.name}
				class="mx-auto max-h-64 w-auto max-w-[min(90vw,40rem)] drop-shadow-lg"
			/>
		{:else}
			<span
				class="bg-linear-to-br from-pink-500 to-violet-500 box-decoration-clone bg-clip-text text-6xl font-extrabold tracking-tight text-transparent md:text-8xl"
				>{brand.name}</span
			>
		{/if}
	</h1>

	<nav class="flex w-full max-w-sm flex-col gap-4" aria-label="Game menu">
		<Button
			href={route('/play/')}
			size="lg"
			class="h-16 w-full bg-linear-to-r from-pink-600 via-pink-500 to-rose-500 text-2xl font-bold text-white shadow-lg transition-all duration-300 hover:from-pink-700 hover:via-pink-600 hover:to-rose-600 hover:shadow-xl"
			>Online</Button
		>
		<!-- OFFLINE IS A WORLD, NOT A DEMO: a chain in this tab, which is a route of
		     the game's own (`routes/offline/` and `$lib/offline.ts`), not the stem's
		     `/offline-demo`.

		     WHAT THE ENTRY PROMISES IS THAT CHAIN, and nothing about what is at
		     stake in it. This file is identical in every game, and what a game
		     risks is the one thing they are guaranteed to disagree about, so a
		     word here naming one answer would be false somewhere downstream.

		     A GAME INHERITS THIS ENTRY AND NOT THE WORLD BEHIND IT. `$lib/embedded`
		     is the mechanism and cascades unchanged; `$lib/offline.ts` names the
		     game's contracts, deploy scripts and stake, so a game that replaces the
		     game replaces that too, and `offline.e2e.ts` is what says it can still
		     finish a cycle. -->
		<Button
			href={route('/offline/')}
			size="lg"
			variant="outline"
			class="h-16 w-full text-2xl font-bold shadow-lg transition-all duration-300 hover:shadow-xl"
			>Offline</Button
		>
	</nav>
</div>
