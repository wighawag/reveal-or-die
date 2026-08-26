<!--
	"Your avatar died."

	The pre-port `GameInfo.svelte`, on the new context. It asked the view state
	whether the avatar the player was controlling had run out of life; it now asks
	the HUD model about the ACCOUNT's avatars, because the active avatar can no
	longer be a dead one (`chooseActiveAvatar` skips them, so the old question
	would answer no from the moment it became true).

	Dismissal is local: nothing on chain changes by reading this, and the body
	stays in the world until it is withdrawn, so a modal that could not be closed
	would sit over the board for the rest of the session.
-->
<script lang="ts">
	import * as Modal from '$lib/core/ui/modal/index.js';
	import {getAppContext} from '$lib';
	import {createHud} from './hud';

	const context = getAppContext();
	const hud = createHud(context);

	/** Which casualty has already been acknowledged, so a later one still shows. */
	let dismissed = $state<string | undefined>(undefined);
	const open = $derived(!!$hud.died && $hud.died.label !== dismissed);
</script>

<Modal.Root openWhen={open} onCancel={() => (dismissed = $hud.died?.label)}>
	<Modal.Title>Your avatar died</Modal.Title>
	<p class="text-sm text-muted-foreground">
		Avatar {$hud.died?.label} was killed and is still lying where it fell. Play on
		with another one, or withdraw it from the game contract.
	</p>
</Modal.Root>
