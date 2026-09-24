import {keccak256, encodePacked, zeroAddress} from 'viem';
import type {DeploymentsStore} from '$lib/deployments-store';
import type {EIP1193ProviderLike} from '$lib/embedded';
import {
	createPlayedKeys,
	createSerialisedLoop,
	type SerialisedLoop,
} from '$lib/game/core/played';
import {playedSeatSecret} from '$lib/game/core/secret';
import {createCycleReader} from '$lib/world/advance';
import type {WorldConfig} from '$lib/world/config';
import {
	ActionType,
	bigIntIDToXY,
	commitmentHash,
	isObstacle,
	isValidMove,
	xyToBigIntID,
	type Action,
} from 'reveal-or-die-contracts';

/**
 * THE OTHER PLAYERS IN THE OFFLINE WORLD, because a commit-reveal game with one
 * player is not one.
 *
 * WHY THERE HAS TO BE MORE THAN ONE AT ALL. A cycle with a single waited-for
 * member hides nothing: unanimity is satisfied by the only person present, and
 * an advance never has to refuse anybody. THREE rather than two, because two is
 * a duel: "everyone" and "the other one" are the same statement. At three the
 * order-independence property has something to say.
 *
 * WHY THE WORLD PLAYS THEM. Under the manual cycle policy nothing moves until
 * every waited-for member has acted, so two members who never act do not make a
 * quiet game - they make a FROZEN one, for the human as well. Either the world
 * plays them or it must not enrol them.
 *
 * WHAT THIS IS NOT. It is not a mode, and it is not NPCs: there is no
 * intelligence here, no difficulty and no interface for either. It is the
 * smallest thing that makes the cycle have somebody to wait for, written in the
 * app beside the world that wants it.
 *
 * WHAT IS NO LONGER HERE IS THE MACHINERY. The keyring that sends a call and
 * waits for inclusion, the loop that serialises passes and queues a poke that
 * arrives during one, and the subscription that pokes when the human acts are
 * `$lib/game/core/played`'s; the secret is `$lib/game/core/secret`'s. They moved
 * because this file and the template's agreed on them to the character, which is
 * what earns a framework half in this tree. WHAT IS LEFT is everything the two
 * disagreed about, and the three sections below are exactly it: how a turn is
 * derived (here it reads chain state, upstream it does not), whether a reveal is
 * one call or a chain of chunks (here one), and what settling a missed reveal
 * COSTS (here nothing at all).
 *
 * ## They hold nothing in memory, and here that is HARDER than upstream
 *
 * Both the secret and the actions are DERIVED rather than stored, so a reload
 * reconstructs them exactly. The alternative bricks the world: a player that
 * commits and then forgets its secret can never reveal, no advance can close a
 * cycle holding an unopened commitment, and `acknowledgeMissedReveal` refuses
 * one from the CURRENT cycle - so under the manual policy the two refusals are
 * each other's premise and the human's game stops for good.
 *
 * **UPSTREAM CAN DERIVE FROM NOTHING BUT (game, identity, cycle). HERE IT
 * CANNOT.** That game's turn is one placement on an open board, so `turnFor` is
 * a pure function of three public values and needs no chain at all. Here an
 * action is `{actionType, data}` over `{Enter, Move, Exit}`: a player must Enter
 * before it can Move, and a legal Move depends on where the avatar is STANDING
 * and on the maze. So the derivation takes a fourth input, and that input is
 * chain state.
 *
 * **WHICH IS SAFE ONLY BECAUSE OF WHEN THE POSITION CHANGES, and that argument
 * is the load-bearing one in this file.** The only thing that writes
 * `Avatar.position` is `_resolveActions`, and the only thing that calls
 * `_resolveActions` is `_reveal`. So within one cycle the position is fixed
 * from the moment the commit phase opens until this player's OWN reveal lands:
 * no other player's reveal can move it (that is the order-independence rule
 * holding one level up), and nothing else on chain touches it. A commit made in
 * cycle N and a reveal derived in cycle N therefore see the same position and
 * build the same actions, across any number of reloads in between.
 *
 * What would break it is deriving from a position read AFTER the reveal, which
 * is why {@link turnFor} is never called once `lastEpoch` says this cycle is
 * done, and why {@link candidateTurns} lets the HASH judge rather than trusting
 * the derivation. `test/lib/offline-players.test.ts` pins this by committing,
 * throwing the whole store away, building a fresh one and revealing.
 *
 * **AND BECAUSE IT IS DERIVED, THE DERIVATION IS A WIRE.** A build that changes
 * {@link turnFor} or `playedSeatSecret` can no longer open a commitment an
 * earlier build left on chain, which under the manual policy is not a lost turn
 * but a frozen world. {@link createOfflinePlayers} closes that from the only
 * side it can be closed from - it re-commits, in the commit phase, whenever the
 * head on chain is not one this build can open - so by the time a reveal phase
 * opens every played commitment is openable. The same care `AGENTS.md` asks for
 * around a persisted storage key applies here, one level over.
 *
 * ## What it costs to go quiet, which is the other thing this game spells
 * ## differently
 *
 * Upstream a missed reveal forfeits a bonded ERC20. Here there is no bond and
 * nothing to burn: `_acknowledgeMissedReveal` carries `TODO burn / stake` and
 * takes nothing. What actually costs something is the CLOCK - an avatar that
 * has not revealed for `numMissesAllowed` cycles is dead, computed from how far
 * `lastEpoch` has fallen behind, with no event and no transaction to mark it.
 * The game is called reveal-or-die and that is the whole of why.
 *
 * Which changes the safety valve below rather than removing it. Settling a
 * stale commitment upstream SPENDS the world's stake, and is justified on the
 * grounds that it is the world's own. Here it spends nothing at all: the loss
 * already happened when the reveal did not, and acknowledging only unblocks the
 * next commitment. So the valve is cheaper here and more important, because a
 * played player that stays blocked never commits again and therefore never
 * reveals again, and three cycles later the world is short a member for good.
 */

