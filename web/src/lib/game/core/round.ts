/**
 * The commit-reveal round.
 *
 * This is framework, not a seam. It owns the part every game on this template
 * shares: what the player has planned for this epoch, when that stops being
 * changeable, keeping the secret until it is time to disclose it, and getting
 * the reveal out. What it does NOT know is how to call the contract - that is
 * the `CommitRevealAdapter` the game supplies.
 *
 * Two things here are load-bearing rather than convenient.
 *
 * **The reveal is driven, not offered.** A missed reveal costs the player
 * whatever the game put at stake, and the reveal phase can be seconds long. A
 * UI that merely enables a button and hopes the player is watching would take
 * that for a mistake the machine could have avoided. So entering the reveal
 * phase with a live commitment sends the reveal, unless the game has arranged
 * for something else to (see `autoReveal`).
 *
 * What "at stake" means is the GAME's business, and it varies more than a
 * bonded token: this template forfeits a token bond, stratagems burns reserve,
 * and conquest and catacombs intend to dock levels from a character the player
 * paid for, which degrades their position rather than taking a deposit. The
 * framework only needs it to be true that not revealing costs something.
 *
 * **The secret is persisted before the commitment is sent, not after.** It is
 * the only thing that can open the commitment; if a reload can lose it, the
 * player is guaranteed to forfeit, and the window where that is possible is
 * exactly the moment the tab is busiest. Writing it first means the worst case
 * is a stored secret for a commitment that never landed, which is harmless.
 */
import {get, writable, type Readable} from 'svelte/store';
import type {CommitRevealAdapter, PlayerIdentity} from './seams';
import {revealPhaseStartTime, type EpochInfoStore} from './epoch';

/**
 * What has to survive a reload.
 *
 * Kept deliberately small and JSON-shaped: it is written to whatever storage
 * the game hands over, in the middle of a phase, and anything clever here is a
 * way to lose a secret.
 */
export type PersistedRound<TAction> = {
	epoch: number;
	actions: readonly TAction[];
	secret: `0x${string}`;
	/** Set once the commit transaction has been submitted. */
	committed: boolean;
};

/**
 * Where the pending round is kept between page loads.
 *
 * A port rather than a direct `localStorage` call: the round is constructed
 * during SSR too, and a game with an account system may want the round scoped
 * to the signed-in player rather than to the browser.
 */
export type RoundStorage<TAction> = {
	load(): PersistedRound<TAction> | undefined;
	save(round: PersistedRound<TAction>): void;
	clear(): void;
};

export type RoundState<TAction> =
	/** No player, or nothing planned yet this epoch. */
	| {step: 'Idle'}
	/** Actions chosen, still changeable. */
	| {step: 'Planning'; epoch: number; actions: readonly TAction[]}
	| {step: 'Committing'; epoch: number; actions: readonly TAction[]}
	/** The commitment is in; the reveal is owed this epoch. */
	| {step: 'Committed'; epoch: number; actions: readonly TAction[]}
	| {step: 'Revealing'; epoch: number; actions: readonly TAction[]}
	| {step: 'Revealed'; epoch: number}
	/**
	 * A commitment from an earlier epoch was never revealed. Whatever the game
	 * put at stake has been lost by its own rules (a burnt bond, a demoted
	 * character); the round cannot undo it, only report it.
	 */
	| {step: 'Missed'; epoch: number}
	| {
			step: 'Error';
			epoch: number;
			during: 'commit' | 'reveal';
			message: string;
			/**
			 * What actually failed, not just how it reads.
			 *
			 * Carried so a game can tell one failure from another and offer the
			 * matching remedy - a signer with no gas can be topped up and the move
			 * retried, a reverted commitment cannot. Classifying by matching on
			 * `message` would work until someone reworded it.
			 */
			error: unknown;
			actions: readonly TAction[];
	  };

export type RoundStore<TIdentity extends PlayerIdentity, TAction> = Readable<
	RoundState<TAction>
