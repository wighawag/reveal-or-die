<!--
	Who pays for the avatar.

	The same question the top-up flow asks, in the same words, from the same
	`payment-methods` list. It is a separate modal rather than a reuse of
	`TopUpModal` because the two flows answer different questions (this buys a
	thing, that tops up gas) and share the part that matters: the RULE for which
	methods are available, which lives in `$lib/ui/credits/payment-methods` and is
	tested there. Two copies of the markup is a smaller problem than two rules
	about whether an account can pay, which a player would experience as the app
	contradicting itself.

	Only shown when there is a genuine choice; `purchase.buy()` skips straight to
	the single available method when there is one, and to `NoPaymentMethod` when
	there is none.
-->
<script lang="ts">
	import * as Modal from '$lib/core/ui/modal/index.js';
	import Button from '$lib/shadcn/ui/button/button.svelte';
	import {getAppContext} from '$lib';

	const {game} = getAppContext();
	const purchase = game.purchase;
</script>

<Modal.Root
	layer="system"
	openWhen={$purchase.step === 'ChoosingPayer'}
	onCancel={() => purchase.dismiss()}
>
	<Modal.Title>How would you like to pay?</Modal.Title>
	{#if $purchase.step === 'ChoosingPayer'}
		<p class="text-sm text-muted-foreground">
			One transaction buys an avatar into the game and funds the key this
			browser plays with. Whoever pays, the avatar belongs to your account.
		</p>

		<div
			class="mt-3 flex flex-col gap-2"
			data-testid="purchase-payment-methods"
		>
			<!-- Order is the order they are declared in payment-methods.ts, and the
			     first available one is the primary action: paying from the account is
			     one transaction and no second connection. Unavailable ones are shown
			     WITH their reason rather than hidden, so a player who expected to pay
			     one way is told why they cannot. -->
			{#each $purchase.methods as method, i (method.id)}
				<Button
					variant={i === 0 ? 'default' : 'outline'}
					class="h-auto w-full flex-col items-start gap-1 py-3 text-left whitespace-normal"
					disabled={!method.available}
					onclick={() => purchase.choose(method.id)}
					data-testid={`purchase-pay-with-${method.id}`}
				>
					<span class="font-semibold">{method.label}</span>
					<span class="text-xs font-normal opacity-80">
						{method.available ? method.description : method.unavailableReason}
					</span>
				</Button>
			{/each}
		</div>
	{/if}
</Modal.Root>

<!--
	Nothing here can pay, which is a real state rather than a fault: an account
	with no wallet, in a browser with no wallet installed. It gets the
	explanation the template already wrote for it.
-->
<Modal.Root
	layer="system"
	openWhen={$purchase.step === 'NoPaymentMethod'}
	onCancel={() => purchase.dismiss()}
>
	<Modal.Title>No way to pay from this browser</Modal.Title>
	{#if $purchase.step === 'NoPaymentMethod'}
		<p class="text-sm text-muted-foreground">{$purchase.message}</p>
	{/if}
</Modal.Root>
