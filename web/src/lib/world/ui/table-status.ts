/**
 * The table's part of the HUD (stratagems' plan, step R1b): `../table.ts`
 * decides every word, this only gathers the stores it reads, for
 * `TableStatus.svelte` and the seat a held avatar can take.
 */
import {derived, readable, type Readable} from 'svelte/store';
import type {Context} from '$lib/context/types';
import {formatBalance} from '$lib/core/utils/format/balance';
import {
	MODE_LABELS,
	seatableHeld,
	tablePanel,
	type TablePanel,
	type WorldTableState,
} from '../table';
import {avatarLabel} from './hud';

export type TableStatus = {
	panel?: TablePanel;
	/** Held avatars a table before its start would seat, with their labels. */
	seatable: readonly {avatarID: bigint; label: string}[];
	/** What the table plays by, for its lobby: its mode and its stake. */
	details: readonly {label: string; value: string}[];
};

export function createTableStatus(context: Context): Readable<TableStatus> {
	const {game} = context;
	const table = game.worldTable;
	if (!table) return readable({seatable: [], details: []});
	const symbol = context.deployments.get().chain.nativeCurrency.symbol;
	const inCustody = derived(
		[game.deposited, game.activeIdentity],
		([$deposited, $seat]) =>
			$deposited.step === 'Loaded' &&
			$seat !== undefined &&
			$deposited.avatars.some((a) => a.avatarID === $seat),
	);
	const panel = tablePanel({
		table,
		seat: game.activeIdentity,
		inCustody,
		format: (value) => formatBalance(value),
		symbol,
	});
	return derived([panel, table, game.loot.held], ([$panel, $table, $held]) => ({
		...($panel ? {panel: $panel} : {}),
		seatable: seatableHeld($table as WorldTableState, $held).map(
			(avatarID) => ({
				avatarID,
				label: `Seat avatar ${avatarLabel(avatarID)}`,
			}),
		),
		details:
			$table.step === 'Loaded' && $table.table.mode
				? [
						{label: 'Seats', value: MODE_LABELS[$table.table.mode]},
						{
							label: 'Stake a seat',
							value: `${formatBalance($table.table.stake)} ${symbol}`,
						},
					]
				: [],
	}));
}
