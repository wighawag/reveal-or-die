<!--
	The on-screen controls, for a player with neither a keyboard nor a gamepad.

	A THIRD INPUT DEVICE, not a special case: every button here emits the same
	`ControlIntent` a key or a pad emits, into the same `game.controls`. That is
	the whole reason `$lib/world/controls.ts` exists as its own module, and it is
	what stops a phone and a keyboard disagreeing about what a step is.

	Logic-less by construction (see AGENTS.md): what a direction means, whether a
	step is legal and whether leaving is allowed are all decided behind
	`controls.handle`, and this file only lays out the buttons. Whether it is
	shown at all is `GameHud`'s decision, from the HUD model.

	It replaces the d-pad that was deleted with the pre-port renderer, which
	emitted into a module-level event emitter the canvas also listened to
	(`docs/audits/03-renderer.md` 4.8). Nothing here is shared with the canvas.
-->
<script lang="ts">
	import {getAppContext} from '$lib';
	import Button from '$lib/shadcn/ui/button/button.svelte';

	const {game} = getAppContext();
	const controls = game.controls;
	// The planning store's own answer, not a second reading of the board: the
	// button that offers leaving and the call that performs it have to agree, and
	// `exitAt` refuses from anywhere but the exit tile.
	const canExit = game.planning.canExit;
</script>

<div class="pointer-events-auto flex flex-col items-center gap-2">
	<div
		class="grid grid-cols-3 grid-rows-3 gap-1 rounded-lg bg-background/85 p-2 shadow-lg backdrop-blur"
	>
		<div></div>
		<Button
			size="icon"
			variant="outline"
			aria-label="Step north"
			onclick={() => controls.handle({type: 'direction', direction: 'up'})}
		>
			↑
		</Button>
		<div></div>

		<Button
			size="icon"
			variant="outline"
			aria-label="Step west"
			onclick={() => controls.handle({type: 'direction', direction: 'left'})}
		>
			←
		</Button>
		<Button
			size="icon"
			variant="ghost"
			aria-label="Take back the last step"
			onclick={() => controls.handle({type: 'cancel'})}
		>
			⌫
		</Button>
		<Button
			size="icon"
			variant="outline"
			aria-label="Step east"
			onclick={() => controls.handle({type: 'direction', direction: 'right'})}
		>
			→
		</Button>

		<div></div>
		<Button
			size="icon"
			variant="outline"
			aria-label="Step south"
			onclick={() => controls.handle({type: 'direction', direction: 'down'})}
		>
			↓
		</Button>
		<div></div>
	</div>

	<!--
		The only affordance for the Exit action, which is why it is spelled out
		rather than given an icon. It is the whole point of the exit tile being
		drawn on the map, and until recently the goal was visible and unreachable.

		DISABLED AWAY FROM THE EXIT, because that is now the contract's rule too:
		`_exit` reads the cell under the avatar and drops the action anywhere else,
		which from the player's side would look like a button that did nothing. The
		HUD's instruction line says where the way out is, so the disabled state is
		not the only thing they have to go on.
	-->
	<Button
		size="sm"
		variant="secondary"
		class="w-full"
		disabled={!$canExit}
		aria-label="Leave the world"
		onclick={() => controls.handle({type: 'secondary'})}
	>
		Leave the world
	</Button>
</div>
