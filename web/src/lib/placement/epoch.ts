/**
 * Asking the CHAIN where the round is.
 *
 * The framework owns the epoch model and the policies (`$lib/game/core/epoch`);
 * what it cannot own is which contract to ask, so this is the game's half: one
 * call, `getRound`, turned into the shape the trackers read.
 *
 * Under the timed policy nothing calls this at all, because the epoch is pure
 * arithmetic over the deployment's own parameters. Under the other two it is
 * the authority, and the local clock only predicts between reads: a round that
 * moves when someone pushes it cannot be computed from a clock, and a round
 * that CAN be pushed forward cannot be computed from one either.
 */
import type {TypedDeployments} from '$lib/core/connection/types';
import type {RoundReading} from '$lib/game/core/epoch';
import type {PublicClient} from 'viem';

export function createRoundReader(deps: {
	publicClient: PublicClient;
	deployments: TypedDeployments;
}): () => Promise<RoundReading> {
	const Game = deps.deployments.contracts.Game;
	return async () => {
		const round = (await deps.publicClient.readContract({
			address: Game.address,
			abi: Game.abi,
			functionName: 'getRound',
		})) as {
			cycleNumber: bigint;
			commiting: boolean;
			phaseStart: bigint;
			phaseEnd: bigint;
		};
		return {
			epoch: Number(round.cycleNumber),
			isCommitPhase: round.commiting,
			phaseStart: Number(round.phaseStart),
			phaseEnd: Number(round.phaseEnd),
		};
	};
}
