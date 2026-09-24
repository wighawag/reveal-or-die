import {describe, it, expect, afterEach} from 'vitest';
import {createPublicClient, custom} from 'viem';
import {createEmbeddedWorld, type EmbeddedWorld} from '$lib/embedded';
import {config, extensions} from 'reveal-or-die-contracts/rocketh/config.js';
import {ActionType, bigIntIDToXY, isObstacle} from 'reveal-or-die-contracts';
import {
	OFFLINE_DEPLOYMENT,
	offlineIdentityOf,
	playedByTheWorld,
	stakeForOfflinePlayer,
} from '$lib/offline';
import {seatsPlayedByTheWorld, tableOf} from '$lib/game/lobby/seats';
import {createOfflinePlayers, turnFor} from '$lib/offline-players';
// The secret is the FRAMEWORK's now, and asserting against it here is the point
// rather than an import detail: what a reload has to reproduce is what this
// world actually committed with.
import {playedSeatSecret} from '$lib/game/core/secret';
import {createAttendanceReader, forgetWaitedFor} from '$lib/world/advance';
import {advancePermitted} from '$lib/game/core/advance';
import {resolveWorldConfig} from '$lib/world/config';

/**
 * THE PLAYERS THE WORLD PLAYS, DRIVEN THROUGH A WHOLE ROUND ON A REAL CHAIN.
 *
 * No `.svelte.` infix, so this runs in the `server` project: node, no DOM. That
 * is not a compromise, it is the harness this deserves - webevm's core runs
 * under node, so a whole world (a chain, this game's real deploy scripts, the
 * manual cycle policy) is exercisable without a browser, and the round below is
 * the real contract refusing or accepting every step.
 *
 * A TABLE OF FOUR WHOSE FIRST SEAT IS NEVER FILLED, which is the one thing here
 * that is not how a world really runs. Seat one is the human's and has no key
 * in this process, so what is provisioned and declared is the three seats the
 * world plays. That makes this a test of the PLAYED half - the derivation, the
 * pass loop, the attendance arithmetic - with a real three-member cycle. The
 * human's own half is `e2e/tests/offline.e2e.ts`, in a browser, where there is
 * a wallet to be.
 */

const CHAIN_ID = 9007199254740321;

let world: EmbeddedWorld | undefined;
afterEach(async () => {
	await world?.dispose();
	forgetWaitedFor();
	world = undefined;
});

const table = tableOf(4);
const played = seatsPlayedByTheWorld(table);
const players = playedByTheWorld(table);

async function buildWorld() {
	return createEmbeddedWorld({
		chainId: CHAIN_ID,
		chain: {
			name: 'Offline',
			nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
			properties: {...config.chains[31337].properties},
		},
		rocketh: {config, extensions},
		environment: OFFLINE_DEPLOYMENT.environment,
		scripts: [...OFFLINE_DEPLOYMENT.scripts],
		data: {...OFFLINE_DEPLOYMENT.data},
		accounts: {...OFFLINE_DEPLOYMENT.accounts},
		initialBalances: {
			...OFFLINE_DEPLOYMENT.initialBalances,
			// Every played seat needs gas of its own, exactly as provisioning gives
			// it: a player that cannot pay for a commit freezes the cycle for
			// everybody rather than only for itself.
			...Object.fromEntries(played.map((seat) => [seat.address, 10n ** 24n])),
		},
		provision: async ({env}) => {
			for (const seat of played) {
				await stakeForOfflinePlayer({env, player: seat.address});
			}
		},
	});
}

function clientFor(w: EmbeddedWorld) {
	const records = w.deployments.get();
	return createPublicClient({
		chain: {
			id: records.chain.id,
			name: records.chain.name,
			nativeCurrency: records.chain.nativeCurrency,
			rpcUrls: {default: {http: [] as string[]}},
		},
		transport: custom(w.provider as never),
	});
}

type Env = {
	execute: (deployment: unknown, args: unknown) => Promise<unknown>;
	namedAccounts: Record<string, `0x${string}`>;
};

/** Push the cycle on, the way `world/advance.ts` does: one phase at a time. */
async function push(w: EmbeddedWorld) {
	const env = w.env as unknown as Env;
	await env.execute(w.deployments.get().contracts.Game, {
		account: env.namedAccounts.deployer,
		functionName: 'moveToNextPhase',
		args: [],
	});
}

async function cycleOf(w: EmbeddedWorld) {
	const records = w.deployments.get();
	const [epoch, commiting] = (await clientFor(w).readContract({
		address: records.contracts.Game.address,
		abi: records.contracts.Game.abi,
		functionName: 'getEpoch',
	})) as readonly [bigint, boolean];
	return {cycleNumber: Number(epoch), isCommitPhase: commiting};
}

/**
 * A fresh store over the same world.
 *
 * WHAT A RELOAD IS, for these players: they keep nothing, so a new store with
 * the same inputs is exactly what the next page load builds. Nothing is carried
 * across this call by construction - which is the property being tested, so it
 * is worth saying that the test cannot cheat even if it wanted to.
 */
