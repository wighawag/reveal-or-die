<script lang="ts">
	import Button from '$lib/core/ui/ethereum/generic/Button.svelte';
	import * as Modal from '$lib/core/ui/modal/index.js';
	import {getUserContext} from '$lib';

	const {
		connection,
		localState,
		enterFlow,
		epochInfo,
		twoPhase,
		avatars,
		purchaseFlow,
	} = getUserContext();
</script>

<Modal.Root
	openWhen={$enterFlow.step === 'Loading'}
	onCancel={() => enterFlow.cancel()}
>
	Please wait...
</Modal.Root>
<Modal.Root
	openWhen={$enterFlow.step === 'RequireSignIn'}
	onCancel={() => enterFlow.cancel()}
>
	<Modal.Title>You need to sign-in first</Modal.Title>
	<Button onclick={() => connection.connect()}>sign-in</Button>
</Modal.Root>
<Modal.Root
	openWhen={$enterFlow.step === 'RequireAvatars'}
	onCancel={() => enterFlow.cancel()}
>
	<Modal.Title>You do not have any avatar</Modal.Title>
	<Button onclick={() => enterFlow.startPurchaseFlow()}>Purchase</Button>
</Modal.Root>
<Modal.Root
	openWhen={$enterFlow.step === 'RequireDeposit'}
	onCancel={() => enterFlow.cancel()}
>
	<Modal.Title>
		Your avatars are in your wallet, you need to deposit them first
	</Modal.Title>
	<Button onclick={() => console.log('TODO')}>Deposit</Button>
</Modal.Root>
<Modal.Root
	openWhen={$enterFlow.step === 'Ready'}
	onCancel={() => enterFlow.cancel()}
>
	<Modal.Title>Select the avatar you want to play with</Modal.Title>
	{#if $enterFlow.step === 'Ready'}
		<div>
			{#each $enterFlow.avatars as avatarID}
				<Button onclick={() => enterFlow.enter(avatarID)}
					>{avatarID & 0xfffffffffn}</Button
				>
			{/each}
		</div>
	{/if}
</Modal.Root>

{#if $connection.step !== 'SignedIn'}
	<div
		class="fixed bottom-0 left-0 z-50 flex h-12 w-full items-center justify-between bg-yellow-400 px-4 text-black shadow-md"
	>
		<span
			>To play <Button onclick={() => connection.connect()}>sign-in</Button
			></span
		>
	</div>
{:else if $avatars.step == 'Loaded' && !($localState.signer && $localState.avatar && !$localState.avatar.exiting)}
	<!--&& avatarsInGame.length == 0-->
	{#if $avatars.step == 'Loaded' && $avatars.avatarsOnBench.length == 0}
		<div
			class="fixed bottom-0 left-0 z-50 flex h-12 w-full items-center justify-between bg-yellow-400 px-4 text-black shadow-md"
		>
			<span>Get an avatar first</span>
			<Button id="avatars" onclick={() => purchaseFlow.start()}>avatars</Button>
		</div>
	{:else}
		<div
			class="fixed bottom-0 left-0 z-50 flex h-12 w-full items-center justify-between bg-yellow-400 px-4 text-black shadow-md"
		>
			<span>Choose a location to spawn in</span>
		</div>
	{/if}
{:else if $localState.signer ? !!$localState.avatar?.actions.find((v) => v.type === 'enter') && $localState.avatar.epoch >= $epochInfo.currentEpoch : false}
	<div
		class="fixed bottom-0 left-0 z-50 flex h-12 w-full items-center justify-between bg-red-600 px-4 text-white shadow-md"
	>
		<span>Please wait your avatar spawn in the world</span>
	</div>
{:else if $twoPhase.phase === 'play' || ($twoPhase.type === 'timed' && $twoPhase.timeLeft < 0.1 && !!$localState.signer && !!$localState.avatar)}
	<div
		class="fixed bottom-0 left-0 z-50 flex h-12 w-full items-center justify-between bg-green-400 px-4 text-black shadow-md"
	>
		<span>Make your move</span>
	</div>
{/if}
