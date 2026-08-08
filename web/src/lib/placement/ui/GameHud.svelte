<!--
	The HUD, drawn over the canvas.

	Logic-less on purpose (see AGENTS.md): everything it shows comes from the
	`HudModel` store, and every button calls straight into the game's stores. If
	a decision has to be made about what to show, it belongs in `hud.ts`.
-->
<script lang="ts">
	import {getAppContext} from '$lib';
	import {createHud} from './hud';
	import Button from '$lib/shadcn/ui/button/button.svelte';
	import {parseEther} from 'viem';

	const context = getAppContext();
	const {game} = context;
	const hud = createHud(context);

	const round = game.round;
	const planning = game.planning;
	const reserve = game.reserve;
	const missedReveal = game.missedReveal;
	// One shared flow, built in the context, so the account panel and a blocked
	// move cannot open two top-ups at once.
	const topUp = context.topUp;

	/** What the "Add stake" button tops the reserve up by. */
	const TOP_UP = parseEther('10');

	const toneClass: Record<string, string> = {
		idle: 'text-muted-foreground',
		busy: 'text-blue-400',
		good: 'text-emerald-400',
		bad: 'text-red-400',
	};
</script>

<div
	class="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between p-3"
>
	<!-- Phase and epoch -->
	<div
		class="pointer-events-auto w-fit rounded-lg bg-background/85 p-3 shadow-lg backdrop-blur"
	>
		<div class="flex items-baseline gap-2">
			<!--
				A dot rather than a word for the one thing the player checks
				constantly: can I move right now.
			-->
			<span
				class="inline-block size-2 rounded-full {$hud.phase === 'play'
					? 'bg-emerald-400'
					: 'bg-amber-400'}"
			></span>
			<span class="text-sm font-semibold">{$hud.phaseLabel}</span>
			<span class="text-xs text-muted-foreground">round {$hud.epoch}</span>
		</div>
		<div class="mt-1 flex items-center gap-2">
			<div class="h-1.5 w-40 overflow-hidden rounded-full bg-muted">
				<div
					class="h-full transition-[width] duration-1000 ease-linear {$hud.phase ===
					'play'
						? 'bg-emerald-400'
						: 'bg-amber-400'}"
					style="width: {$hud.progress * 100}%"
				></div>
			</div>
			<span class="w-10 text-right font-mono text-xs">{$hud.secondsLeft}s</span>
		</div>
		{#if $hud.walletSigningNotice}
			<p class="mt-1 max-w-xs text-xs text-amber-400">
				{$hud.walletSigningNotice}
			</p>
		{/if}
		{#if $hud.planningForNextRound}
			<p class="mt-1 text-xs text-amber-400">
				This round is closed. New picks count for the next one.
			</p>
		{/if}
	</div>

	<!-- The round -->
	<div
		class="pointer-events-auto w-fit max-w-md rounded-lg bg-background/85 p-3 shadow-lg backdrop-blur"
	>
		<!--
			A missed reveal has already cost the player their bond, so it is stated
			plainly and settled only on a deliberate press: acknowledging is what
			makes the forfeit final on chain, and it is not ours to do for them.
		-->
		{#if $hud.missedReveal}
			<div class="mb-3 rounded-md border border-red-500/40 bg-red-500/10 p-2">
				<p class="text-sm font-semibold text-red-400">
					{$hud.missedReveal.headline}
				</p>
				<p class="mt-1 text-xs text-muted-foreground">
					{$hud.missedReveal.detail}
				</p>
				<Button
					size="sm"
					variant="destructive"
					class="mt-2"
					disabled={!$hud.missedReveal.canAcknowledge}
					onclick={() => missedReveal.acknowledge()}
				>
					{$hud.missedReveal.busy
						? 'Acknowledging...'
						: 'Acknowledge missed reveal'}
				</Button>
			</div>
		{/if}

		{#if $hud.setup}
			<!--
				Not yet playable: ask for the one thing that is missing, rather than
				showing planning controls that cannot lead anywhere.
			-->
			<p class="text-sm font-semibold">{$hud.setup.headline}</p>
			<p class="mt-1 max-w-sm text-xs text-muted-foreground">
				{$hud.setup.detail}
			</p>
			{#if $hud.setup.action === 'stake'}
				<Button size="sm" class="mt-3" onclick={() => reserve.fund(TOP_UP)}>
					Deposit to play
				</Button>
			{/if}
		{:else}
			<p class="text-sm {toneClass[$hud.roundTone]}">{$hud.roundLabel}</p>

			{#if $hud.outOfGas}
				<!--
					The one failure with a remedy. The round retries itself once the
					gas arrives, so this offers the top-up and says so, rather than
					asking the player to also remember to press something after.
				-->
				<div
					class="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2"
				>
					<p class="text-xs text-muted-foreground">{$hud.outOfGas.detail}</p>
					<Button size="sm" class="mt-2" onclick={() => topUp.start()}>
						Top up and carry on
					</Button>
				</div>
			{/if}

			<dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
				<dt class="text-muted-foreground">Planned</dt>
				<dd>{$hud.plannedCount} cell{$hud.plannedCount === 1 ? '' : 's'}</dd>
				<dt class="text-muted-foreground">Cost</dt>
				<dd>{$hud.costLabel}</dd>
				<dt class="text-muted-foreground">Reserve</dt>
				<dd>{$hud.reserveLabel}</dd>
			</dl>

			{#if $hud.warning}
				<p class="mt-2 text-xs text-amber-400">{$hud.warning}</p>
			{/if}

			<div class="mt-3 flex flex-wrap gap-2">
				<Button
					size="sm"
					disabled={!$hud.canCommit}
					onclick={() => round.commit()}
				>
					Commit now
				</Button>
				{#if $hud.canReveal}
					<Button
						size="sm"
						variant="destructive"
						onclick={() => round.reveal()}
					>
						Retry reveal
					</Button>
				{/if}
				<Button
					size="sm"
					variant="outline"
					disabled={!$hud.canClear}
					onclick={() => planning.clear()}
				>
					Clear
				</Button>
				<Button
					size="sm"
					variant="secondary"
					onclick={() => reserve.fund(TOP_UP)}
				>
					Add stake
				</Button>
			</div>

			<p class="mt-2 text-xs text-muted-foreground">
				Click cells to plan placements. Cells are shared: two players placing on
				the same cell both hold a share of it.
			</p>
		{/if}
	</div>
</div>
