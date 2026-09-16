/**
 * Where a pending round is kept between page loads.
 *
 * The stake is real, so losing this file's contents costs the player money:
 * without the secret, a commitment cannot be opened and the bond is forfeited
 * by `acknowledgeMissedReveal`. Everything here is written with that in mind.
 *
 * Scoped to chain + contract + player, so that switching account or network
 * cannot surface someone else's pending round (which would then fail to reveal
 * and look like a bug in the contract).
 */
import type {RoundStorage, PersistedRound} from '$lib/game/core/round';
import type {GameIdentity} from '$lib/game/identity';
import type {Placement} from './commit-reveal';

const PREFIX = '__placement_round__';

/**
 * THE ON-DISK SHAPE, AND IT DELIBERATELY STILL SAYS `epoch`.
 *
 * This type and the key above are a COMPATIBILITY SURFACE with a stake behind
 * it, which is what makes them the one exception to the `epoch` -> `cycle`
 * rename. A record written by the previous build is read by this one, and a
 * record this build cannot read is discarded by `load()` - so renaming the
 * field or the key would orphan a commitment in flight, losing the secret that
 * opens it and the bond with it.
 *
 * The failure is silent in the worst way: every suite stays green, because the
 * tests are renamed alongside the code and nothing here reads a record written
 * by an older build. It would be found by a player, at their own expense.
 *
 * The argument that the ABI was free to rename does NOT transfer here. That one
 * rests on nothing being deployed with users; a browser's local storage is a
 * developer's browser too, and this is a template that ships to games which
 * will have users.
 *
 * So the in-memory name moved and the serialised name did not, and the two are
 * mapped explicitly in `load()` and `save()` below. STEP 4 OWNS CHANGING THIS,
 * as a deliberate migrating read - accept the old shape, write the new, drop
 * the tolerance a release later - rather than as a side effect of a sweep.
 *
 * A MECHANICAL RE-RUN OF THE STEP 3 SWEEP REVERSES THIS, and does it silently.
 * The exception is a judgement no mapping file encodes, so it was verified by
 * running the sweep a second time and watching this file - and only this file -
 * come back. If you are re-running a rename over this tree, this is the line to
 * look at afterwards.
 */
type StoredRound = {
	epoch: number;
	/** bigint has no JSON representation, so cell ids travel as strings. */
	actions: string[];
	secret: `0x${string}`;
	committed: boolean;
};

/**
 * Scoped to chain + contract + WHO PLAYS.
 *
 * The last part is the identity rather than the account, which is the whole
 * difference between one pending round per account and one per thing the
 * account plays with. A game that keys by a token and scoped this by the
 * account instead would load the previous token's planned actions and commit
 * them for the next one.
 */
export function roundStorageKey(params: {
	chainID: string | number;
	gameAddress: string;
	player: GameIdentity;
}): string {
	return `${PREFIX}${params.chainID}_${params.gameAddress}_${params.player}`.toLowerCase();
}

/**
 * A `RoundStorage` backed by localStorage.
 *
 * Every operation is defensive: storage can be full, disabled, or hold
 * something from an older version of the app. A throw from here during a commit
 * would be the worst possible time for one, so failures degrade to "no pending
 * round" instead. The one case that is NOT swallowed is a failed write, which
 * is surfaced through `onWriteFailure` so the game can refuse to commit rather
 * than commit something it will not be able to open.
 */
export function createRoundStorage(params: {
	key: string;
	onWriteFailure?: (error: unknown) => void;
}): RoundStorage<Placement> {
	const {key} = params;

	return {
		load() {
			if (typeof localStorage === 'undefined') return undefined;
			try {
				const raw = localStorage.getItem(key);
				if (!raw) return undefined;
				const stored = JSON.parse(raw) as StoredRound;
				if (
					typeof stored?.epoch !== 'number' ||
					!Array.isArray(stored.actions) ||
					typeof stored.secret !== 'string'
				) {
					return undefined;
				}
				return {
					// `epoch` on disk, `cycleNumber` in memory: see {@link StoredRound}.
					// The old name is the one a record in flight was written with.
					cycleNumber: stored.epoch,
					actions: stored.actions.map((cellID) => ({cellID: BigInt(cellID)})),
					secret: stored.secret,
					committed: !!stored.committed,
				} satisfies PersistedRound<Placement>;
			} catch {
				// Unparseable is indistinguishable from absent as far as what can be
				// done about it, and throwing here would break the whole game.
				return undefined;
			}
		},

		save(round) {
			if (typeof localStorage === 'undefined') return;
			const stored: StoredRound = {
				// Written back under the name the previous build reads. See
				// {@link StoredRound}: changing it costs a player their stake.
				epoch: round.cycleNumber,
				actions: round.actions.map((placement) => placement.cellID.toString()),
				secret: round.secret,
				committed: round.committed,
			};
			try {
				localStorage.setItem(key, JSON.stringify(stored));
			} catch (error) {
				params.onWriteFailure?.(error);
			}
		},

		clear() {
			if (typeof localStorage === 'undefined') return;
			try {
				localStorage.removeItem(key);
			} catch {
				// Nothing useful to do; a stale entry is handled on load by the
				// round, which discards anything from a past cycle.
			}
		},
	};
}

/** A storage that keeps nothing, for SSR and for a disconnected player. */
export const noRoundStorage: RoundStorage<Placement> = {
	load: () => undefined,
	save: () => {},
	clear: () => {},
};