> & {
	readonly value: RoundState<TAction>;
	/** Replace what is planned for this epoch. Ignored once committed. */
	plan(actions: readonly TAction[]): void;
	/** Send the commitment now, rather than waiting for the phase to close. */
	commit(): Promise<void>;
	/** Send the reveal now. Normally the round does this itself. */
	reveal(): Promise<void>;
	/** Acknowledge a missed reveal, clearing it off the HUD. */
	dismiss(): void;
	/** Begin watching the epoch. Returns the teardown. */
	start(): () => void;
};

/**
 * The default secret: 32 random bytes.
 *
 * Safe, but not the only sensible choice, which is why `makeSecret` exists.
 * reveal-or-die, bomber-world and stratagems all DERIVE the secret instead,
 * from a signature over `Commit:<chainId>:<contract>:<epoch>` by a key the
 * player already holds. That is strictly better against the failure that costs
 * real money here: a random secret exists only in storage, so losing storage
 * loses the stake, while a derived one can be recomputed on another device from
 * the key alone.
 */
function randomSecret(): `0x${string}` {
	const bytes = new Uint8Array(32);
	// `crypto` is present in browsers and in Node 19+, which covers the app and
	// the test runner. A game that must run somewhere else supplies its own.
	crypto.getRandomValues(bytes);
	let hex = '0x';
	for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
	return hex as `0x${string}`;
}

