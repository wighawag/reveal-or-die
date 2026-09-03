<!--
	"Your avatar died."

	The pre-port `GameInfo.svelte`, on the new context. It asked the view state
	whether the avatar the player was controlling had run out of life; it now
	asks the HUD model about the ACCOUNT's avatars, because the active avatar can
	no longer be a dead one (`chooseActiveAvatar` skips them, so the old question
	would answer no from the moment it became true).

	THE ACKNOWLEDGEMENT IS RECORDED, not just remembered for the session: the
	death is a fact on chain until the body is withdrawn, so a dismissal that
	lived only in this component made the news repeat on every reload, and the
	only escape was buying another avatar. It is kept per DEATH (see
	`./death-ack.ts`), so an avatar that is re-bought and dies again is news
	again.
-->
<script lang="ts">
	import * as Modal from '$lib/core/ui/modal/index.js';
	import Button from '$lib/shadcn/ui/button/button.svelte';
	import {getAppContext} from '$lib';
	import {createHud} from './hud';
	import {createDeathAcknowledgement} from './death-ack';

	const context = getAppContext();
	const hud = createHud(context);

	// Scoped like the round storage: the same browser may play the same game on
	// two chains, or two deployments on one.
	const {chain, contracts} = context.deployments.get();
	const acknowledged = createDeathAcknowledgement({
		chainID: chain.id,
		gameAddress: contracts.Game.address,
	});

	/** Set when the acknowledgement is written, which is what closes the modal. */
	let justAcknowledged = $state(false);
	const open = $derived(
		!!$hud.died && !justAcknowledged && !acknowledged.isAcknowledged($hud.died),
	);

	/** THE ONE WAY THIS CLOSES: the news is marked as delivered, durably. */
	function acknowledge() {
		if (!$hud.died) return;
		acknowledged.acknowledge($hud.died);
		justAcknowledged = true;
	}
</script>

<!--
	The modal layer: this REPORTS something that already happened, rather than
	asking a live question about something in flight, which is what the system
	layer is for (core/ui/layers.ts). A death notice must not cover a wallet
	prompt or a funds modal - if the avatar died while a transaction is being
	confirmed, the transaction is the more urgent thing on screen.

	Closing via the X or Escape acknowledges too: there is no reading of "I saw
	this and dismissed it" that leaves the news undelivered, and the alternative
	- a modal the X cannot close - is a trap.
-->
<Modal.Root layer="modal" openWhen={open} onCancel={() => acknowledge()}>
	<Modal.Title>Your avatar died</Modal.Title>
	<p class="text-sm text-muted-foreground">
		Avatar {$hud.died?.label} was killed and is still lying where it fell.
	</p>
	<!--
		WHY, which is the whole point of telling them at all. Assembled in
		`world/death.ts` because nothing on chain records a cause: the sentence is
		the client's own reading of a rule, so it belongs somewhere it can be read
		and tested rather than inline in a modal.
	-->
	<p class="mt-2 text-sm text-muted-foreground">{$hud.died?.explanation}</p>
	<p class="mt-2 text-sm text-muted-foreground">
		Play on with another one, or withdraw this one from the game contract to get
		the avatar back.
	</p>
	<Button size="sm" class="mt-4" onclick={() => acknowledge()}>
		Acknowledge
	</Button>
</Modal.Root>
