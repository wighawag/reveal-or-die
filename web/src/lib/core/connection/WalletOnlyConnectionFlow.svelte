<script lang="ts">
	import Address from '$lib/core/ui/ethereum/Address.svelte';
	import Button from '$lib/core/ui/ethereum/generic/Button.svelte';
	import BasicModal from '$lib/core/ui/modal/basic-modal.svelte';
	import * as Modal from '$lib/core/ui/modal/index.js';
	import type {
		ConnectionStore,
		UnderlyingEthereumProvider,
	} from '@etherplay/connect';

	interface Props {
		connection: ConnectionStore<UnderlyingEthereumProvider>;
	}

	let {connection}: Props = $props();
</script>

<Modal.Root
	layer="system"
	openWhen={$connection.step == 'WaitingForWalletConnection'}
	onCancel={() => connection.back('Idle')}
>
	<Modal.Title>Waiting for Wallet Connection...</Modal.Title>
	Please Accept Connection Request...
</Modal.Root>

<Modal.Root
	layer="system"
	openWhen={$connection.step == 'ChooseWalletAccount'}
	onCancel={() => connection.back('Idle')}
>
	<Modal.Title>Choose Wallet Account</Modal.Title>
	{#if $connection.step == 'ChooseWalletAccount'}
		<!-- ASSERT ChooseWalletAccount -->
		{#each $connection.wallet.accounts as account}
			<Button onclick={() => connection.connectToAddress(account)}
				>{account}</Button
			>
		{/each}
	{/if}
</Modal.Root>

<Modal.Root
	layer="system"
	openWhen={$connection.step == 'WalletToChoose'}
	onCancel={() => connection.cancel()}
>
	<Modal.Title>Choose Connection Type...</Modal.Title>

	<!-- Wallet options -->
	{#if $connection.wallets.length > 0}
		<div class="mb-6 flex flex-col gap-2">
			{#each $connection.wallets as wallet}
				<Button
					class="rounded bg-zinc-700 px-4 py-2 text-zinc-100 transition hover:bg-zinc-600"
					onclick={() =>
						connection.connect({
							type: 'wallet',
							name: wallet.info.name,
						})}
				>
					<img
						src={wallet.info.icon}
						alt={wallet.info.name}
						class="mr-2 ml-2 inline-block h-5 w-5"
					/>
					{wallet.info.name}
				</Button>
			{/each}
		</div>
	{:else}
		We plan to support credit card payment but for now you need a web3 wallet to
		make the purchase
	{/if}
</Modal.Root>

<!-- NOTE: this opens on the SAME step as the ChooseWalletAccount modal above,
     so both render at once, differing only in whether cancelling goes back to
     Idle or cancels outright. Pre-existing; left alone here because deciding
     which one survives is a flow question, not a modal one. -->
<Modal.Root
	layer="system"
	openWhen={$connection.step === 'ChooseWalletAccount'}
	onCancel={() => connection.cancel()}
>
	<Modal.Title>Choose Wallet Account</Modal.Title>
	{#if $connection.step == 'ChooseWalletAccount'}
		<!-- ASSERT ChooseWalletAccount -->
		{#each $connection.wallet.accounts as account}
			<Button onclick={() => connection.connectToAddress(account)}
				><Address value={account} /></Button
			>
		{/each}
		<!-- TODO remoe ?-->
		<Button
			><Address value={'0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'} /></Button
		>
	{/if}
	<!-- TODO : cancel Button -->
</Modal.Root>

<!-- TODO not a Modal -->
<BasicModal
	layer="system"
	openWhen={($connection.step === 'SignedIn' &&
		$connection.wallet?.invalidChainId) ||
		false}
	title={`Require Connection to ${connection.chainInfo.name || `network with chainId: ${connection.chainId}`}`}
	cancel={true}
	confirm={{
		label: 'Switch',
		onclick: () => connection.switchWalletChain(),
		disabled: !!$connection.wallet?.switchingChain,
	}}
	onCancel={() => connection.cancel()}
>
	<p>
		Switch to {connection.chainInfo.name ||
			`network with chainId: ${connection.chainId}`} to continue.
	</p>
</BasicModal>