/** One player the world plays: a key it holds, and who that key plays as. */
export type OfflinePlayer = {
	privateKey: `0x${string}`;
	/** The avatar id. Derived from the address; see `$lib/offline`. */
	identity: bigint;
};

/** What `getCommitment` hands back. `epoch` is the ABI's own component name. */
type Commitment = {hash: `0x${string}`; epoch: bigint};

/** What `getAvatar` hands back, of which four fields are read here. */
type PublicAvatar = {
	owner: `0x${string}`;
	inGame: boolean;
	position: bigint;
	lastEpoch: bigint;
	life: number;
};

/**
 * How far from the origin a played player enters, in cells, on each axis.
 *
 * Kept SMALL so the human can see the others without panning, which is the only
 * reason an entry is a board position rather than a number. The camera opens on
 * 24x24 cells (`world/config.ts`), so a 13x13 block around the origin is always
 * on screen.
 */
const ENTRY_SPREAD = 13;

/**
 * How many steps a played player walks once it is in the world.
 *
 * Deliberately far below `numMoves` (ten on every deployment): the point is to
 * be VISIBLE on the board, not to cover ground, and a short walk is a shorter
 * reveal on a chain that is also running the human's turn.
 */
const STEPS_PER_TURN = 3;

/** The four neighbours, in the order a derived walk prefers them. */
const NEIGHBOURS: readonly {x: number; y: number}[] = [
	{x: 0, y: -1},
	{x: 1, y: 0},
	{x: 0, y: 1},
	{x: -1, y: 0},
];

function seedFor(params: {
	game: `0x${string}`;
	identity: bigint;
	cycleNumber: number;
	salt: string;
}): bigint {
	return BigInt(
		keccak256(
			encodePacked(
				['string', 'address', 'uint256', 'uint64'],
				[params.salt, params.game, params.identity, BigInt(params.cycleNumber)],
			),
		),
	);
}

/**
 * WHERE A PLAYED TURN COMES FROM, deterministically, given where the avatar is.
 *
 * Three cases, and the third is an acceptance criterion rather than a fallback
 * nobody reaches:
 *
 * 1. **Not in the world: ENTER.** A seeded cell near the origin, walked
 *    outwards until one is not a wall. An Enter sets `stopProcessing`, so it is
 *    the whole turn.
 * 2. **In the world: a WALK** of at most {@link STEPS_PER_TURN} steps, each one
 *    the first legal neighbour from a seeded rotation. `_move` drops the rest
 *    of a turn at the first illegal step rather than reverting, so a walk that
 *    is legal here is a walk that resolves whole.
 * 3. **NOTHING LEGAL: THE EMPTY TURN**, which is what this file does when an
 *    avatar is boxed in by walls on all four sides. It is not doing nothing:
 *    an empty reveal still runs `_resolveActions`, which writes `lastEpoch`,
 *    and `lastEpoch` is what keeps the avatar alive and what the attendance
 *    reader counts as a reveal. So the cycle closes on it and the player stays
 *    a member. Refusing to commit would have frozen the world instead, because
 *    unanimity waits for this player either way.
 *
 * DEAD AVATARS NEVER REACH HERE. `_makeCommitment` reverts `AvatarIsDead`, so a
 * dead member cannot act at all, and the caller skips it - which is also what
 * makes the cycle able to close without it, since the attendance reader stops
 * waiting for a member with no life left.
 */
