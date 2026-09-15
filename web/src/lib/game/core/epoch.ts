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
 * THREE POLICIES, AND ONLY THE FIRST IS PURE ARITHMETIC:
 *
 * - `timed` follows the chain clock and nothing else, which is what a deployed
 *   game does. The formula above IS the answer.
 * - `manual` has no clock at all: the round moves when the players have all
 *   acted and someone pushes it, so the only way to know where it is is to ask.
 * - `hybrid` (timed with early advance) has the clock as a DEADLINE, with
 *   unanimity able to bring the next phase forward. The formula is then a
 *   FLOOR rather than an answer, because an advance is a transaction and no
 *   amount of arithmetic predicts one.
 *
 * Which is why, under the last two, the epoch is READ FROM THE CHAIN and the
 * local clock is only a predictor. Getting that the wrong way round is the
 * expensive mistake: a client that trusted its own arithmetic would let a
 * player plan into a window that had already closed, and the loss lands on the
 * stake rather than on the screen.
 */
import {optionalNumber, readNumber, type DeclaredValues} from './linked-data';
import {derived, get, type Readable} from 'svelte/store';
import type {ChainTimeStore} from './chain-time';

/**
 * How the round advances. The client's half of `UsingGameTypes.EpochPolicy`.
 *
 * DECLARED BY THE DEPLOYMENT, never inferred. It used to be inferred, on both
 * sides: a game whose two phase durations were zero was a manual game, and was
 * also a game that skipped its commit phase, because one derivation stood for
 * two unrelated things. That is what made this look like a mode rather than a
 * policy.
 */
export type EpochPolicy = 'timed' | 'manual' | 'hybrid';

export type EpochConfig = {
	commitPhaseDuration: number;
	revealPhaseDuration: number;
	startTime: number;
	/**
	 * Margin at the end of the commit phase during which the UI stops accepting
	 * new moves, so a commit still has time to land before the phase closes.
	 */
	commitTimeAllowance: number;
	/** How the round advances. See {@link EpochPolicy}. */
	policy: EpochPolicy;
};

export type EpochConfigStore = Readable<EpochConfig> & {
	readonly current: EpochConfig;
};

type BaseEpochInfo = {
	currentEpoch: number;
	isCommitPhase: boolean;
	config: EpochConfig;
};

/** Everything a countdown needs, and what every clocked policy can answer. */
type EpochTimings = {
	timeLeftInEpoch: number;
	timeInCurrentEpochCycle: number;
	timeLeftInPhase: number;
	timeLeftForCommitEnd: number;
	timeLeftForRevealEnd: number;
	currentPhaseDuration: number;
	/**
	 * Chain time at which THIS epoch's reveal phase opens, or opened.
	 *
	 * What an outside scheduler is told at commit time, and the reason it is a
	 * value rather than something a caller recomputes: under `hybrid` an early
	 * advance moves the epoch's origin, so the same arithmetic run against the
	 * deployment's start time answers for a grid the chain has left behind.
	 */
	revealOpensAt: number;
};

export type TimedEpochInfo = BaseEpochInfo & {type: 'timed'} & EpochTimings;

/**
 * The clock as a deadline, with unanimity able to bring a phase forward.
 *
 * Carries the same timings as `timed` on purpose: everything that draws a
 * countdown works unchanged, because an early advance changes WHEN a phase runs
 * and never what a phase is.
 */
export type HybridEpochInfo = BaseEpochInfo & {type: 'hybrid'} & EpochTimings;

/** A chain where epochs only move when someone pushes them. No clock to read. */
export type ManualEpochInfo = BaseEpochInfo & {type: 'manual'};

export type EpochInfo = TimedEpochInfo | HybridEpochInfo | ManualEpochInfo;

/** An epoch info that has a clock behind it, whichever of the two it is. */
export type ClockedEpochInfo = TimedEpochInfo | HybridEpochInfo;

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
		revealOpensAt: revealPhaseStartTime(config, currentEpoch),
		config,
	};
}

function threePhaseFrom(info: ClockedEpochInfo): ThreePhase {
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
		// The store is built from calculateEpochInfo, so it is always timed.
		($epochInfo): TwoPhase => twoPhaseFrom($epochInfo as TimedEpochInfo),
	);

	return {epochInfo, twoPhase};
}

