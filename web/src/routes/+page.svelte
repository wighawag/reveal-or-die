<script lang="ts">
	import {route} from '$lib';
	import {url} from '$lib/kit/paths';
	import Button from '$lib/shadcn/ui/button/button.svelte';
	import DefaultHead from '../lib/metadata/DefaultHead.svelte';
	import {name} from '../web-config.json';
	import {onMount} from 'svelte';

	const words = ['Idea', 'Game', 'App'];
	let currentWordIndex = $state(0);

	onMount(() => {
		const interval = setInterval(() => {
			currentWordIndex = (currentWordIndex + 1) % words.length;
		}, 2000);

		return () => clearInterval(interval);
	});
</script>

<DefaultHead />

<div class="container mx-auto max-w-6xl px-4 py-12">
	<!-- Hero Section -->
	<div class="mb-16 flex flex-col items-center text-center">
		<img
			src={url('/icon.svg')}
			alt={name}
			class="mb-8 h-48 w-48 drop-shadow-lg"
		/>
		<h1 class="mb-4 text-5xl font-bold tracking-tight text-primary md:text-6xl">
			{name}
		</h1>
		<p class="mb-6 text-xl text-muted-foreground">
			<span
				class="bg-linear-to-br from-blue-500 to-cyan-300 box-decoration-clone bg-clip-text text-transparent"
				>Build</span
			>
			and
			<span
				class="bg-linear-to-br from-red-500 to-yellow-500 box-decoration-clone bg-clip-text text-transparent"
				>Deploy</span
			>
			for
			<span
				class="bg-linear-to-br from-pink-500 to-violet-500 box-decoration-clone bg-clip-text text-transparent"
				>Eternity</span
			>.
		</p>
		<p class="mb-8 max-w-2xl text-lg font-semibold">
			Welcome to your <span
				class="bg-linear-to-br from-red-500 to-yellow-500 box-decoration-clone bg-clip-text text-transparent"
				>{words[currentWordIndex]}</span
			>!
		</p>

		<!-- Action Buttons -->
		<div class="mb-8 flex flex-wrap justify-center gap-4">
			<Button
				href={route('/play/')}
				size="lg"
				class="min-w-40 bg-linear-to-r from-pink-600 via-pink-500 to-rose-500 font-semibold text-white shadow-lg transition-all duration-300 hover:from-pink-700 hover:via-pink-600 hover:to-rose-600 hover:shadow-xl"
				>Play</Button
			>
			<!-- OFFLINE IS A WORLD, NOT A DEMO, which is why this links to a route
			     of this app's own rather than to the `/offline-demo` the stem's home
			     page points at: this repo deletes the demo routes it inherits, and
			     the mechanism it keeps (`$lib/embedded`) has no opinion about what a
			     game does with it.

			     WHAT THE BUTTON PROMISES IS A CHAIN IN THE TAB, and nothing about
			     what is at stake in it. This file is byte-identical in every repo
			     that inherits it, and what a game risks is the one thing they are
			     guaranteed to disagree about: the framework requires only that
			     something is lost by not revealing, and each game answers
			     differently. A sentence naming one answer here would be false
			     somewhere downstream, which has already happened once.

			     A DESCENDANT INHERITS THIS BUTTON AND NOT THE WORLD BEHIND IT.
			     `$lib/embedded` is the mechanism and cascades unchanged;
			     `$lib/offline.ts` names THIS game's contracts, deploy scripts and
			     stake, so a game that replaces the game replaces it too. Until it
			     does, this link goes to a route that either does not exist or
			     cannot finish a cycle - so delete the button in the same commit as
			     the route, and put it back with the world. A link to a world this
			     game cannot play is worse than no link. -->
			<Button
				href={route('/offline/')}
				size="lg"
				variant="outline"
				class="min-w-40 font-semibold shadow-lg transition-all duration-300 hover:shadow-xl"
				>Play Offline</Button
			>
		</div>
	</div>
</div>