export function createRound<TIdentity extends PlayerIdentity, TAction>(params: {
	epochInfo: EpochInfoStore;
	adapter: CommitRevealAdapter<TIdentity, TAction>;
	storage: RoundStorage<TAction>;
	/** Who is playing, or undefined when nobody is connected. */
	identity: Readable<TIdentity | undefined>;
	/**
	 * Send the commitment automatically when the commit phase is about to
	 * close. On by default: a game may prefer the player to press the button.
	 */
	autoCommit?: boolean;
	/**
	 * When this browser should send the reveal itself. Defaults to `immediately`.
	 *
	 * This is NOT a choice about whether the player may reveal: `reveal()` is
	 * always callable, and a third party can always reveal on their behalf (every
	 * one of these contracts takes the identity as an argument rather than using
	 * msg.sender, deliberately). It only decides what the round does on its own.
	 *
	 * - `immediately`: reveal as soon as the phase opens. Right for any game
	 *   whose round is short enough that the player is plausibly still there,
	 *   and for a hot-seat or single-machine setup where turns are simply waited
	 *   out.
	 * - `fallback`: something else is expected to reveal (a scheduler holding a
	 *   timelock-encrypted transaction, see `CommitRevealAdapter.commit`), but
	 *   this browser tries anyway once the phase is nearly over and the round is
	 *   still open. A duplicate reveal is cheap - the loser of the race reverts -
	 *   and a missed one is not, so trying is the right bias.
	 * - `never`: something else owns it entirely.
	 *
	 * A game on a 23h/1h commit/reveal split cannot expect anyone to be at the
	 * keyboard for the reveal hour, which is why stratagems and catacombs schedule
	 * it; a game whose epoch is minutes long can just do it here. Both remain the
	 * player's to trigger by hand.
	 */
	autoReveal?: 'immediately' | 'fallback' | 'never';
	/**
	 * How late into the reveal phase `autoReveal: 'fallback'` waits before trying
	 * anyway, as a fraction of the phase. Defaults to 0.5.
	 */
	fallbackRevealAfter?: number;
	/**
	 * Produce the secret for an epoch. Defaults to 32 random bytes.
	 *
	 * A game overrides this to DERIVE the secret from a key the player already
	 * holds, which makes a round recoverable after local storage is lost. See
	 * `randomSecret` above.
	 */
	makeSecret?: (params: {
		epoch: number;
	}) => `0x${string}` | Promise<`0x${string}`>;
	/**
	 * Called when a round completes, so the caller can refresh chain state.
	 *
	 * AWAITED before the round reports itself revealed, and that ordering is the
	 * whole point. The planned placements are drawn from the round, and the
	 * confirmed ones from the board; flipping to `Revealed` first would clear the
	 * planned overlay while the board was still a fetch behind, and the player
	 * would watch their moves vanish and then reappear. The data is already on
	 * chain at this point, so there is no reason to show a gap.
	 */
	onSettled?: () => void | Promise<void>;
}): RoundStore<TIdentity, TAction> {
	const {epochInfo, adapter, storage, identity} = params;
	const autoCommit = params.autoCommit ?? true;
	const autoReveal = params.autoReveal ?? 'immediately';
	const fallbackRevealAfter = params.fallbackRevealAfter ?? 0.5;
	const makeSecret = params.makeSecret ?? (() => randomSecret());

	let $state: RoundState<TAction> = {step: 'Idle'};
	const store = writable<RoundState<TAction>>($state);

	function set(next: RoundState<TAction>) {
		$state = next;
		store.set(next);
	}

	/** The actions of whatever round is currently in play, if any. */
	function currentActions(): readonly TAction[] {
		return 'actions' in $state ? $state.actions : [];
	}

	function currentIdentity(): TIdentity | undefined {
		return get(identity);
	}

	/**
	 * The epoch a plan made right now would be committed in.
	 *
	 * During the commit phase that is this epoch. During the REVEAL phase the
	 * commit window has closed, so anything planned now is for the next one.
	 * Stamping it that way is what stops it being thrown away as stale the moment
	 * the epoch turns over: a player who keeps clicking while the round resolves
	 * is planning ahead, not making a mistake.
	 */
	function epochBeingPlannedFor(): number {
		const info = epochInfo.now();
		return info.isCommitPhase ? info.currentEpoch : info.currentEpoch + 1;
	}

	function plan(actions: readonly TAction[]) {
		// Once the commitment is sent the actions are fixed: they are what the
		// hash is of, and what the reveal has to reproduce exactly.
		if (
			$state.step === 'Committing' ||
			$state.step === 'Committed' ||
			$state.step === 'Revealing'
		) {
			return;
		}
		const epoch = epochBeingPlannedFor();
		if (actions.length === 0) {
			// Nothing planned is the same as nothing pending, and a stored empty
			// round would only be a way to reveal nothing later.
			storage.clear();
			set({step: 'Idle'});
			return;
		}
		set({step: 'Planning', epoch, actions});
	}

	async function commit() {
		if ($state.step !== 'Planning' && $state.step !== 'Error') return;
		const actions = currentActions();
		if (actions.length === 0) return;

		const player = currentIdentity();
		if (!player) return;

		const info = epochInfo.now();
		if (!info.isCommitPhase) {
			// The commit phase closed while the player was deciding. Their moves
			// are kept, but this epoch is gone.
			return;
		}
		const epoch = info.currentEpoch;
		const secret = await makeSecret({epoch});
		const {hash} = adapter.buildCommitment({actions, secret});

		// Persisted BEFORE the call, so a reload during the wallet prompt cannot
		// leave a commitment nobody can open. See the file comment.
		storage.save({epoch, actions, secret, committed: false});

		set({step: 'Committing', epoch, actions});
		try {
			await adapter.commit({
				identity: player,
				hash,
				actions,
				secret,
				epoch,
				// A manually advanced chain has no clock, so there is no moment to
				// predict and nothing an outside scheduler could be told.
				revealDueAt:
					info.type === 'timed'
						? revealPhaseStartTime(info.config, epoch)
						: undefined,
			});
			storage.save({epoch, actions, secret, committed: true});
			set({step: 'Committed', epoch, actions});
		} catch (error) {
			// The commitment never went out, so nothing is at stake and the stored
			// round would only confuse the next load.
			storage.clear();
			set({
				step: 'Error',
				epoch,
				during: 'commit',
				message: messageOf(error),
				error,
				actions,
			});
		}
	}

	async function reveal() {
		const pending = storage.load();
		if (!pending || !pending.committed) return;
		if ($state.step === 'Revealing' || $state.step === 'Revealed') return;

		const player = currentIdentity();
		if (!player) return;

		const info = epochInfo.now();
		if (info.currentEpoch !== pending.epoch) {
			// Too late: the contract only accepts a reveal in the epoch that was
			// committed to.
			storage.clear();
			set({step: 'Missed', epoch: pending.epoch});
			return;
		}

		set({step: 'Revealing', epoch: pending.epoch, actions: pending.actions});
		try {
			await adapter.reveal({
				identity: player,
				actions: pending.actions,
				secret: pending.secret,
			});
			// Refresh FIRST, then report revealed: see the note on onSettled.
			try {
				await params.onSettled?.();
			} catch {
				// A failed refresh is not a failed reveal. The reveal is on chain
				// either way, and the poller will catch up on its own interval.
			}
			storage.clear();
			set({step: 'Revealed', epoch: pending.epoch});
		} catch (error) {
			// The stored round is deliberately KEPT: the reveal can be retried for
			// as long as the phase lasts, and dropping the secret here would
			// forfeit the stake over a rejected wallet prompt.
			set({
				step: 'Error',
				epoch: pending.epoch,
				during: 'reveal',
				message: messageOf(error),
				error,
				actions: pending.actions,
			});
		}
	}

	function dismiss() {
		if ($state.step === 'Missed' || $state.step === 'Revealed') {
			set({step: 'Idle'});
		}
	}

	/** Adopt whatever was left behind by a previous page load. */
	function restore() {
		const pending = storage.load();
		if (!pending) return;

		const info = epochInfo.now();
		if (pending.epoch === info.currentEpoch) {
			set(
				pending.committed
					? {step: 'Committed', epoch: pending.epoch, actions: pending.actions}
					: {step: 'Planning', epoch: pending.epoch, actions: pending.actions},
			);
			return;
		}

		// An older epoch. A committed round that was never revealed has already
		// cost the player; an uncommitted one costs nothing and is just dropped.
		storage.clear();
		if (pending.committed) {
			set({step: 'Missed', epoch: pending.epoch});
		}
	}

	function start() {
		restore();

		let previousEpoch: number | undefined;

		const unsubscribeEpoch = epochInfo.subscribe(($info) => {
			const epochChanged =
				previousEpoch !== undefined && $info.currentEpoch !== previousEpoch;
			previousEpoch = $info.currentEpoch;

			if (epochChanged) {
				if ($state.step === 'Committed' || $state.step === 'Revealing') {
					// The epoch turned over with a commitment still open: the reveal
					// window is gone.
					storage.clear();
					set({step: 'Missed', epoch: $state.epoch});
				} else if ($state.step === 'Planning' || $state.step === 'Error') {
					// A plan made during the reveal phase was stamped for THIS epoch,
					// which has just begun, so it is not stale and must survive. Only
					// drop a plan whose commit window has actually gone by.
					if ($state.epoch < $info.currentEpoch) {
						storage.clear();
						set({step: 'Idle'});
					}
				}
			}

			// Tested as a CONDITION, not as a transition into the reveal phase: a
			// page loaded (or a wallet connected) part-way through that phase has no
			// transition to observe, and owes a reveal just the same.
			if (!$info.isCommitPhase && $state.step === 'Committed') {
				if (autoReveal === 'immediately') {
					void reveal();
				} else if (autoReveal === 'fallback' && $info.type === 'timed') {
					// Whoever was supposed to do this has had most of the phase. The
					// round is still open, so try: a duplicate reveal costs one
					// reverted transaction, a missed one costs the stake.
					const elapsed =
						1 - $info.timeLeftInPhase / $info.config.revealPhaseDuration;
					if (elapsed >= fallbackRevealAfter) void reveal();
				}
			}

			if (
				autoCommit &&
				$info.type === 'timed' &&
				$info.isCommitPhase &&
				$state.step === 'Planning' &&
				$info.timeLeftForCommitEnd <= $info.config.commitTimeAllowance
			) {
				void commit();
			}
		});

		return () => unsubscribeEpoch();
	}

	return {
		get value() {
			return $state;
		},
		subscribe: store.subscribe,
		plan,
		commit,
		reveal,
		dismiss,
		start,
	};
}

function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
