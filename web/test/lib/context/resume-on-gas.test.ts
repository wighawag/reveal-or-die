import {describe, it, expect, vi} from 'vitest';
import {writable} from 'svelte/store';
import {resumeWhenGasArrives} from '$lib/context/game';
import {SignerOutOfFundsError} from '$lib/world/errors';
import type {RoundState} from '$lib/game/core/round';
import type {Action} from '$lib/world/commit-reveal';

/**
 * The one piece of wiring that spends the player's gas without being asked.
 *
 * Resuming automatically is deliberate and it is worth money: a reveal window
 * can be seconds long, and a player who has to notice the failure, top up, AND
 * remember to press retry has three chances to lose their bond instead of one.
 *
 * The cost of getting it wrong runs the other way. Every resume is a real
 * transaction paid for out of gas that has only just arrived, so resuming on a
 * failure the money does not fix (a revert, a bad nonce, a contract that said
 * no) burns the top-up on a move that will fail again the same way - and the
 * player never asked for either send.
 */

type State = RoundState<Action>;

function fakeRound(state: State) {
	const commit = vi.fn(async () => {});
	const reveal = vi.fn(async () => {});
	let value = state;
	return {
		commit,
		reveal,
		get value() {
			return value;
		},
		set(next: State) {
			value = next;
		},
		subscribe: () => () => {},
	};
}

const outOfGas = (during: 'commit' | 'reveal'): State => ({
	step: 'Error',
	during,
	epoch: 3,
	actions: [{actionType: 1, data: 1n}],
	message: 'Not enough gas to send this move.',
	error: new SignerOutOfFundsError(new Error('insufficient funds')),
});

describe('resuming a round when gas arrives', () => {
	it('retries a commit that ran out of gas', () => {
		const round = fakeRound(outOfGas('commit'));
		const balance = writable<{step: string; value?: bigint}>({
			step: 'Loaded',
			value: 0n,
		});

		const stop = resumeWhenGasArrives({round, signerBalance: balance});
		balance.set({step: 'Loaded', value: 10n});

		expect(round.commit).toHaveBeenCalledOnce();
		expect(round.reveal).not.toHaveBeenCalled();
		stop();
	});

	it('retries the REVEAL when it was the reveal that failed', () => {
		// Not interchangeable: committing again here would build a second
		// commitment for an epoch that already has one, and the reveal the player
		// has a stake riding on would still never be sent.
		const round = fakeRound(outOfGas('reveal'));
		const balance = writable<{step: string; value?: bigint}>({
			step: 'Loaded',
			value: 0n,
		});

		const stop = resumeWhenGasArrives({round, signerBalance: balance});
		balance.set({step: 'Loaded', value: 10n});

		expect(round.reveal).toHaveBeenCalledOnce();
		expect(round.commit).not.toHaveBeenCalled();
		stop();
	});

	it('does NOT retry a failure that gas cannot fix', () => {
		// The mutation this test exists for: resuming on `step === 'Error'` alone.
		// It looks harmless (the round is failed either way) and it quietly spends
		// the top-up on a move that fails again identically. A contract that
		// rejected a commitment rejects it just as hard with a full tank.
		const round = fakeRound({
			step: 'Error',
			during: 'commit',
			epoch: 3,
			actions: [{actionType: 1, data: 1n}],
			message: 'The commitment was rejected by the contract',
			error: new Error('The commitment was rejected by the contract'),
		});
		const balance = writable<{step: string; value?: bigint}>({
			step: 'Loaded',
			value: 0n,
		});

		const stop = resumeWhenGasArrives({round, signerBalance: balance});
		balance.set({step: 'Loaded', value: 10n});

		expect(round.commit).not.toHaveBeenCalled();
		expect(round.reveal).not.toHaveBeenCalled();
		stop();
	});

	it('does not send anything when the round is not failed', () => {
		const round = fakeRound({
			step: 'Committed',
			epoch: 3,
			actions: [{actionType: 1, data: 1n}],
			hash: '0xabc',
		} as unknown as State);
		const balance = writable<{step: string; value?: bigint}>({
			step: 'Loaded',
			value: 0n,
		});

		const stop = resumeWhenGasArrives({round, signerBalance: balance});
		balance.set({step: 'Loaded', value: 10n});

		expect(round.commit).not.toHaveBeenCalled();
		expect(round.reveal).not.toHaveBeenCalled();
		stop();
	});

	it('does not fire on the FIRST balance it ever sees', () => {
		// Loading a balance is this browser learning what was already there, not
		// money arriving. Firing on it would retry the moment the page settles,
		// against exactly the balance that just failed.
		const round = fakeRound(outOfGas('commit'));
		const balance = writable<{step: string; value?: bigint}>({
			step: 'Unloaded',
		});

		const stop = resumeWhenGasArrives({round, signerBalance: balance});
		balance.set({step: 'Loaded', value: 500n});

		expect(round.commit).not.toHaveBeenCalled();
		stop();
	});

	it('does not fire when the balance falls or holds still', () => {
		const round = fakeRound(outOfGas('commit'));
		const balance = writable<{step: string; value?: bigint}>({
			step: 'Loaded',
			value: 10n,
		});

		const stop = resumeWhenGasArrives({round, signerBalance: balance});
		balance.set({step: 'Loaded', value: 10n});
		balance.set({step: 'Loaded', value: 4n});

		expect(round.commit).not.toHaveBeenCalled();
		stop();
	});

	it('stops watching once torn down', () => {
		const round = fakeRound(outOfGas('commit'));
		const balance = writable<{step: string; value?: bigint}>({
			step: 'Loaded',
			value: 0n,
		});

		const stop = resumeWhenGasArrives({round, signerBalance: balance});
		stop();
		balance.set({step: 'Loaded', value: 10n});

		expect(round.commit).not.toHaveBeenCalled();
	});
});
