import {describe, expect, it} from 'vitest';
import {causeOfDeath, explainDeath} from '$lib/world/death';

/**
 * The only account of a death the player will ever get.
 *
 * Nothing on chain records why an avatar died: `life` is computed from how far
 * `lastEpoch` has fallen behind, and no event is emitted. So the sentence in
 * the notice is the client's own reading of a rule, which is exactly why it is
 * a tested function rather than a string in a component.
 */
describe('why an avatar died', () => {
	it('counts the rounds of silence it actually takes, which is one more than the tolerance', () => {
		// `_getResolvedAvatar` kills it when `epoch > lastEpoch + 1 + M`. With
		// M = 3 and a last turn in round L, it is dead in L+5, having said nothing
		// in L+1, L+2, L+3 and L+4: four rounds, not three.
		expect(causeOfDeath({numMissesAllowed: 3})).toEqual({
			kind: 'silence',
			rounds: 4,
		});
		expect(causeOfDeath({numMissesAllowed: 0})).toEqual({
			kind: 'silence',
			rounds: 1,
		});
	});

	it('says what happened without a number when the deployment does not state one', () => {
		// A deployment made before the tolerance was a parameter. Quoting the
		// number this build happens to believe would be the client explaining the
		// rules of a game nobody is playing.
		expect(causeOfDeath({})).toEqual({kind: 'silence', rounds: undefined});
		expect(explainDeath(causeOfDeath({}))).toMatch(/several rounds/);
		expect(explainDeath(causeOfDeath({}))).not.toMatch(/\d/);
	});

	it('puts the number in the sentence when there is one', () => {
		expect(explainDeath(causeOfDeath({numMissesAllowed: 3}))).toMatch(
			/4 rounds in a row/,
		);
	});

	it('says why the rule exists, not just that it was broken', () => {
		// An avatar that dies for standing still reads as a bug unless the player
		// is told what going quiet would otherwise buy them: a way out of a turn
		// they committed to and then disliked, which is the one thing a
		// commit-reveal game cannot allow.
		const sentence = explainDeath(causeOfDeath({numMissesAllowed: 3}));
		expect(sentence).toMatch(/commit/i);
		expect(sentence).toMatch(/reveal/i);
		expect(sentence).toMatch(/go quiet|stops playing/i);
	});

	it('admits to not knowing, for a cause it cannot name', () => {
		// Unreachable while silence is the only way to die, and kept because the
		// moment a game adds a second one, every death still reads as `life === 0`
		// and guessing between them would be worse than saying so.
		expect(explainDeath({kind: 'unknown'})).toMatch(/nothing on chain/i);
	});
});
