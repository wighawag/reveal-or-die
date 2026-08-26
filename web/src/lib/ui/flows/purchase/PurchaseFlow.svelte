<script lang="ts">
	import {getUserContext} from '$lib';
	import Button from '$lib/core/ui/ethereum/generic/Button.svelte';
	import * as Modal from '$lib/core/ui/modal/index.js';

	const {connection, purchaseFlow} = getUserContext();
</script>

<!-- TODO? not a modal -->
<Modal.Root
	openWhen={$purchaseFlow.step == 'RequireSignIn'}
	onCancel={() => purchaseFlow.cancel()}
>
	<Modal.Title>You need to sign-in first</Modal.Title>
	<Button onclick={() => connection.connect()}>sign-in</Button>
</Modal.Root>

<Modal.Root
	openWhen={$purchaseFlow.step == 'Ready'}
	onCancel={() => purchaseFlow.cancel()}
>
	<Modal.Title>Avatar is $X.XX</Modal.Title>
	<Button onclick={() => purchaseFlow.purchase()}>buy</Button>
</Modal.Root>

<!-- No onCancel: a transaction in flight is not something the player can
     dismiss, and the template's modal derives showCloseButton and
     interact-outside behaviour from onCancel being absent. -->
<Modal.Root openWhen={$purchaseFlow.step == 'ConfirmTransaction'}>
	<Modal.Title>Please confirm your purchase</Modal.Title>
</Modal.Root>

<Modal.Root openWhen={$purchaseFlow.step == 'PendingTransaction'}>
	<Modal.Title>Please wait while the purchase go through</Modal.Title>
</Modal.Root>
