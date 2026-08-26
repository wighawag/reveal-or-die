/**
 * Epochs: the commit-reveal round clock.
 *
 * This is framework, not a seam. Four independently written games (this one,
 * conquest, reveal-or-die, bomber-world and stratagems) compute the epoch the
 * same way, character for character:
 *
 *     epoch = floor(timePassed / epochDuration) + 2
 *     committing = timePassed - (epoch - 2) * epochDuration < commitPhaseDuration
 *
 * The `+ 2` is not arbitrary: the contract starts at epoch 2 so that the
 * hypothetical reveal phase before the first commit phase can be epoch 1.
 *
 * Two ways of advancing are supported, because a game needs both:
 * `timed` follows the chain clock, which is what a deployed game does;
 * `manual` advances only when someone calls the contract, which is what local
 * testing and single-player debugging need.
 */
import {derived, get, type Readable} from 'svelte/store';
import type {ChainTimeStore} from './chain-time';

export type EpochConfig = {
	commitPhaseDuration: number;
	revealPhaseDuration: number;
	startTime: number;
	/**
	 * Margin at the end of the commit phase during which the UI stops accepting
	 * new moves, so a commit still has time to land before the phase closes.
	 */
	commitTimeAllowance: number;
};

export type EpochConfigStore = Readable<EpochConfig> & {
	readonly current: EpochConfig;
};

type BaseEpochInfo = {
	currentEpoch: number;
	isCommitPhase: boolean;
	config: EpochConfig;
};

export type TimedEpochInfo = BaseEpochInfo & {
	type: 'timed';
	timeLeftInEpoch: number;
	timeInCurrentEpochCycle: number;
	timeLeftInPhase: number;
	timeLeftForCommitEnd: number;
	timeLeftForRevealEnd: number;
	currentPhaseDuration: number;
};

/** A chain where epochs only move when someone pushes them. No clock to read. */
export type ManualEpochInfo = BaseEpochInfo & {type: 'manual'};

export type EpochInfo = TimedEpochInfo | ManualEpochInfo;

export type EpochInfoStore = Readable<EpochInfo> & {
	now(): EpochInfo;
	fromTime(time: number): EpochInfo;
};

/**
 * The player-facing phase.
 *
 * The contract has two phases; the player sees three, because the tail of the
 * commit phase is a "your commit is landing, moves are locked" window rather
 * than playable time. `twoPhase` collapses that back to play / wait for simple
 * indicators.
 */
export type ThreePhase = {
	phase: 'play' | 'commit' | 'reveal';
	timeLeft: number;
	duration: number;
};

export type TwoPhase =
	| {type: 'timed'; phase: 'play' | 'wait'; timeLeft: number; duration: number}
	| {type: 'manual'; phase: 'play' | 'wait'};

export function calculateEpochInfo(
	currentTime: number,
	config: EpochConfig,
): TimedEpochInfo {
	const commitPhaseDuration = config.commitPhaseDuration;
	const revealPhaseDuration = config.revealPhaseDuration;
	const epochDuration = commitPhaseDuration + revealPhaseDuration;
	const startTime = config.startTime || 0;

	const timePassed = currentTime - startTime;

	// Epochs start at 2 (see the file comment).
	const currentEpoch = Math.floor(timePassed / epochDuration) + 2;

	const timeInCurrentEpochCycle =
		timePassed - (currentEpoch - 2) * epochDuration;
	const timeLeftInEpoch = epochDuration - timeInCurrentEpochCycle;
	const isCommitPhase = timeInCurrentEpochCycle < commitPhaseDuration;

	return {
		type: 'timed',
		currentEpoch,
		isCommitPhase,
		timeLeftInEpoch,
		timeInCurrentEpochCycle,
		timeLeftInPhase: isCommitPhase
			? commitPhaseDuration - timeInCurrentEpochCycle
			: revealPhaseDuration - (timeInCurrentEpochCycle - commitPhaseDuration),
		timeLeftForCommitEnd: isCommitPhase
			? commitPhaseDuration - timeInCurrentEpochCycle
			: 0,
		timeLeftForRevealEnd: timeLeftInEpoch,
		currentPhaseDuration: isCommitPhase
			? commitPhaseDuration
			: revealPhaseDuration,
		config,
	};
}

function threePhaseFrom(info: TimedEpochInfo): ThreePhase {
	const config = info.config;
	let phase: 'play' | 'commit' | 'reveal' = 'reveal';
	let timeLeft = info.timeLeftInPhase;
	let duration = info.currentPhaseDuration;

	if (info.isCommitPhase) {
		phase = 'play';
		if (info.timeLeftInPhase < config.commitTimeAllowance) {
			phase = 'commit';
			duration = config.commitTimeAllowance;
		} else {
			duration -= config.commitTimeAllowance;
			timeLeft -= config.commitTimeAllowance;
		}
	}
	return {phase, timeLeft, duration};
}

