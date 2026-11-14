<!--
	The bodies, what the avatar carries, and settling it (step R1a). Logic-less:
	every word is `loot-panel.ts`'s, every button calls a store.
-->
<script lang="ts">
	import {getAppContext} from '$lib';
	import Button from '$lib/shadcn/ui/button/button.svelte';
	import {createLootPanel} from './loot-panel';

	const context = getAppContext();
	const {game} = context;
	const panel = createLootPanel(context);
	const bodiesHere = game.bodiesHere;
</script>

<div id="loot" class="mt-3 space-y-2 text-xs" data-testid="loot-panel">
	{#if $panel.bodies}
		<div>
			<p class="text-amber-300">{$panel.bodies.line}</p>
			<Button
				size="sm"
				class="mt-1"
				data-testid="loot-collect"
				disabled={!$panel.bodies.canCollect}
				onclick={() => game.planning.collect($bodiesHere)}
			>
				{$panel.bodies.collectLabel}
			</Button>
		</div>
	{/if}
	{#if $panel.carriedLine}
		<p data-testid="loot-carried">{$panel.carriedLine}</p>
	{/if}
	{#if $panel.pendingLine}
		<p class="text-muted-foreground">{$panel.pendingLine}</p>
	{/if}
	{#if $panel.settle}
		<div>
			<p>{$panel.settle.line}</p>
			<Button
				size="sm"
				class="mt-1"
				data-testid="loot-settle"
				disabled={$panel.settle.disabled}
				onclick={() => game.loot.settleAll()}
			>
				{$panel.settle.label}
			</Button>
		</div>
	{/if}
	{#if $panel.withdraw}
		{@const avatarID = $panel.withdraw.avatarID}
		<Button
			size="sm"
			variant="secondary"
			data-testid="loot-withdraw"
			disabled={$panel.withdraw.disabled}
			onclick={() => game.loot.withdraw(avatarID)}
		>
			{$panel.withdraw.label}
		</Button>
	{/if}
	{#each $panel.held as avatar (avatar.avatarID)}
		<Button
			size="sm"
			variant="outline"
			data-testid="loot-burn"
			disabled={avatar.disabled}
			onclick={() => game.loot.burn(avatar.avatarID)}
		>
			{avatar.label}
		</Button>
	{/each}
	{#if $panel.error}
		<p class="text-red-400">{$panel.error}</p>
	{/if}
</div>