/**
 * Play against wait, for the simple indicators.
 *
 * Shared by both clocked policies rather than written twice: what a phase MEANS
 * to a player is the same under either, and only when it runs differs.
 */
function twoPhaseFrom(info: ClockedEpochInfo): TwoPhase {
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
}

/**
 * WHERE THE CHAIN SAYS THE ROUND IS. The contract's `getRound`, as read.
 *
 * `phaseStart` and `phaseEnd` are chain time. They are what make a prediction
 * possible at all: the pair says which grid the round is currently on, and
 * under `hybrid` that grid moves when somebody advances early.
 */
export type RoundReading = {
	epoch: number;
	isCommitPhase: boolean;
	phaseStart: number;
	phaseEnd: number;
};

/**
 * Which of two readings is FURTHER ON.
 *
 * The ordering is (epoch, then commit before reveal), and it is total because a
 * round only ever moves one way. Used to combine what the chain last said with
 * what the clock has since predicted, and the direction matters: the prediction
 * is a floor, so the answer is whichever is later. Reversing it would let a
 * stale reading pull a phase backwards on screen - and a board that says
 * "commit phase" after the chain has closed it invites a player to plan a turn
 * that cannot be sent.
 */
function laterReading(a: RoundReading, b: RoundReading): RoundReading {
	if (a.epoch !== b.epoch) return a.epoch > b.epoch ? a : b;
	if (a.isCommitPhase === b.isCommitPhase) return a;
	return a.isCommitPhase ? b : a;
}

/**
 * Roll a known round forward on the clock alone.
 *
 * PURE, AND DELIBERATELY BLIND TO EARLY ADVANCE: an advance is a transaction,
 * so nothing here can know about one. What this produces is the round the chain
 * would be in if nobody pushed it, which is the FLOOR that {@link laterReading}
 * combines with the last real answer.
 *
 * The reading's own phase bounds are the anchor rather than the deployment's
 * start time, because under `hybrid` an early advance re-origins the grid, and
 * arithmetic run from the deployment would answer for a schedule the chain has
 * already left.
 */
export function predictRound(
	reading: RoundReading,
	now: number,
	config: EpochConfig,
): RoundReading {
	const epochDuration = config.commitPhaseDuration + config.revealPhaseDuration;
	const epochStart = reading.isCommitPhase
		? reading.phaseStart
		: reading.phaseEnd - epochDuration;
	const elapsed = now - epochStart;
	// A clock behind the reading predicts nothing; the reading stands.
	if (!(elapsed >= 0)) return reading;

	const epochsPassed = Math.floor(elapsed / epochDuration);
	const cycleStart = epochStart + epochsPassed * epochDuration;
	const inCycle = elapsed - epochsPassed * epochDuration;
	const isCommitPhase = inCycle < config.commitPhaseDuration;
	return {
		epoch: reading.epoch + epochsPassed,
		isCommitPhase,
		phaseStart: isCommitPhase
			? cycleStart
			: cycleStart + config.commitPhaseDuration,
		phaseEnd: isCommitPhase
			? cycleStart + config.commitPhaseDuration
			: cycleStart + epochDuration,
	};
}

/** The timings a countdown needs, from a round the chain has confirmed. */
export function timingsOf(
	reading: RoundReading,
	now: number,
	config: EpochConfig,
): EpochTimings {
	const epochDuration = config.commitPhaseDuration + config.revealPhaseDuration;
	const epochStart = reading.isCommitPhase
		? reading.phaseStart
		: reading.phaseEnd - epochDuration;
	const timeLeftInPhase = reading.phaseEnd - now;
	const timeLeftInEpoch = reading.isCommitPhase
		? timeLeftInPhase + config.revealPhaseDuration
		: timeLeftInPhase;
	return {
		timeLeftInEpoch,
		timeInCurrentEpochCycle: now - epochStart,
		timeLeftInPhase,
		timeLeftForCommitEnd: reading.isCommitPhase ? timeLeftInPhase : 0,
		timeLeftForRevealEnd: timeLeftInEpoch,
		// The window as it actually stands, which an early open WIDENS. Reporting
		// the nominal duration instead would make the dial jump backwards the
		// moment somebody advanced.
		currentPhaseDuration: reading.phaseEnd - reading.phaseStart,
		// Already open, or opening when the commit phase closes - which is the
		// LATEST it can open, and therefore the moment a scheduler should be
		// told: an early advance can only bring it forward, and a reveal that
		// turns up later than the window opened is still inside it.
		revealOpensAt: reading.isCommitPhase
			? reading.phaseEnd
			: reading.phaseStart,
	};
}

