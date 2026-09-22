<!--
	PLAY OFFLINE: the same game, against a chain inside this tab.

	THE ROUTE IS THE CHOOSING AND NOTHING ELSE. Booting a chain, running this
	game's own deploy scripts on it, declaring the manual cycle policy and
	handing the player their stake all live in `$lib/offline`, which is in turn
	composition over `$lib/embedded`. Nothing world-building belongs in a route:
	a descendant of this template deletes the routes it inherits, and would throw
	it away.

	THE GAME COMPONENT IS IMPORTED RATHER THAN COPIED, and that is the whole
	claim a world makes: the same page, against a different chain, without
	knowing there is more than one. A second copy would prove nothing - and
	`routes/play/+page.svelte` must stay byte-identical across every branch of
	this template, so it could not have been edited to know about this anyway.
-->
<script lang="ts">
	import {onMount} from 'svelte';
	import DefaultHead from '../../lib/metadata/DefaultHead.svelte';
	import Context from '$lib/context/Context.svelte';
	import {Spinner} from '$lib/shadcn/ui/spinner';
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';
	import {offlineWorld, startOfflineWorld} from '$lib/offline';
	import InWorld from '$lib/context/InWorld.svelte';
	import Play from '../play/+page.svelte';

	onMount(() => {
		startOfflineWorld();
	});
</script>

<DefaultHead title={'Play Offline - a chain in this tab'} />

{#if $offlineWorld.step === 'Ready'}
	<!-- A NESTED PROVIDER, which is the whole mechanism in one element.
	     `setAppContext` is svelte's `setContext`, so this shadows the app's
	     context for THIS SUBTREE only: the game below runs against the chain in
	     the tab while the navbar above still describes the remote one.

	     THAT IS ALSO A KNOWN GAP, and it is honest to say so here rather than
	     leave it to be discovered: the chrome lives in `+layout.svelte`, outside
	     every route subtree, so the account, the balance and the RPC banner up
	     there are still the other world's. Fixing it is upstream work in
	     `lib/core`, which every repo in this tree inherits.

	     NO CONNECTION FLOW, AND THAT IS THE POINT RATHER THAN AN OMISSION. A
	     flow exists to relay a wallet's questions - which wallet, which account,
	     approve this - and a wallet this world GENERATED has none: one wallet,
	     one account, and it signs without asking. Mounting one produces modals
	     that flash past describing decisions nobody is making. The rule the two
	     states give between them: a nested world using the PLAYER's wallet needs
	     its own flow, and one that brings its own must not have it. -->
	<div class="flex h-full flex-col">
		<div
			class="shrink-0 border-b border-dashed border-muted-foreground/40 bg-muted/40 px-4 py-2 text-center text-sm"
		>
			Everything below runs against a chain inside this tab, on chain id
			<code>{$offlineWorld.world.chainId}</code>. Nothing leaves the browser.
			The navbar above is still describing the remote chain.
		</div>
		<div class="min-h-0 flex-1">
			<Context context={$offlineWorld.context}>
				<Play />
				<!-- The app's own overlays, bound to THIS world. Without them the
				     flows this game opens (authorising the browser's key, topping it
				     up) drive stores nothing on screen is reading, and the button
				     appears to do nothing. See the file for what is deliberately not
				     in it. -->
				<InWorld />
			</Context>
		</div>
	</div>
{:else if $offlineWorld.step === 'Failed'}
	<div class="container mx-auto max-w-2xl px-4 py-16">
		<div
			class="flex items-start gap-3 rounded-lg border border-destructive/50 p-4"
		>
			<AlertCircleIcon class="mt-0.5 size-5 shrink-0 text-destructive" />
			<div>
				<p class="font-semibold">The offline world did not start.</p>
				<p class="mt-1 text-sm text-muted-foreground">
					{$offlineWorld.error}
				</p>
			</div>
		</div>
	</div>
{:else}
	<div
		class="container mx-auto flex max-w-2xl flex-col items-center gap-3 px-4 py-24 text-center"
	>
		<Spinner class="size-6" />
		<p class="text-sm text-muted-foreground">
			{$offlineWorld.step === 'Booting'
				? $offlineWorld.what
				: 'starting a chain in this tab'}&hellip;
		</p>
		<p class="max-w-md text-xs text-muted-foreground">
			A chain is being created in this browser and this game's own deploy
			scripts are being run against it. Nothing leaves the tab.
		</p>
	</div>
{/if}
