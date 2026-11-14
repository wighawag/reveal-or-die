<!--
	The HUD, drawn over the canvas.

	Logic-less on purpose (see AGENTS.md): everything it shows comes from the
	`HudModel` store, and every button calls straight into the game's stores. If
	a decision has to be made about what to show, it belongs in `hud.ts`.

	This is where the pre-port UI ended up. `GameClock` is the framework's now
	(`$lib/game/ui`), since every game on this template has the same four-part
	submission to draw; the phase banners `EnterFlow.svelte` used to paint across the
	bottom of the screen are the `instruction` line, the "Moves: n" box from
	`TopBar` is the moves counter, and the avatar list `EnterFlow` opened in a
	modal is the picker below. What they all had in common was reading the
	context directly and deciding for themselves; none of them do now.
-->
<script lang="ts">
	import {getAppContext} from '$lib';
	import {createHud} from './hud';
	import GameClock from '$lib/game/ui/GameClock.svelte';
	import DPad from './DPad.svelte';
	import LootPanel from './LootPanel.svelte';
	import TableStatus from './TableStatus.svelte';
	import Button from '$lib/shadcn/ui/button/button.svelte';
	import TablePanel from '$lib/game/lobby/ui/TablePanel.svelte';
	import TableLobby from '$lib/game/lobby/ui/TableLobby.svelte';
	import {tableSettingsOf} from '$lib/game/lobby/table';
	import {createTableStatus} from './table-status';

	const context = getAppContext();
	const {game} = context;
	const hud = createHud(context);

	const submission = game.submission;
	const planning = game.planning;
	const missedReveal = game.missedReveal;
	// A turn the chain holds and this browser has lost. Usually recovered
	// without the player ever seeing this, by searching the walks the maze
	// allows; the notice is what is left when the search cannot answer. See
	// $lib/world/recover-submission.
	const recovery = game.recovery;
	const plannedActions = game.planning.actions;
	const activeIdentity = game.activeIdentity;
	const purchase = game.purchase;
	// One shared flow, built in the context, so the account panel and a blocked
	// move cannot open two top-ups at once.
	const topUp = context.topUp;

	// At a table (stratagems' plan, step R1b): its lobby until it starts, then
	// its seats over the board and this game's own lines in the HUD.
	const tableScreen = game.table?.screen;
	const tableSettings = tableSettingsOf(game.config.cycle);
	const inTableLobby = $derived(
		game.table !== undefined && $tableScreen?.screen !== 'playing',
	);
	const tableStatus = createTableStatus(context);

	const toneClass: Record<string, string> = {
		idle: 'text-muted-foreground',
		busy: 'text-blue-400',
		good: 'text-emerald-400',
		bad: 'text-red-400',
	};
</script>