/** Epochs that follow the chain clock. What a deployed game uses. */
export function createTimedEpochTrackers(params: {
	chainTime: ChainTimeStore;
	config: EpochConfigStore;
}): {epochInfo: EpochInfoStore; twoPhase: Readable<TwoPhase>} {
	const {chainTime, config} = params;

	const _epochInfo = derived([chainTime, config], ([$chainTime, $config]) =>
		calculateEpochInfo($chainTime.value, $config),
	);

	const epochInfo: EpochInfoStore = {
		subscribe: _epochInfo.subscribe,
		now: () => calculateEpochInfo(chainTime.now(), config.current),
		fromTime: (time: number) => calculateEpochInfo(time, config.current),
	};

	const twoPhase = derived<Readable<EpochInfo>, TwoPhase>(
		epochInfo,
		($epochInfo): TwoPhase => {
			// The store is built from calculateEpochInfo, so it is always timed.
			const info = $epochInfo as TimedEpochInfo;
			const three = threePhaseFrom(info);
			const config = info.config;

			let phase: 'play' | 'wait' = 'play';
			let timeLeft = three.timeLeft;
			let duration = three.duration;

			if (three.phase === 'commit') {
				phase = 'wait';
				timeLeft = three.timeLeft + config.revealPhaseDuration;
				duration = three.duration + config.revealPhaseDuration;
			}
			if (three.phase === 'reveal') {
				phase = 'wait';
				duration = three.duration + config.commitTimeAllowance;
			}
			return {type: 'timed', phase, timeLeft, duration};
		},
	);

	return {epochInfo, twoPhase};
}

/**
 * Epochs that only move when the contract is told to move them.
 *
 * There is no clock to read, so the current epoch has to be polled from the
 * chain. Used for local testing and single-player debugging, where waiting out
 * a real commit phase would make every test slow.
 */
export function createManualEpochTrackers(params: {
	config: EpochConfigStore;
	/** Reads (epoch, committing) from the game contract. */
	readEpoch: () => Promise<{epoch: number; committing: boolean}>;
	/** How often to re-read. Defaults to one second. */
	pollInterval?: number;
}): {
	epochInfo: EpochInfoStore;
	twoPhase: Readable<TwoPhase>;
	refresh: () => Promise<void>;
} {
	const {config, readEpoch} = params;
	const pollInterval = params.pollInterval ?? 1000;

	let $info: ManualEpochInfo = {
		type: 'manual',
		currentEpoch: 2,
		isCommitPhase: true,
		config: config.current,
	};

	const subscribers = new Set<(value: EpochInfo) => void>();
	let timer: ReturnType<typeof setInterval> | undefined;

	function publish() {
		for (const run of subscribers) run($info);
	}

	async function refresh() {
		const {epoch, committing} = await readEpoch();
		if (epoch === $info.currentEpoch && committing === $info.isCommitPhase) {
			return;
		}
		$info = {
			type: 'manual',
			currentEpoch: epoch,
			isCommitPhase: committing,
			config: config.current,
		};
		publish();
	}

	const epochInfo: EpochInfoStore = {
		subscribe(run) {
			subscribers.add(run);
			run($info);
			// Off-browser (SSR / prerender) nothing polls: a server render must
			// not perform IO or leave a timer behind.
			if (typeof window !== 'undefined' && !timer) {
				void refresh();
				timer = setInterval(() => void refresh(), pollInterval);
			}
			return () => {
				subscribers.delete(run);
				if (subscribers.size === 0 && timer) {
					clearInterval(timer);
					timer = undefined;
				}
			};
		},
		now: () => $info,
		// A manual chain has no notion of "the epoch at time t": it is wherever
		// the contract currently says it is.
		fromTime: () => $info,
	};

	const twoPhase = derived<Readable<EpochInfo>, TwoPhase>(
		epochInfo,
		($epochInfo): TwoPhase => ({
			type: 'manual',
			phase: $epochInfo.isCommitPhase ? 'play' : 'wait',
		}),
	);

	return {epochInfo, twoPhase, refresh};
}

/** Read the epoch configuration off the deployment's linked data. */
export function resolveEpochConfig(linkedData: {
	commitPhaseDuration: unknown;
	revealPhaseDuration: unknown;
	startTime?: unknown;
}): EpochConfig {
	const revealPhaseDuration = Number(linkedData.revealPhaseDuration);
	return {
		commitPhaseDuration: Number(linkedData.commitPhaseDuration),
		revealPhaseDuration,
		startTime: Number(linkedData.startTime ?? 0),
		// A commit needs to land before the phase closes; the reveal phase is a
		// safe upper bound on how long that takes on these chains.
		commitTimeAllowance: revealPhaseDuration + 0.1,
	};
}

/** A config that never changes, which is the common case. */
export function staticEpochConfig(config: EpochConfig): EpochConfigStore {
	return {
		get current() {
			return config;
		},
		subscribe(run) {
			run(config);
			return () => {};
		},
	};
}

/** Convenience for consumers that want the three-phase view. */
export function createThreePhase(
	epochInfo: EpochInfoStore,
): Readable<ThreePhase> {
	return derived<Readable<EpochInfo>, ThreePhase>(
		epochInfo,
		($epochInfo): ThreePhase => {
			if ($epochInfo.type === 'timed') {
				return threePhaseFrom($epochInfo);
			}
			// A manual chain has no countdown, only which phase it is in.
			const phase: ThreePhase['phase'] = $epochInfo.isCommitPhase
				? 'play'
				: 'reveal';
			return {phase, timeLeft: 0, duration: 0};
		},
	);
}

/** Read the current epoch without subscribing. */
export function currentEpochOf(store: EpochInfoStore): number {
	return get(store).currentEpoch;
}

/**
 * Chain time, in seconds, at which the reveal phase of an epoch opens.
 *
 * The inverse of the epoch formula. It exists because a game that schedules its
 * reveal with an outside service has to say WHEN, at commit time, before that
 * moment has arrived. Only meaningful for a timed chain; a manually advanced
 * one moves when someone pushes it, so there is nothing to predict.
 */
export function revealPhaseStartTime(
	config: EpochConfig,
	epoch: number,
): number {
	const epochDuration = config.commitPhaseDuration + config.revealPhaseDuration;
	return (
		config.startTime + (epoch - 2) * epochDuration + config.commitPhaseDuration
	);
}