/**
 * Epochs that follow the clock, and can be brought forward by unanimity.
 *
 * THE CHAIN IS THE ANSWER AND THE CLOCK IS A PREDICTOR, which is the whole
 * shape of this policy on the client. Polling alone would show a phase up to
 * one interval late, and arithmetic alone cannot see an advance at all, so it
 * does both and publishes whichever is FURTHER ON. The prediction can only ever
 * be behind, because the only thing it cannot model is a phase opening EARLY.
 */
export function createHybridEpochTrackers(params: {
	chainTime: ChainTimeStore;
	config: EpochConfigStore;
	/** Reads the round from the game contract. */
	readRound: () => Promise<RoundReading>;
	/** How often to re-read. Defaults to one second. */
	pollInterval?: number;
}): {
	epochInfo: EpochInfoStore;
	twoPhase: Readable<TwoPhase>;
	refresh: () => Promise<void>;
} {
	const {chainTime, config, readRound} = params;
	const pollInterval = params.pollInterval ?? 1000;

	/**
	 * The furthest-on round anyone has established, from either source.
	 *
	 * Kept as a floor rather than replaced, so a lagging RPC node answering for
	 * a block behind cannot walk the round backwards. The chain is monotone;
	 * the answers about it are not always.
	 */
	let known: RoundReading | undefined;

	const subscribers = new Set<(value: EpochInfo) => void>();
	let timer: ReturnType<typeof setInterval> | undefined;
	let published: EpochInfo | undefined;

	function infoAt(time: number): HybridEpochInfo {
		const $config = config.current;
		if (!known) {
			// Nothing has been read yet. The deployment's own grid is the best
			// floor there is, and it is exactly the timed answer - which is what
			// this policy degrades to when nobody has advanced anything.
			const timed = calculateEpochInfo(time, $config);
			return {...timed, type: 'hybrid'};
		}
		const reading = laterReading(known, predictRound(known, time, $config));
		return {
			type: 'hybrid',
			currentEpoch: reading.epoch,
			isCommitPhase: reading.isCommitPhase,
			...timingsOf(reading, time, $config),
			config: $config,
		};
	}

	function publish() {
		published = infoAt(chainTime.now());
		for (const run of subscribers) run(published);
	}

	async function refresh() {
		const reading = await readRound();
		known = known ? laterReading(known, reading) : reading;
		publish();
	}

	const _clock = derived([chainTime, config], ([$chainTime]) => $chainTime);

	const epochInfo: EpochInfoStore = {
		subscribe(run) {
			subscribers.add(run);
			run(published ?? infoAt(chainTime.now()));
			// The clock drives the countdown between reads, so the dial is smooth
			// even though the authority arrives once a second.
			const stopClock = _clock.subscribe(() => publish());
			if (typeof window !== 'undefined' && !timer) {
				void refresh();
				timer = setInterval(() => void refresh(), pollInterval);
			}
			return () => {
				subscribers.delete(run);
				stopClock();
				if (subscribers.size === 0 && timer) {
					clearInterval(timer);
					timer = undefined;
				}
			};
		},
		now: () => infoAt(chainTime.now()),
		fromTime: (time: number) => infoAt(time),
	};

	const twoPhase = derived<Readable<EpochInfo>, TwoPhase>(
		epochInfo,
		($epochInfo): TwoPhase => twoPhaseFrom($epochInfo as HybridEpochInfo),
	);

	return {epochInfo, twoPhase, refresh};
}

/**
 * Epochs that only move when the contract is told to move them.
 *
 * There is no clock to read, so the current epoch has to be polled from the
 * chain. What a game with no timer at all uses, and what local testing and
 * single-player debugging want, where waiting out a real commit phase would
 * make every test slow.
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

/**
 * The policy, in the order the contract's enum declares it.
 *
 * A number crosses the boundary because a Solidity enum is a number, so the
 * ORDER here is load-bearing in the same way the contract's is.
 */
const POLICY_BY_VALUE: readonly EpochPolicy[] = ['timed', 'manual', 'hybrid'];