export function turnFor(params: {
	game: `0x${string}`;
	identity: bigint;
	cycleNumber: number;
	avatar: {inGame: boolean; position: bigint};
	numMoves: number;
}): Action[] {
	const {game, identity, cycleNumber} = params;

	if (!params.avatar.inGame) {
		const entry = entryCellFor({game, identity, cycleNumber});
		if (!entry) return [];
		return [
			{actionType: ActionType.Enter, data: xyToBigIntID(entry.x, entry.y)},
		];
	}

	const steps = Math.min(STEPS_PER_TURN, Math.max(0, params.numMoves));
	let at = bigIntIDToXY(params.avatar.position);
	const actions: Action[] = [];
	for (let step = 0; step < steps; step++) {
		// A ROTATION PER STEP rather than one direction per turn, so a player in
		// a corridor still moves instead of walking into the same wall three
		// times. The seed includes the step index for the same reason.
		const seed = seedFor({
			game,
			identity,
			cycleNumber,
			salt: `Offline:step:${step}`,
		});
		const start = Number(seed % 4n);
		let moved = false;
		for (let i = 0; i < NEIGHBOURS.length; i++) {
			const dir = NEIGHBOURS[(start + i) % NEIGHBOURS.length];
			const to = {x: at.x + dir.x, y: at.y + dir.y};
			if (!isValidMove(at, to)) continue;
			actions.push({
				actionType: ActionType.Move,
				data: xyToBigIntID(to.x, to.y),
			});
			at = to;
			moved = true;
			break;
		}
		// Boxed in. Stopping here rather than at zero steps still yields whatever
		// was legal before the dead end, which is the most this player can do.
		if (!moved) break;
	}
	return actions;
}

/**
 * A cell near the origin that is not a wall, chosen deterministically.
 *
 * SEARCHED RATHER THAN ASSUMED, because the map is generated and a seeded cell
 * is as likely to be rock as floor. The walk is over the same spread in a fixed
 * order, so it is reproducible, and it gives up rather than widening for ever:
 * a world whose whole central block is solid is a world this player cannot
 * enter, and the empty turn is the honest answer to that.
 */
function entryCellFor(params: {
	game: `0x${string}`;
	identity: bigint;
	cycleNumber: number;
}): {x: number; y: number} | undefined {
	const seed = seedFor({...params, salt: 'Offline:entry'});
	const half = Math.floor(ENTRY_SPREAD / 2);
	const cells = ENTRY_SPREAD * ENTRY_SPREAD;
	const from = Number(seed % BigInt(cells));
	for (let i = 0; i < cells; i++) {
		const index = (from + i) % cells;
		const x = (index % ENTRY_SPREAD) - half;
		const y = Math.floor(index / ENTRY_SPREAD) - half;
		if (!isObstacle(x, y)) return {x, y};
	}
	return undefined;
}

