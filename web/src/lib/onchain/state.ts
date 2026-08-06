/**
 * The onchain-state seam.
 *
 * The template defines the CONTRACT here (see `$lib/game/core/seams`) and ships
 * one implementation of it: a poller that reads the game contract on an
 * interval, scoped to what the camera can see. That is what a game with a large
 * world and cheap reads wants.
 *
 * It is deliberately not the only possible implementation. A game whose state
 * is better built by replaying events (stratagems does this, through a
 * client-side indexer) supplies its own store satisfying `OnchainStateStore`
 * and the rest of the app does not notice: the view layer, the RPC-health
 * banner and the refresh connector only ever see the contract.
 */
import type {
	TypedDeployments,
	TypedPublicClient,
} from '$lib/core/connection/types';
import {createPollingStore} from '$lib/core/connection/polling-store';
import type {CameraWatcher} from '$lib/game/render/camera';
import type {ChainTimeStore} from '$lib/game/core/chain-time';
import type {EpochInfoStore} from '$lib/game/core/epoch';
import type {OnchainStateStore} from '$lib/game/core/seams';
import {derived, type Readable} from 'svelte/store';

export type {
	OnchainStateStore,
	OnchainStateValue,
	OnchainStateStatus,
} from '$lib/game/core/seams';

/**
 * Reads state for a set of zones.
 *
 * A game implements this against its own getters: `getAvatarsInZone`,
 * `getStarSystems`, whatever it has. The framework only needs the epoch back,
 * so it can tell whether the answer is current.
 */
export type ZonesReader<TState> = (params: {
	zones: readonly bigint[];
	fromBlock: number;
	toBlock: number;
	expectedEpoch: number;
}) => Promise<(TState & {epoch: number}) | undefined>;

/** Maps a camera box to the zones a game wants loaded for it. */
export type ZonesForCamera = (camera: {
	x: number;
	y: number;
	width: number;
	height: number;
}) => bigint[];

/**
 * What the current fetch is scoped to.
 *
 * The epoch is part of the identity because the contract answers per-epoch: the
 * same zones at a new epoch is a different question, and the answer to the old
 * one is stale.
 */
type FetchScope = {
	zones: bigint[];
	epoch: number;
	averageBlockTime: number;
};

/** Stable identity, so panning inside the same zones does not refetch. */
function scopeKey(scope: FetchScope): string {
	return `${scope.epoch}:${scope.zones.join(',')}`;
}

const readableTrue: Readable<boolean> = {
	subscribe(run) {
		run(true);
		return () => {};
	},
};

/**
 * The polling implementation of the state seam.
 *
 * What is fetched follows the camera and the epoch, so both are folded into the
 * polling store's `source`: a pan or an epoch tick triggers an immediate
 * refetch, and the interval is only a safety net.
 *
 * Every precondition (chain time pinned, camera sized, gate open) lives in the
 * scope rather than as a throw inside the fetch. A throw is read as a FAILED
 * read: it feeds the RPC-health banner a false outage and starts exponential
 * backoff that nothing cancels until the scope changes, which shows up as a
 * blank world until the player happens to pan.
 */
export function createPollingOnchainState<TState>(params: {
	publicClient: TypedPublicClient;
	deployments: TypedDeployments;
	camera: CameraWatcher;
	epochInfo: EpochInfoStore;
	chainTime: ChainTimeStore;
	zonesForCamera: ZonesForCamera;
	read: ZonesReader<TState>;
	emptyState: () => TState;
	config?: {fetchInterval?: number};
	/** Chain reads only run while this is truthy (no RPC yet, wallet not connected). */
	fetchGate?: Readable<boolean>;
}): OnchainStateStore<TState> {
	const {
		publicClient,
		deployments,
		camera,
		epochInfo,
		chainTime,
		zonesForCamera,
		read,
		emptyState,
	} = params;

	const linkedData = deployments.contracts.Game.linkedData as {
		commitPhaseDuration: unknown;
		revealPhaseDuration: unknown;
	};
	const epochDuration =
		Number(linkedData.commitPhaseDuration) +
		Number(linkedData.revealPhaseDuration);

	const scope = derived<
		[CameraWatcher, EpochInfoStore, ChainTimeStore, Readable<boolean>],
		FetchScope | undefined
	>(
		[camera, epochInfo, chainTime, params.fetchGate ?? readableTrue],
		([$camera, $epochInfo, $chainTime, $gate]) => {
			if (!$gate) return undefined;
			// Chain time has to be pinned to a block before a span of seconds can
			// become a span of blocks. It lands a few hundred ms after startup.
			if (!$chainTime.lastSync) return undefined;
			// The camera has no size until the canvas has laid itself out.
			if ($camera.width <= 0 || $camera.height <= 0) return undefined;
			return {
				zones: zonesForCamera($camera),
				epoch: $epochInfo.currentEpoch,
				averageBlockTime: $chainTime.lastSync.averageBlockTime,
			};
		},
	);

	const store = createPollingStore<TState, FetchScope | undefined>(
		async (currentScope) => {
			if (!currentScope) return emptyState();

			// The contract answers over a block range; ask for roughly two epochs'
			// worth, doubled, so late blocks cannot hide an event.
			const toBlock = Number(await publicClient.getBlockNumber());
			const span = Math.floor(
				(4 * epochDuration) / currentScope.averageBlockTime,
			);
			const fromBlock = Math.max(0, toBlock - span);

			const result = await read({
				zones: currentScope.zones,
				fromBlock,
				toBlock,
				expectedEpoch: currentScope.epoch,
			});

			if (!result) {
				// Superseded: the epoch moved on while the read was in flight. A new
				// scope is already queued, so leave the value alone.
				throw new Error(
					`read superseded, epoch moved past ${currentScope.epoch}`,
				);
			}

			return result;
		},
		{
			fetchInterval: params.config?.fetchInterval ?? 5_000,
			source: {store: scope, key: (s) => (s ? scopeKey(s) : undefined)},
		},
	);

	// Narrow the polling store to the seam: callers get the contract, not the
	// implementation, so swapping in an indexer stays a local change.
	return {
		subscribe: store.subscribe,
		status: store.status,
		update: async () => {
			await store.update();
		},
	};
}