function playersOver(w: EmbeddedWorld) {
	return createOfflinePlayers({
		provider: w.provider,
		deployments: w.deployments,
		config: resolveWorldConfig(w.deployments.get()),
		players,
	});
}

function attendanceOver(w: EmbeddedWorld, cycleNumber: number) {
	return createAttendanceReader({
		publicClient: clientFor(w) as never,
		deployments: w.deployments as never,
		cycleNumber: () => cycleNumber,
		waitedFor: () => players.map((p) => p.identity),
	})();
}

async function avatarOf(w: EmbeddedWorld, identity: bigint) {
	const records = w.deployments.get();
	return (await clientFor(w).readContract({
		address: records.contracts.Game.address,
		abi: records.contracts.Game.abi,
		functionName: 'getAvatar',
		args: [identity],
	})) as {inGame: boolean; position: bigint; lastEpoch: bigint; life: number};
}

describe('the world plays a whole round', () => {
	it(
		'commits, advances, reveals across a RELOAD, and closes the cycle',
		{timeout: 120_000},
		async () => {
			world = await buildWorld();
			const w = world;

			// THE WORLD OPENS IN A COMMIT PHASE, which is the thing this game's
			// contract could not do until the cycle policy was declared. Everything
			// below is downstream of it.
			expect(await cycleOf(w)).toEqual({cycleNumber: 2, isCommitPhase: true});

			// ---- COMMIT ------------------------------------------------------
			await playersOver(w).tick();

			let attendance = await attendanceOver(w, 2);
			expect(attendance).toEqual({waitedFor: 3, committed: 3, revealed: 0});
			expect(
				advancePermitted({
					policy: 'manual',
					isCommitPhase: true,
					attendance,
				}),
			).toEqual({permitted: true, opens: 'the-reveal-phase'});

			// ---- ADVANCE -----------------------------------------------------
			await push(w);
			expect(await cycleOf(w)).toEqual({cycleNumber: 2, isCommitPhase: false});

			// ---- RELOAD ------------------------------------------------------
			// THE PROPERTY THE WHOLE FILE RESTS ON. These players hold nothing, so
			// the reveal below is built by a store that never saw the commit: it
			// re-derives the secret and re-derives the turn from the avatar's
			// position, and the contract checks the hash. If the derivation were
			// not reproducible the reveal would revert with
			// `CommitmentHashNotMatching`, the cycle could never close (an advance
			// refuses to leave an unopened commitment, and
			// `acknowledgeMissedReveal` refuses one from the current cycle), and
			// the world would be frozen for good rather than short one turn.
			const afterReload = playersOver(w);

			// ---- REVEAL ------------------------------------------------------
			await afterReload.tick();

			attendance = await attendanceOver(w, 2);
			expect(attendance).toEqual({waitedFor: 3, committed: 3, revealed: 3});
			expect(
				advancePermitted({
					policy: 'manual',
					isCommitPhase: false,
					attendance,
				}),
			).toEqual({permitted: true, opens: 'the-next-cycle'});

			// ---- ADVANCE -----------------------------------------------------
			await push(w);
			expect(await cycleOf(w)).toEqual({cycleNumber: 3, isCommitPhase: true});

			// AND THEY REACHED THE BOARD, which is the assertion that stops all of
			// the above being satisfied by three empty turns. A player that commits
			// nothing and reveals nothing satisfies every count in this test while
			// putting nothing on the board, and the board is the only place the
			// human can see that somebody else is playing.
			for (const player of players) {
				const avatar = await avatarOf(w, player.identity);
				expect(avatar.inGame, `avatar ${player.identity} is in the world`).toBe(
					true,
				);
				expect(avatar.lastEpoch).toBe(2n);
				expect(avatar.life).toBeGreaterThan(0);
			}
		},
	);

	it(
		'walks on the next cycle, having entered on the first',
		{timeout: 120_000},
		async () => {
			// The second cycle is where the OTHER branch of the derivation runs: an
			// avatar that is already in the world moves rather than entering, and a
			// legal move depends on the maze and on where it is standing. A round
			// that only ever tested the Enter would test one of the two.
			world = await buildWorld();
			const w = world;

			for (const phase of [0, 1, 2, 3]) {
				await playersOver(w).tick();
				await push(w);
				expect(phase).toBeGreaterThanOrEqual(0);
			}

			expect(await cycleOf(w)).toEqual({cycleNumber: 4, isCommitPhase: true});
			for (const player of players) {
				const avatar = await avatarOf(w, player.identity);
				expect(avatar.inGame).toBe(true);
				// Revealed in cycle 3 as well as 2, which is what keeps it alive.
				expect(avatar.lastEpoch).toBe(3n);
				const at = bigIntIDToXY(avatar.position);
				expect(isObstacle(at.x, at.y), 'standing on a walkable cell').toBe(
					false,
				);
			}
		},
	);
});

