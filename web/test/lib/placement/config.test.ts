import {describe, it, expect} from 'vitest';
import {resolvePlacementConfig} from '$lib/placement/config';
import type {TypedDeployments} from '$lib/core/connection/types';

/**
 * THE CHUNK SIZE COMES OFF THE DEPLOYMENT, and this is what says so.
 *
 * A turn longer than one transaction is committed as a hash chain, and the head
 * of that chain depends on how the turn was cut up. So a client that carried its
 * own number - a constant, a default, a fallback - would commit a head the
 * contract cannot follow the moment the deployment said anything else, and the
 * only symptom would be a reveal reverting after the bond was already immovable.
 *
 * The other half of this pair is in `contracts/test/js/Game.test.ts`, which
 * deploys a game at a different chunk size and watches the contract's rule
 * follow; together they are what stops the two sides drifting.
 */
function deploymentsDeclaring(game: Record<string, unknown>): TypedDeployments {
	return {
		chain: {properties: {expectedWorstGasPrice: '1000000000'}},
		contracts: {
			Game: {
				address: '0x0000000000000000000000000000000000000001',
				linkedData: {
					startTime: '0',
					commitPhaseDuration: '30',
					revealPhaseDuration: '10',
					cyclePolicy: '0',
					// Zero, as this branch's deployment declares it: custody of the
					// avatar is the stake, so a placement costs nothing.
					placementCost: '0',
					tokens: '0x0000000000000000000000000000000000000002',
					...game,
				},
			},
			// THE AVATAR SALE, which is what this branch sells instead of a bond.
			// The shape the client needs from a sale is the same; the contract's
			// name is not, and a fixture inherited from `main` named `StakeSale`
			// and failed on a deployment that has no such contract.
			GameAvatarSale: {
				address: '0x0000000000000000000000000000000000000003',
				linkedData: {price: '10', amount: '10000000000000000000'},
			},
		},
	} as unknown as TypedDeployments;
}

describe('the chunk size the client cuts a turn to', () => {
	it('is whatever the deployment declared', () => {
		expect(
			resolvePlacementConfig(deploymentsDeclaring({actionsPerReveal: '4'}))
				.actionsPerReveal,
		).toBe(4);

		// Changed in the deploy script, followed here, with nothing in between to
		// keep in step.
		expect(
			resolvePlacementConfig(deploymentsDeclaring({actionsPerReveal: '7'}))
				.actionsPerReveal,
		).toBe(7);
	});

	it('refuses a deployment that does not declare one, rather than guessing', () => {
		// THERE IS NO SAFE DEFAULT. A client that substituted one would hash a
		// chain the contract cannot follow and would do it confidently; saying so
		// at startup costs nothing, and saying it a cycle later costs a bond.
		expect(() => resolvePlacementConfig(deploymentsDeclaring({}))).toThrow(
			/actionsPerReveal/,
		);
	});
});