export function createOfflinePlayers(params: {
	provider: EIP1193ProviderLike;
	deployments: DeploymentsStore;
	config: WorldConfig;
	players: readonly OfflinePlayer[];
	/** How often to look. The framework's loop owns the default. */
	pollInterval?: number;
	/**
	 * Called after a pass in which a player actually SENT something.
	 *
	 * The reason it exists is measured rather than tidy: a played commit is
	 * exactly the moment unanimity may have been completed, and the browser's
	 * advance client only finds out on its own one-second poll.
	 */
	onActed?: () => void;
}): SerialisedLoop {
	const {provider, deployments, config, players} = params;

	const records = deployments.get();
	const game = {
		address: records.contracts.Game.address,
		abi: records.contracts.Game.abi,
	};
	// Built rather than cast out of the records: what viem needs of a chain is
	// an id, a name and a currency, and the records' type is the build-time
	// literal one, so a cast here would be a cast to something this world is
	// not.
	const chain = {
		id: records.chain.id,
		name: records.chain.name,
		nativeCurrency: records.chain.nativeCurrency,
		rpcUrls: {default: {http: [] as string[]}},
	};

	// THE KEYRING AND THE WAITING ARE THE FRAMEWORK'S, and what is left here is
	// which calls to make. `publicClient` comes back out of it so that the reads
	// below go through the same client the sends wait on, rather than a second one
	// against the same provider.
	const keys = createPlayedKeys({provider, chain, contract: game});
	const publicClient = keys.publicClient;

	// THE SEAM SITTING BESIDE THIS FILE, rather than a second copy of the same
	// read. This is the one line where this file and the template's differed -
	// `getEpoch` against `getCycle` - and both repos already ship a reader that
	// answers it in the framework's own shape for the trackers. Note it reads
	// `getEpoch` because that is what THIS game's contract is still called; the
	// framework sees `CycleReading` either way, which is the whole point of the
	// seam.
	const readCycle = createCycleReader({publicClient, deployments});

	function send(
		player: OfflinePlayer,
		request: Record<string, unknown>,
	): Promise<void> {
		return keys.send(player.privateKey, request);
	}

	async function commitmentOf(player: OfflinePlayer): Promise<Commitment> {
		return (await publicClient.readContract({
			...game,
			functionName: 'getCommitment',
			args: [player.identity],
		})) as Commitment;
	}

	async function avatarOf(player: OfflinePlayer): Promise<PublicAvatar> {
		return (await publicClient.readContract({
			...game,
			functionName: 'getAvatar',
			args: [player.identity],
		})) as PublicAvatar;
	}

	/**
	 * Every turn this file could have committed for a player in a cycle.
	 *
	 * TWO, AND THE SECOND ONE IS THE POINT. The derived walk depends on chain
	 * state, and a reveal that re-derived it and guessed wrong would build a
	 * hash that is not the one the contract is holding - which strands the
	 * commitment, and under the manual policy strands the whole world. The
	 * argument at the top of this file says why the position cannot actually
	 * have moved in between; this is what makes being wrong about that survivable
	 * rather than fatal. The empty turn is the other thing this file can commit
	 * (see {@link turnFor} case 3), so both are offered and the HASH decides,
	 * exactly as the app's own recovery lets the hash judge.
	 */
	function candidateTurns(
		player: OfflinePlayer,
		cycleNumber: number,
		avatar: PublicAvatar,
	): Action[][] {
		return [
			turnFor({
				game: game.address,
				identity: player.identity,
				cycleNumber,
				avatar,
				numMoves: config.numMoves,
			}),
			[],
		];
	}

	async function commit(
		player: OfflinePlayer,
		cycleNumber: number,
		onChain: Commitment,
		avatar: PublicAvatar,
	): Promise<void> {
		const secret = playedSeatSecret({
			chainId: records.chain.id,
			contract: game.address,
			identity: player.identity,
			cycleNumber,
		});
		const [actions] = candidateTurns(player, cycleNumber, avatar);
		const hash = commitmentHash(secret, actions);

		// ALREADY DONE, OR DONE WRONG, and the second case is why this compares
		// the head rather than the cycle number. A commitment this build cannot
		// open would freeze the world the moment the reveal phase opened (no
		// advance can close a cycle holding one, and the contract refuses to
		// settle a commitment from the CURRENT cycle), and the commit phase is
		// the only phase in which anything can still be done about it. Replacing
		// a commitment made in the same cycle is expressly allowed, so this costs
		// nothing when it never fires.
		if (Number(onChain.epoch) === cycleNumber) {
			if (onChain.hash.toLowerCase() === hash.toLowerCase()) return;
		}

		await send(player, {
			functionName: 'commit',
			args: [player.identity, hash, zeroAddress],
		});
	}

	async function reveal(
		player: OfflinePlayer,
		cycleNumber: number,
		onChain: Commitment,
		avatar: PublicAvatar,
	): Promise<void> {
		// Nothing committed in this cycle means nothing owed: this player entered
		// after the commit phase closed, or has already been settled.
		if (Number(onChain.epoch) !== cycleNumber) return;

		const secret = playedSeatSecret({
			chainId: records.chain.id,
			contract: game.address,
			identity: player.identity,
			cycleNumber,
		});

		// ONE REVEAL, NOT A CHUNKING LOOP, and that is a fact about this game's
		// contracts rather than an omission. `reveal` here takes one array and
		// resolves all of it; there is no `furtherActions` anywhere, so the
		// commitment is a hash rather than the head of a chain. `AGENTS.md` calls
		// that a schedule rather than drift, and what a game must never do is
		// chain the commitment in its contracts and leave its client sending the
		// whole turn - or, as it would be here, the reverse. The two halves agree
		// today and this line is one of the two.
		for (const actions of candidateTurns(player, cycleNumber, avatar)) {
			if (
				commitmentHash(secret, actions).toLowerCase() !==
				onChain.hash.toLowerCase()
			)
				continue;
			// NO DECLARED GAS LIMIT, which matches what the app's own adapter does
			// here: this game declares no measured figures (the constants in
			// `world/config.ts` only size the stipend), so the node estimates.
			// Safe on this chain specifically - an estimate executes at the last
			// mined block's timestamp, and a manual cycle reads no timestamp at
			// all, so there is nothing for a frozen one to get wrong.
			await send(player, {
				functionName: 'reveal',
				args: [player.identity, actions, secret, zeroAddress],
			});
			return;
		}

		// THE ONE STATE THIS FILE CANNOT GET OUT OF, said out loud rather than
		// papered over. The chain is holding a turn no candidate reproduces, so
		// it cannot be opened; it cannot be settled either, because
		// `acknowledgeMissedReveal` refuses a commitment from the current cycle;
		// and the cycle cannot advance past it. It takes a build that changed
		// `turnFor` or `secretFor` between a commit and its reveal to reach, and
		// the commit path above is what stops that happening in the ordinary
		// case. Starting a new world is the remedy, which is what leaving the
		// table does.
		console.warn(
			'an offline player is holding a commitment this build cannot open, so the cycle cannot close',
			{identity: player.identity, cycleNumber},
		);
	}

	async function act(
		player: OfflinePlayer,
		cycle: {cycleNumber: number; commiting: boolean},
	): Promise<void> {
		const avatar = await avatarOf(player);

		// DEAD, so there is nothing it can do and nothing waiting on it. Every
		// write below would revert (`_makeCommitment` refuses a dead avatar), and
		// the attendance reader has already stopped counting it, so the cycle
		// closes without it. This is the shape "reveal or die" takes in this
		// loop: a player the world stopped being able to play for.
		if (avatar.life === 0) return;

		const onChain = await commitmentOf(player);

		// A COMMITMENT FROM A PAST CYCLE IS SETTLED RATHER THAN CARRIED, and this
		// is the safety valve the whole world depends on. However it happened -
		// the tab closed between a commit and its reveal, a send that never
		// landed - the contract refuses every later `commit` until it is
		// acknowledged. Left alone, ONE of these players goes silent for good and
		// three cycles later the world is short a member.
		//
		// IT SPENDS NOTHING, which is the difference from upstream and is worth
		// keeping straight: there the same call burns a bonded stake and is
		// justified on the grounds that the bond is the world's own. Here
		// `_acknowledgeMissedReveal` takes nothing at all. The loss already
		// happened when the reveal did not, and is counted by `lastEpoch` falling
		// behind; this only unblocks the next commitment.
		if (onChain.epoch !== 0n && Number(onChain.epoch) < cycle.cycleNumber) {
			await send(player, {
				functionName: 'acknowledgeMissedReveal',
				args: [player.identity],
			});
			return;
		}

		if (cycle.commiting)
			await commit(player, cycle.cycleNumber, onChain, avatar);
		else await reveal(player, cycle.cycleNumber, onChain, avatar);
	}

	/**
	 * One pass over the table, and whether it sent anything.
	 *
	 * THE LOOP AROUND THIS IS THE FRAMEWORK'S and this is what it calls. The
	 * boolean is how `onActed` fires, read off the keyring's own counter either
	 * side of the work rather than a flag this file would have to reset.
	 */
	async function pass(): Promise<boolean> {
		const before = keys.sends();
		try {
			const cycle = await readCycle();
			const at = {
				cycleNumber: cycle.cycleNumber,
				commiting: cycle.isCommitPhase,
			};
			// IN SEQUENCE, NOT IN PARALLEL. Each of these players is a separate
			// account so their nonces do not collide, but they share one chain in
			// one worker, and a burst of three commits is three blocks nothing is
			// waiting for. Sequential also means a revert stops the pass instead
			// of being one rejected promise among several.
			for (const player of players) {
				await act(player, at);
			}
		} catch (err) {
			// A FAILED PASS IS NOT AN ERROR ANYBODY CAN ACT ON, and there is
			// nowhere to report it: these players have no UI. The next pass sees
			// the same chain and tries again, which is the right behaviour for
			// every transient cause (a commit that lost a race with somebody
			// else's advance, most of all). Swallowed HERE rather than in the loop,
			// which is what lets the loop insist a pass resolves.
			console.warn('an offline player could not act this pass', err);
		}
		// A send that reverted still happened, and the poke is worth doing anyway:
		// whatever refused it is a change in the world the advance client has not
		// seen yet.
		return keys.sends() > before;
	}

	return createSerialisedLoop({
		pass,
		onActed: params.onActed,
		pollInterval: params.pollInterval,
	});
}
