<!--
	The table's own lines once it has started (stratagems' plan, step R1b): who
	is alive, that there is no exit, and the close, the leftovers and a
	survivor's winnings. Logic-less: every word is `../table.ts`'s, every button
	calls the table store.
-->
<script lang="ts">
	import {getAppContext} from '$lib';
	import Button from '$lib/shadcn/ui/button/button.svelte';
	import {createTableStatus} from './table-status';

	const context = getAppContext();
	const {game} = context;
	const status = createTableStatus(context);
</script>

{#if $status.panel && game.worldTable}
	{@const table = game.worldTable}
	<div class="mb-3 space-y-2 text-xs" data-testid="table-status">
		{#each $status.panel.lines as line (line)}
			<p>{line}</p>
		{/each}
		{#if $status.panel.close}
			<Button
				size="sm"
				data-testid="table-close"
				disabled={$status.panel.close.disabled}
				onclick={() => table.close()}
			>
				{$status.panel.close.label}
			</Button>
		{/if}
		{#if $status.panel.release}
			<Button
				size="sm"
				data-testid="table-release"
				disabled={$status.panel.release.disabled}
				onclick={() => table.releaseLeftovers()}
			>
				{$status.panel.release.label}
			</Button>
		{/if}
		{#if $status.panel.winnings}
			{@const seat = $status.panel.winnings.seat}
			<Button
				size="sm"
				variant="secondary"
				data-testid="table-winnings"
				disabled={$status.panel.winnings.disabled}
				onclick={() => table.takeWinnings(seat)}
			>
				{$status.panel.winnings.label}
			</Button>
		{/if}
		{#if $status.panel.error}
			<p class="text-red-400">{$status.panel.error}</p>
		{/if}
	</div>
{/if}