/** Read the epoch configuration off the deployment's linked data. */
export function resolveEpochConfig(linkedData: {
	commitPhaseDuration: unknown;
	revealPhaseDuration: unknown;
	startTime?: unknown;
	epochPolicy?: unknown;
}): EpochConfig {
	// READ, not coerced. `Number(undefined)` is `NaN`, and a NaN phase duration
	// makes every comparison against the clock false, so the epoch simply stops
	// advancing and nothing is ever raised: the app sits on one round forever
	// with no error to go on. See `./linked-data.ts`.
	const values = linkedData as DeclaredValues;
	const revealPhaseDuration = readNumber(values, 'revealPhaseDuration');
	return {
		commitPhaseDuration: readNumber(values, 'commitPhaseDuration'),
		revealPhaseDuration,
		// A deployment that declares no start time started at the epoch, which is
		// a real answer rather than a guess at a missing one.
		startTime: optionalNumber(values, 'startTime') ?? 0,
		// A commit needs to land before the phase closes; the reveal phase is a
		// safe upper bound on how long that takes on these chains.
		commitTimeAllowance: revealPhaseDuration + 0.1,
		policy: resolvePolicy(values),
	};
}

/**
 * Which policy the deployment declared, or which one it had before it could.
 *
 * A DEPLOYMENT THAT DECLARES NONE IS OLDER THAN THE PARAMETER, and what it ran
 * is a fact rather than a guess: there was one rule, and it read the policy off
 * the durations - both zero meant the round had to be pushed, anything else
 * meant the clock decided. Reproducing that is the honest answer for such a
 * deployment, and it is the one thing here that may NOT be tidied into "assume
 * timed": a manual deployment read as timed would divide by a zero epoch and
 * put the client on a clock the chain is not running.
 *
 * It is emphatically not the reading for a NEW deployment. Declaring the policy
 * is what stopped two unrelated things sharing one derivation, and the
 * contract now refuses a configuration where the durations disagree with the
 * policy, so the two can never drift apart again.
 */
function resolvePolicy(values: DeclaredValues): EpochPolicy {
	const declared = optionalNumber(values, 'epochPolicy');
	if (declared !== undefined) {
		const policy = POLICY_BY_VALUE[declared];
		if (!policy) {
			throw new Error(
				`The deployment declares an epochPolicy of ${declared}, which this build does not know. ` +
					`It understands ${POLICY_BY_VALUE.join(', ')}; check the app is as new as the contract.`,
			);
		}
		return policy;
	}
	return readNumber(values, 'commitPhaseDuration') === 0 &&
		readNumber(values, 'revealPhaseDuration') === 0
		? 'manual'
		: 'timed';
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
			if ($epochInfo.type !== 'manual') {
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
 * THE TRACKER THIS DEPLOYMENT'S POLICY CALLS FOR.
 *
 * One call site rather than three, because which tracker to build is not a
 * decision an app should be making: the deployment already made it, and a game
 * that picked its own would be drawing a clock the chain is not running.
 *
 * `readRound` is only used by the policies that need it. The timed one asks the
 * chain nothing at all, which is the point of it.
 */
export function createEpochTrackers(params: {
	chainTime: ChainTimeStore;
	config: EpochConfigStore;
	readRound: () => Promise<RoundReading>;
	pollInterval?: number;
}): {epochInfo: EpochInfoStore; twoPhase: Readable<TwoPhase>} {
	switch (params.config.current.policy) {
		case 'manual':
			return createManualEpochTrackers({
				config: params.config,
				pollInterval: params.pollInterval,
				readEpoch: async () => {
					const round = await params.readRound();
					return {epoch: round.epoch, committing: round.isCommitPhase};
				},
			});
		case 'hybrid':
			return createHybridEpochTrackers(params);
		case 'timed':
			return createTimedEpochTrackers(params);
	}
}

/**
 * Chain time, in seconds, at which the reveal phase of an epoch opens.
 *
 * The inverse of the epoch formula, and the thing a scheduler is told at commit
 * time. Read it off the epoch info (`revealOpensAt`) rather than calling this
 * directly unless the epoch you are asking about is on the deployment's
 * ORIGINAL grid: under `hybrid` an early advance re-origins it, and this
 * function has no way to know.
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
