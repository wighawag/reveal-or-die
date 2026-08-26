<!--
	SUPERSEDED by core/ui/modal/basic-modal.svelte, which is the template's and is ahead of
	this on everything that matters: the ADR-0004 overlay layers, the portal
	target fix (this one portals to document.body), and focus restore on
	close. Kept only until the callers below move, which happens with the
	game-layer port; their APIs differ (this takes a `title` snippet, the
	template's takes a `layer` and exposes Title from $ui/dialog).

	Renamed off `Modal.svelte`/`BasicModal.svelte` because those differed
	from the template's files only in CASE, which is a hard error for
	TypeScript and an outright filename collision on macOS and Windows.
-->
<script lang="ts">
	import type {ComponentProps} from 'svelte';
	import Modal from './Modal.svelte';
	type ModalProps = ComponentProps<typeof Modal>;

	interface Props extends Omit<ModalProps, 'title' | 'description'> {
		title: string;
		cancel?:
			| {
					label?: string;
					onclick?: () => void;
					disabled?: boolean;
			  }
			| true;
		confirm?: {
			label?: string;
			onclick: () => void;
			disabled?: boolean;
		};
	}

	let {children, title, cancel, confirm, ...rest}: Props = $props();
</script>

<Modal {...rest}>
	{#snippet title()}
		{title}
	{/snippet}

	<article>
		{@render children?.()}
	</article>
	<footer class="flex flex-wrap justify-end gap-4">
		{#if cancel}
			<button
				disabled={typeof cancel === 'object' && cancel.disabled}
				type="button"
				class="btn preset-tonal"
				onclick={typeof cancel === 'object' && cancel.onclick
					? cancel.onclick
					: rest.onCancel}
				>{#if typeof cancel === 'object' && cancel.label}{cancel.label}{:else}Cancel{/if}</button
			>
		{/if}
		{#if confirm}
			<button
				disabled={confirm.disabled}
				type="button"
				class="btn preset-filled"
				onclick={confirm.onclick}
				>{#if confirm.label}{confirm.label}{:else}Confirm{/if}</button
			>
		{/if}
	</footer>
</Modal>