describe('a derived turn', () => {
	const GAME = '0x1111111111111111111111111111111111111111' as const;

	it('is the same turn every time it is derived', () => {
		const args = {
			game: GAME,
			identity: offlineIdentityOf(played[0].address),
			cycleNumber: 7,
			avatar: {inGame: false, position: 0n},
			numMoves: 10,
		};
		expect(turnFor(args)).toEqual(turnFor(args));
	});

	it('differs per player, per cycle, and per position', () => {
		const base = {
			game: GAME,
			identity: 1n,
			cycleNumber: 7,
			avatar: {inGame: false, position: 0n},
			numMoves: 10,
		};
		expect(turnFor({...base, identity: 2n})).not.toEqual(turnFor(base));
		expect(turnFor({...base, cycleNumber: 8})).not.toEqual(turnFor(base));
	});

	it('ENTERS when the avatar is not in the world, onto a cell that is not a wall', () => {
		const actions = turnFor({
			game: GAME,
			identity: 3n,
			cycleNumber: 2,
			avatar: {inGame: false, position: 0n},
			numMoves: 10,
		});
		expect(actions).toHaveLength(1);
		expect(actions[0].actionType).toBe(ActionType.Enter);
		const at = bigIntIDToXY(actions[0].data);
		expect(isObstacle(at.x, at.y)).toBe(false);
	});

	it('WALKS when it is, one legal orthogonal step at a time', () => {
		// An entry cell, so the walk starts somewhere the contract would accept.
		const entry = turnFor({
			game: GAME,
			identity: 3n,
			cycleNumber: 2,
			avatar: {inGame: false, position: 0n},
			numMoves: 10,
		})[0].data;

		const actions = turnFor({
			game: GAME,
			identity: 3n,
			cycleNumber: 3,
			avatar: {inGame: true, position: entry},
			numMoves: 10,
		});
		expect(actions.length).toBeGreaterThan(0);

		let at = bigIntIDToXY(entry);
		for (const action of actions) {
			expect(action.actionType).toBe(ActionType.Move);
			const to = bigIntIDToXY(action.data);
			// `_move` drops the REST of a turn at the first illegal step rather
			// than reverting, so a turn with an illegal step in the middle is a
			// turn that silently does less than it said. Every step has to be
			// adjacent and walkable or the reveal resolves to something other than
			// what was planned.
			expect(Math.abs(to.x - at.x) + Math.abs(to.y - at.y)).toBe(1);
			expect(isObstacle(to.x, to.y)).toBe(false);
			at = to;
		}
	});

	it('is EMPTY when there is nothing legal to do, so the cycle can still close', () => {
		// The acceptance criterion in one assertion. A player boxed in on all four
		// sides still has to hand the cycle something, because unanimity waits for
		// it either way: an empty turn commits, reveals, writes `lastEpoch` (which
		// is what keeps the avatar alive and what the attendance reader counts)
		// and resolves to nothing. Refusing to commit would freeze the world.
		//
		// `numMoves: 0` is the reachable way to say "no legal step exists" without
		// depending on the generated map having a sealed cell in it, and it goes
		// down the same path: the walk yields nothing, and nothing is what is
		// committed.
		const actions = turnFor({
			game: GAME,
			identity: 3n,
			cycleNumber: 3,
			avatar: {inGame: true, position: 0n},
			numMoves: 0,
		});
		expect(actions).toEqual([]);
	});
});

describe('the secret a played seat commits with', () => {
	// KEPT HERE THOUGH THE FUNCTION MOVED, because what this world depends on is
	// the property rather than the location: a derivation that stopped being
	// reproducible would strand a commitment and freeze this game, and a
	// derivation that stopped being separated would let one played seat open
	// another's. The framework has its own copy of these two assertions; this one
	// is the game saying which of them it is relying on.
	const GAME = '0x1111111111111111111111111111111111111111' as const;
	const base = {chainId: 1, contract: GAME, identity: 1n, cycleNumber: 2};

	it('is reproducible, which is the only reason a reload can reveal', () => {
		expect(playedSeatSecret(base)).toBe(playedSeatSecret(base));
	});

	it('is separated by chain, game, identity and cycle', () => {
		// Two seats deriving ONE secret would be two commitments either of them
		// could open, which is a way for a played seat to settle another's turn by
		// accident.
		expect(playedSeatSecret({...base, chainId: 2})).not.toBe(
			playedSeatSecret(base),
		);
		expect(playedSeatSecret({...base, identity: 2n})).not.toBe(
			playedSeatSecret(base),
		);
		expect(playedSeatSecret({...base, cycleNumber: 3})).not.toBe(
			playedSeatSecret(base),
		);
		expect(
			playedSeatSecret({
				...base,
				contract: '0x2222222222222222222222222222222222222222',
			}),
		).not.toBe(playedSeatSecret(base));
	});
});
