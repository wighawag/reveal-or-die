import {describe, expect, it} from 'vitest';
import {ACTIONS_BESIDES_MOVES} from 'reveal-or-die-contracts';
import {resolveWorldConfig} from '$lib/world/config';

/**
 * ONE REVEAL HOLDS ONE TURN, and a reveal longer than the deployment's
 * `actionsPerReveal` is refused outright (`TooManyActions`) after the
 * commitment is fixed. The planner builds at most `numMoves` moves and one
 * ending action, so the client refuses a deployment whose chunk holds less,
 * before anything is planned. The contract refuses the same configuration at
 * construction (`contracts/test/js/Game.test.ts`).
 */
function deploymentWith(game: Record<string, unknown>) {
	return {
		chain: {id: 1337, properties: {}},
		contracts: {
			Game: {
				linkedData: {
					startTime: '0',
					commitPhaseDuration: '30',
					revealPhaseDuration: '10',
					cyclePolicy: 0,
					avatars: '0x1111111111111111111111111111111111111111',
					numMissesAllowed: '3',
					...game,
				},
			},
			AvatarsSale: {
				address: '0x2222222222222222222222222222222222222222',
				linkedData: {paymentAmount: '1'},
			},
		},
	} as never;
}

describe('the world config', () => {
	it('reads how many actions a reveal holds', () => {
		const config = resolveWorldConfig(
			deploymentWith({numMoves: '10', actionsPerReveal: '11'}),
		);
		expect(config.actionsPerReveal).toBe(11);
		expect(ACTIONS_BESIDES_MOVES).toBe(1);
	});

	it('refuses a deployment whose reveal cannot hold its longest turn', () => {
		expect(() =>
			resolveWorldConfig(
				deploymentWith({numMoves: '10', actionsPerReveal: '10'}),
			),
		).toThrow(/fewer than its longest turn/);
	});
});
