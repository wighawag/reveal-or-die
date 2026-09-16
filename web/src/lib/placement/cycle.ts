/**
 * Asking the CHAIN where the cycle is.
 *
 * The framework owns the cycle model and the policies (`$lib/game/core/cycle`);
 * what it cannot own is which contract to ask, so this is the game's half: one
 * call, `getCycle`, turned into the shape the trackers read.
 *
 * Under the timed policy nothing calls this at all, because the cycle is pure
 * arithmetic over the deployment's own parameters. Under the other two it is
 * the authority, and the local clock only predicts between reads: a cycle that
 * moves when someone pushes it cannot be computed from a clock, and a cycle
 * that CAN be pushed forward cannot be computed from one either.
 */
import type {TypedDeployments} from '$lib/core/connection/types';
import type {CycleReading} from '$lib/game/core/cycle';
import type {PublicClient} from 'viem';

export function createCycleReader(deps: {
	publicClient: PublicClient;
	deployments: TypedDeployments;
}): () => Promise<CycleReading> {
	const Game = deps.deployments.contracts.Game;
	return async () => {
		const cycle = (await deps.publicClient.readContract({
			address: Game.address,
			abi: Game.abi,
			functionName: 'getCycle',
		})) as {
			cycleNumber: bigint;
			commiting: boolean;
			phaseStart: bigint;
			phaseEnd: bigint;
		};
		return {
			cycleNumber: Number(cycle.cycleNumber),
			isCommitPhase: cycle.commiting,
			phaseStart: Number(cycle.phaseStart),
			phaseEnd: Number(cycle.phaseEnd),
		};
	};
}
