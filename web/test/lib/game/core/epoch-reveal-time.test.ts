import {describe, expect, it} from 'vitest';
import {
	calculateEpochInfo,
	revealPhaseStartTime,
	type EpochConfig,
} from '$lib/game/core/epoch';

/**
 * `revealPhaseStartTime` is the inverse of the epoch formula, and it exists so a
 * game can tell an outside scheduler WHEN the reveal becomes due, at commit
 * time. Getting it wrong means a scheduled reveal fires in the wrong phase and
 * the player forfeits, so it is checked against the forward formula rather than
 * against hand-computed numbers.
 */
describe('revealPhaseStartTime', () => {
	const config: EpochConfig = {
		commitPhaseDuration: 30,
		revealPhaseDuration: 10,
		startTime: 1_000,
		commitTimeAllowance: 10.1,
	};

	it('lands exactly on the first instant of the reveal phase', () => {
		for (let epoch = 2; epoch < 40; epoch++) {
			const t = revealPhaseStartTime(config, epoch);

			const atStart = calculateEpochInfo(t, config);
			expect(atStart.currentEpoch, `epoch at ${t}`).toBe(epoch);
			expect(atStart.isCommitPhase, `phase at ${t}`).toBe(false);

			// And the instant before it is still the commit phase of that epoch.
			const justBefore = calculateEpochInfo(t - 0.001, config);
			expect(justBefore.currentEpoch).toBe(epoch);
			expect(justBefore.isCommitPhase).toBe(true);
		}
	});

	it('accounts for a non-zero start time', () => {
		expect(revealPhaseStartTime(config, 2)).toBe(1_030);
		expect(revealPhaseStartTime({...config, startTime: 0}, 2)).toBe(30);
	});
});
