/**
 * The loot panel's model (step R1a): `../loot.ts` decides every word, this
 * only gathers the stores it reads, for `LootPanel.svelte`.
 */
import {derived, readable, type Readable} from 'svelte/store';
import type {Context} from '$lib/context/types';
import {formatBalance} from '$lib/core/utils/format/balance';
import {lootModel, lootPanelOf, type LootPanel} from '../loot';
import type {WorldTableState} from '../table';

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
			game.worldTable ??
				readable<WorldTableState>({step: 'Unloaded'} as WorldTableState),
		],
		([
			$model,
			$held,
			$bodies,
			$collectsLeft,
			$canPlan,
			$deposited,
			$avatarID,
			$table,
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
				// at a table, nothing leaves between its start and its close, and a
				// survivor's winnings are the table panel's (stratagems' plan, R1b)
				atStartedTable:
					($table as WorldTableState).step === 'Loaded' &&
					($table as Extract<WorldTableState, {step: 'Loaded'}>).table.started,
				symbol,
				format: (value) => formatBalance(value),
			});
		},
	);
}
