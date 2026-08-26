<!--
	The welcome card, and the way into the tour.

	The pre-port `ui/tutorial/Tutorial.svelte`, on the new context. It gated on
	`$localState.signer`, a store that no longer exists; it now gates on the
	player being able to play at all, which is the same intent stated against the
	setup gate: a tour of controls is no use to somebody who is still being asked
	to sign in, and it would cover the instruction telling them to.
-->
<script lang="ts">
	import Button from '$lib/shadcn/ui/button/button.svelte';
	import {getAppContext} from '$lib';
	import {createTutorial, startTour} from './tutorial';

	const {game} = getAppContext();
	const readyToPlay = game.readyToPlay;
	const tutorial = createTutorial();
</script>

{#if $readyToPlay && !$tutorial.seen}
	<div
		class="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
	>
		<div
			class="max-h-full max-w-lg overflow-auto rounded-lg bg-background p-8 shadow-lg"
		>
			<h1 class="text-lg font-bold">Welcome to reveal-or-die</h1>

			<p class="mt-4">Masked warriors. Real stakes. Endless spectacle.</p>

			<p class="mt-4">
				You are the Handler: build your fighter, outthink rivals, and claim
				glory.
			</p>

			<p class="mt-4">The arena is live. The world is watching.</p>

			<div class="mt-6 flex gap-2">
				<Button onclick={() => startTour(() => tutorial.markSeen())}>
					Start tour
				</Button>
				<Button variant="outline" onclick={() => tutorial.markSeen()}>
					Skip
				</Button>
			</div>
		</div>
	</div>
{/if}