<!-- What stands between this person and a turn (signing in, a seat,
     authorising this browser): in the HUD, and in a table's lobby, where the
     seat is what this asks for. -->
{#snippet setupControls()}
	{#if $hud.setup}
		<!--
			Not yet playable: ask for the one thing that is missing, rather than
			showing planning controls that cannot lead anywhere.
		-->
		<p class="text-sm font-semibold">{$hud.setup.headline}</p>
		<p class="mt-1 max-w-sm text-xs text-muted-foreground">
			{$hud.setup.detail}
		</p>
		{#if $hud.setup.action === 'authorise'}
			<!--
				The same flow the out-of-gas remedy uses: it registers the delegate
				AND funds it in one transaction, which is the right shape here too.
				A key that is authorised but has no gas is authorised in name only,
				and that is a second dead end one step further on.
			-->
			<!-- The purpose IS authorising here, so the dialog says so. It is a
			     required argument now, deliberately: a default is what let one
			     caller's words end up in front of every other caller's users. -->
			<Button
				size="sm"
				class="mt-3"
				onclick={() => topUp.start(topUp.purposes.authorise)}
			>
				Authorise and carry on
			</Button>
		{:else if $hud.setup.action === 'buy'}
			<!--
				Spends the player's own money, so it prompts the wallet, unlike
				every move. `purchase.buy()` also refuses to run twice at once:
				a disabled button is a suggestion, and `subID` is random, so a
				second run would buy a SECOND avatar rather than colliding.
			-->
			<Button
				size="sm"
				class="mt-3"
				disabled={$hud.setup.busy}
				onclick={() => purchase.buy()}
			>
				{$hud.setup.busy ? $hud.setup.busyLabel : $hud.setup.actionLabel}
			</Button>
			{#if $hud.setup.error}
				<p class="mt-2 max-w-sm text-xs text-red-400">{$hud.setup.error}</p>
			{/if}
		{:else if $hud.setup.action === 'join'}
			<!-- An ETH-mode table's seat: the stake, from the account. -->
			<Button
				size="sm"
				class="mt-3"
				data-testid="table-join"
				disabled={$hud.setup.busy}
				onclick={() => game.worldTable?.join()}
			>
				{$hud.setup.busy ? $hud.setup.busyLabel : $hud.setup.actionLabel}
			</Button>
			{#if $hud.setup.error}
				<p class="mt-2 max-w-sm text-xs text-red-400">{$hud.setup.error}</p>
			{/if}
		{/if}
		{#each $tableStatus.seatable as avatar (avatar.avatarID)}
			<!-- An avatar this account holds, carrying the table's stake. -->
			<Button
				size="sm"
				variant="outline"
				class="mt-2 mr-2"
				data-testid="table-seat-held"
				onclick={() => game.worldTable?.seatHeld(avatar.avatarID)}
			>
				{avatar.label}
			</Button>
		{/each}
	{/if}
{/snippet}

<div
	class="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between p-3"
>
	<!-- At a table: its lobby (what it plays by, who is seated, the creator's
	     start) until it has started and this person holds a seat; then who is
	     playing, and the creator's forfeit. -->
	{#if game.table && inTableLobby}
		<TableLobby
			table={game.table}
			inviteLink={typeof location === 'undefined' ? '' : location.href}
			settings={tableSettings}
			details={$tableStatus.details}
		>
			{#snippet takeSeat()}
				{@render setupControls()}
			{/snippet}
		</TableLobby>
	{:else if game.table}
		<div class="absolute top-3 right-3">
			<TablePanel table={game.table} />
		</div>
	{/if}
	<!-- Phase and cycle -->
	<div
		class="pointer-events-auto flex w-fit items-center gap-3 rounded-lg bg-background/85 p-3 shadow-lg backdrop-blur"
	>
		<GameClock
			phase={$hud.phase}
			progress={$hud.progress}
			secondsLeft={$hud.secondsLeft}
			size={72}
		/>
		<div>
			<div class="flex items-baseline gap-2">
				<span class="text-sm font-semibold">{$hud.phaseLabel}</span>
				<span class="text-xs text-muted-foreground"
					>submission {$hud.cycleNumber}</span
				>
			</div>
			{#if $hud.avatarLine}
				<!-- One finished line from the model: what it says depends on whether
				     the avatar is in the world at all, which is a decision and belongs
				     in `hud.ts` rather than in an `{#if}` here. -->
				<div id="stats" class="mt-1 text-xs text-muted-foreground">
					{$hud.avatarLine}
				</div>
			{/if}
			{#if $hud.walletSigningNotice}
				<p class="mt-1 max-w-xs text-xs text-amber-400">
					{$hud.walletSigningNotice}
				</p>
			{/if}
		</div>
	</div>

	<!-- The submission, and the on-screen controls beside it -->
	<div class="flex items-end justify-between gap-3">
		<div
			class="pointer-events-auto w-fit max-w-md rounded-lg bg-background/85 p-3 shadow-lg backdrop-blur"
		>
			<!--
			An unrevealed commitment bars every new one, so it is stated plainly and
			settled only on a deliberate press. It forfeits nothing today, which is
			why the wording is about being blocked rather than about a loss.
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

			<!--
			The chain holds a turn this browser cannot open, and the search did not
			find it. Unlike a missed reveal nothing is lost yet, and the whole point
			is that it still can be: the player re-enters the same moves and the
			hash decides.
		-->
			{#if $hud.recovery}
				<div
					class="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-2"
				>
					<p class="text-sm font-semibold text-amber-400">
						{$hud.recovery.headline}
					</p>
					<p class="mt-1 max-w-sm text-xs text-muted-foreground">
						{$hud.recovery.detail}
					</p>
					<Button
						size="sm"
						class="mt-2"
						disabled={!$hud.recovery.canRecover}
						onclick={() => recovery.offer($plannedActions)}
					>
						{$hud.recovery.busy ? 'Checking...' : 'Recover turn'}
					</Button>
				</div>
			{/if}

			{#if $hud.setup}
				<!-- In a table's lobby the seat is asked for there, once. -->
				{#if !inTableLobby}{@render setupControls()}{/if}
			{:else}
				<p class="text-sm {toneClass[$hud.submissionTone]}">
					{$hud.submissionLabel}
				</p>

				{#if $hud.outOfGas}
					<!--
					The one failure with a remedy. The submission retries itself once the
					gas arrives, so this offers the top-up and says so, rather than
					asking the player to also remember to press something after.
				-->
					<div
						class="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2"
					>
						<p class="text-xs text-muted-foreground">{$hud.outOfGas.detail}</p>
						<!-- A DIFFERENT purpose from the gate above, and this is exactly
					     what the argument is for: the key is already authorised and
					     has simply run out of gas, so telling the player it is about
					     to be authorised would be describing a step that happened
					     cycles ago. -->
						<Button
							size="sm"
							class="mt-2"
							onclick={() => topUp.start(topUp.purposes.topUp)}
						>
							Top up and carry on
						</Button>
					</div>
				{/if}

				{#if $hud.advanceFailed}
					<!-- Why the board is standing still. No button: the advance retries
					     by itself, and nothing the player can press fixes the cause. -->
					<p class="mt-2 max-w-sm text-xs text-amber-400">
						{$hud.advanceFailed.detail}
					</p>
				{/if}

				<p class="mt-2 text-xs text-muted-foreground">{$hud.instruction}</p>

				<div class="mt-3 flex flex-wrap gap-2">
					<Button
						size="sm"
						disabled={!$hud.canCommit}
						onclick={() => submission.commit()}
					>
						Commit now
					</Button>
					{#if $hud.canReveal}
						<Button
							size="sm"
							variant="destructive"
							onclick={() => submission.reveal()}
						>
							Retry reveal
						</Button>
					{/if}
					<Button
						size="sm"
						variant="outline"
						disabled={$hud.plannedCount === 0}
						onclick={() => planning.undo()}
					>
						Undo
					</Button>
					<Button
						size="sm"
						variant="outline"
						disabled={!$hud.canClear}
						onclick={() => planning.clear()}
					>
						Clear
					</Button>
				</div>

				{#if $hud.avatarChoices.length > 1}
					<!--
					ONE ACTIVE AVATAR PER CLIENT. Nothing on chain keeps two clients off
					the same avatar (authority is account-wide), so this choice is the
					only thing that does: two browsers on one account must pick
					differently, or the later commitment replaces the earlier one and
					the first client's reveal fails.
				-->
					<div id="avatars" class="mt-3">
						<p class="text-xs text-muted-foreground">Playing as</p>
						<div class="mt-1 flex flex-wrap gap-2">
							{#each $hud.avatarChoices as choice (choice.avatarID)}
								<Button
									size="sm"
									variant={choice.active ? 'secondary' : 'ghost'}
									disabled={choice.life === 0}
									onclick={() => activeIdentity.select(choice.avatarID)}
								>
									{choice.label}{choice.inGame ? ' (in world)' : ''}
								</Button>
							{/each}
						</div>
					</div>
				{/if}
			{/if}

			<!-- At a table once started: who is alive, the close, the leftovers and
			     the winnings (stratagems' plan, step R1b). -->
			<TableStatus />
			<!-- Outside the setup gate: an avatar taken out, or one held in the
			     wallet, is still burnable for its stake while nothing is in play. -->
			<LootPanel />
		</div>

		<!--
			ONLY WITH AN AVATAR IN THE WORLD, because that is exactly when it can do
			anything: a direction steps from where the plan ends, and leaving needs
			something to leave. Out of the world the one action available is choosing
			a spawn, which is a place and therefore a click.
		-->
		{#if $hud.inWorld && !$hud.setup}
			<DPad />
		{/if}
	</div>
</div>

<!--
	A border submission the whole window while the submission is resolving.

	Kept from the pre-port UI: the canvas fills the screen and the player is
	looking at their avatar, not at the HUD in the corner, so the one thing that
	has to be unmissable is "this turn is no longer yours to change".
-->
{#if $hud.phase !== 'play' && !$hud.setup}
	<div
		class="pointer-events-none fixed inset-0 z-50 border-[10px] border-red-600"
	></div>
{:else if $hud.inWorld && $hud.movesLeft <= 0}
	<div
		class="pointer-events-none fixed inset-0 z-50 border-[10px] border-yellow-600"
	></div>
{/if}
