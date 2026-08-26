<script lang="ts">
	import * as Modal from '$lib/core/ui/modal/index.js';
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

<Modal.Root
	openWhen={avatar
		? avatar.life == 0 && $epochInfo.currentEpoch >= avatar.lastEpoch + 1
		: false}
>
	<Modal.Title>Your avatar died</Modal.Title>
	<div>
		<button onclick={() => clear()}>ok</button>
	</div>
</Modal.Root>
