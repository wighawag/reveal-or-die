/**
 * The loot panel's model (step R1a): `../loot.ts` decides every word, this
 * only gathers the stores it reads, for `LootPanel.svelte`.
 */
import {derived, type Readable} from 'svelte/store';
import type {Context} from '$lib/context/types';
import {formatBalance} from '$lib/core/utils/format/balance';
import {lootModel, lootPanelOf, type LootPanel} from '../loot';

export function createLootPanel(context: Context): Readable<LootPanel> {
	const {game} = context;
	const symbol = context.deployments.get().chain.nativeCurrency.symbol;
	return derived(
		[
			lootModel(game.loot),
			game.loot.held,
			game.bodiesHere,
			game.planning.collectsLeft,
			game.planning.canPlan,
			game.deposited,
			game.activeIdentity,
		],
		([
			$model,
			$held,
			$bodies,
			$collectsLeft,
			$canPlan,
			$deposited,
			$avatarID,
		]) => {
			const mine =
				$deposited.step === 'Loaded' && $avatarID !== undefined
					? $deposited.avatars.find((a) => a.avatarID === $avatarID)
					: undefined;
			const outOfTheWorld =
				mine && !mine.inGame && mine.life > 0 ? mine.avatarID : undefined;
			return lootPanelOf({
				model: $model,
				held: $held,
				bodiesHere: $bodies,
				collectsLeft: $collectsLeft,
				canPlan: $canPlan,
				...(outOfTheWorld !== undefined ? {outOfTheWorld} : {}),
				symbol,
				format: (value) => formatBalance(value),
			});
		},
	);
}
