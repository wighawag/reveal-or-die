<script lang="ts">
	import Modal from '$lib/core/ui/modal/legacy-modal.svelte';
	import {type AvatarViewEntity} from '$lib/view';

	import {getUserContext} from '$lib';
	const {viewState, epochInfo, localState, avatars} = getUserContext();

	function clear() {
		avatars.update();
		localState.markTutorialAsUnSeen();
		localState.removeAvatar();
	}

	let avatar = $derived(
		$viewState.avatar
			? ($viewState.entities[$viewState.avatar.id] as AvatarViewEntity)
			: undefined,
	);
</script>

<Modal
	openWhen={avatar
		? avatar.life == 0 && $epochInfo.currentEpoch >= avatar.lastEpoch + 1
		: false}
>
	{#snippet title()}
		Your avatar died
	{/snippet}
	<div>
		<button onclick={() => clear()}>ok</button>
	</div>
</Modal>
