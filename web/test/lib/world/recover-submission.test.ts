import {describe, expect, it} from 'vitest';
import {get, writable} from 'svelte/store';
import {
	candidateTurns,
	recoverByEnumeration,
	searchForTurn,
	SEARCH_BUDGET,
	type SearchOutcome,
} from '$lib/world/recover-submission';
import type {LiveCommitment, RecoveryState} from '$lib/game/core/recovery';
import {
	ActionType,
	CellType,
	cellTypeAt,
	commitmentHash,
	isObstacle,
	xyToBigIntID,
	type Action,
	type Position,
} from 'reveal-or-die-contracts';
import {buildWorldCommitment} from '$lib/world/commit-reveal';

const SECRET = ('0x' + '11'.repeat(32)) as `0x${string}`;

/** A floor cell to walk from, found on the real map rather than invented. */
function aFloorCell(): Position {
	for (let x = -8; x <= 8; x++)
		for (let y = -8; y <= 8; y++) if (!isObstacle(x, y)) return {x, y};
	throw new Error('the generated map has no floor near the origin');
}

/** The exit tile, if one is near enough to walk to. */
function anExitCell(): Position | undefined {
	for (let x = -24; x <= 24; x++)
		for (let y = -24; y <= 24; y++)
			if (cellTypeAt(x, y) === CellType.Exit) return {x, y};
	return undefined;
}

const move = (to: Position): Action => ({
	actionType: ActionType.Move,
	data: xyToBigIntID(to.x, to.y),
});

/** Run a search to completion with no real timers. */
const search = (over: Partial<Parameters<typeof searchForTurn>[0]>) =>
	searchForTurn({
		from: aFloorCell(),
		numMoves: 10,
		secret: SECRET,
		hash: '0xdeadbeef' as `0x${string}`,
		buildCommitment: buildWorldCommitment,
		yieldToBrowser: async () => {},
		...over,
	});

describe('every turn the avatar could have committed to', () => {
	it('offers the EMPTY turn first, because that is the one the client sends by itself', () => {
		// `commitWhenIdle` commits an empty turn every cycle to keep an idle
		// avatar alive, so it is much the most likely single candidate. Trying it
		// last would spend the whole budget on the commonest case.
		const first = candidateTurns({from: aFloorCell(), numMoves: 3}).next();
		expect(first.value).toEqual([]);
	});

	it('grows shortest-first, so a one-step turn is found before the long walks', () => {
		const lengths: number[] = [];
		let seen = 0;
		for (const turn of candidateTurns({from: aFloorCell(), numMoves: 4})) {
			lengths.push(turn.filter((a) => a.actionType === ActionType.Move).length);
			if (++seen > 200) break;
		}
		// Never decreasing: a search that stops at the first match then costs what
		// the ACTUAL turn was worth, not what the longest possible one costs.
		const sorted = [...lengths].sort((a, b) => a - b);
		expect(lengths).toEqual(sorted);
	});

	it('never walks into a wall', () => {
		let checked = 0;
		for (const turn of candidateTurns({from: aFloorCell(), numMoves: 5})) {
			for (const action of turn) {
				const at = {
					x: Number(BigInt.asIntN(32, action.data)),
					y: Number(BigInt.asIntN(32, action.data >> 32n)),
				};
				expect(isObstacle(at.x, at.y)).toBe(false);
				checked++;
			}
			if (checked > 2000) break;
		}
		expect(checked).toBeGreaterThan(0);
	});

	it('offers an Exit only where the walk ENDS on the exit tile', () => {
		// `_exit` reads the cell under the avatar and drops the action unless it is
		// the exit, so an exit anywhere else is a candidate that can never be the
		// answer - and offering one everywhere would double the search.
		const exit = anExitCell();
		if (!exit) return; // no exit within reach on this map; nothing to assert
		for (const turn of candidateTurns({from: exit, numMoves: 2})) {
			const last = turn[turn.length - 1];
			if (last?.actionType !== ActionType.Exit) continue;
			const before = turn.slice(0, -1);
			const at =
				before.length === 0
					? exit
					: {
							x: Number(BigInt.asIntN(32, before[before.length - 1].data)),
							y: Number(
								BigInt.asIntN(32, before[before.length - 1].data >> 32n),
							),
						};
			expect(cellTypeAt(at.x, at.y)).toBe(CellType.Exit);
		}
	});
});

describe('searching for the turn behind a commitment', () => {
	it('finds a turn the player actually committed, and returns it exactly', async () => {
		const from = aFloorCell();
		// A real one-step turn, hashed the way the contract hashes it.
		const step = [...candidateTurns({from, numMoves: 1})].find(
			(t) => t.length === 1,
		)!;
		const hash = commitmentHash(SECRET, step);

		const outcome = await search({from, hash});

		expect(outcome.step).toBe('found');
		expect(outcome.step === 'found' && outcome.actions).toEqual(step);
	});

	it('finds the EMPTY turn, which is the one an idle avatar commits', async () => {
		const outcome = await search({hash: commitmentHash(SECRET, [])});
		expect(outcome).toEqual({step: 'found', actions: []});
	});

	it('says EXHAUSTED rather than found when the hash is not a turn from here', async () => {
		// It must not return something. A wrong turn adopted is a reveal that
		// reverts, and the submission would have spent the window believing it was safe.
		const outcome = await search({
			numMoves: 3,
			hash: '0x000000000000000000000000000000000000000000000000' as `0x${string}`,
		});
		expect(outcome.step).toBe('exhausted');
	});

	it('refuses a turn hashed with a DIFFERENT secret', async () => {
		// The identity is in the derivation, so this is what one avatar's search
		// looking at another's commitment sees. It must come back empty rather
		// than finding a collision.
		const from = aFloorCell();
		const step = [{...move({x: from.x, y: from.y})}];
		const other = ('0x' + '22'.repeat(32)) as `0x${string}`;
		const outcome = await search({
			from,
			numMoves: 2,
			hash: commitmentHash(other, step),
		});
		expect(outcome.step).toBe('exhausted');
	});

	it('GIVES UP inside the budget instead of pinning the tab', async () => {
		// The budget is what makes this safe on a map more open than this one,
		// where the rule permits a million candidates. Giving up is not failure:
		// it establishes that this is not the cheap case, and the player is asked.
		const outcome = await search({
			budget: 50,
			hash: '0x000000000000000000000000000000000000000000000000' as `0x${string}`,
		});
		expect(outcome).toEqual({step: 'gave-up', tried: 50});
	});

	it('does not search at all for an avatar that is not in the world', async () => {
		// An entry can be at any non-obstacle cell on an unbounded map. There is
		// nothing to enumerate, and spending the budget discovering that would
		// delay the fallback that can actually work.
		expect(await search({from: undefined})).toEqual({step: 'not-searchable'});
	});

	it('lets the browser draw while it works', async () => {
		let breaths = 0;
		// A full ten-move search, which is the real shape: thousands of candidates,
		// not the few hundred a short one produces.
		await search({
			hash: '0x000000000000000000000000000000000000000000000000' as `0x${string}`,
			yieldToBrowser: async () => {
				breaths++;
			},
		});
		// A second of straight-line hashing is a second with no frames, at exactly
		// the moment the player is most likely to be trying to do something.
		expect(breaths).toBeGreaterThan(0);
	});

	it('has a budget big enough for this map, which is the point of the number', async () => {
		// Guards the constant against being tuned down to where the real game stops
		// being recoverable. The worst start measured on the generated map is about
		// 16,000 candidates for a ten-move turn.
		expect(SEARCH_BUDGET).toBeGreaterThan(16_000);
	});
});

/**
 * Running the search unprompted, which is the part with the sharp edges.
 *
 * Wiring that acts on its own is where the expensive mistakes live: this one
 * costs a second of CPU per attempt, it runs while a reveal window is closing,
 * and the state it reacts to re-emits constantly.
 */
describe('searching whenever the chain turns out to hold a lost turn', () => {
	const LIVE: LiveCommitment = {cycleNumber: 5, hash: '0xabc' as `0x${string}`};

	function setup(options?: {
		outcome?: SearchOutcome;
		recovery?: RecoveryState;
		position?: Position;
	}) {
		const recoveryState = writable<RecoveryState>(
			options?.recovery ?? {step: 'Found', cycleNumber: 5},
		);
		const offered: unknown[] = [];
		const runs: unknown[] = [];
		const recovery = {
			subscribe: recoveryState.subscribe,
			get value() {
				return get(recoveryState);
			},
			offer: async (actions: readonly Action[]) => {
				offered.push(actions);
				return true;
			},
		};
		const wiring = recoverByEnumeration({
			recovery,
			currentPosition: writable<Position | undefined>(
				options?.position ?? aFloorCell(),
			),
			identity: writable<bigint | undefined>(1n),
			numMoves: 3,
			makeSecret: () => SECRET,
			buildCommitment: buildWorldCommitment,
			commitment: writable<LiveCommitment | undefined>(LIVE),
			run: async (p) => {
				runs.push(p);
				return options?.outcome ?? {step: 'exhausted', tried: 1};
			},
		});
		return {...wiring, recoveryState, offered, runs};
	}

	const settle = () => new Promise((r) => setTimeout(r, 0));

	it('adopts a turn it finds, THROUGH the framework rather than by itself', async () => {
		// The search is an ORACLE, not an authority. If it could adopt directly, a
		// bug in it could put a wrong turn into the submission and the reveal would
		// revert with the window already closing.
		const found: Action[] = [
			{actionType: ActionType.Move, data: xyToBigIntID(1, 1)},
		];
		const t = setup({outcome: {step: 'found', actions: found}});
		await settle();

		expect(t.offered).toEqual([found]);
		expect(get(t.state)).toEqual({step: 'Idle'});
		t.stop();
	});

	it('asks the player when the search cannot answer, and says which reason', async () => {
		const t = setup({outcome: {step: 'gave-up', tried: 60_000}});
		await settle();

		expect(get(t.state)).toEqual({
			step: 'AskThePlayer',
			cycleNumber: 5,
			reason: 'gave-up',
		});
		expect(t.offered).toEqual([]);
		t.stop();
	});

	it('searches ONCE per submission, however often the state re-emits', async () => {
		// The recovery state is derived from the submission and from a chain read, both
		// of which change constantly. A search costs a second, so restarting on
		// every emission would mean it never finishes and the tab never idles -
		// the worst of both outcomes.
		const t = setup();
		await settle();
		t.recoveryState.set({step: 'Found', cycleNumber: 5});
		t.recoveryState.set({step: 'Found', cycleNumber: 5});
		await settle();

		expect(t.runs).toHaveLength(1);
		t.stop();
	});

	it('does not retry a submission it has already failed on', async () => {
		const t = setup({outcome: {step: 'exhausted', tried: 10}});
		await settle();
		t.recoveryState.set({step: 'Idle'});
		t.recoveryState.set({step: 'Found', cycleNumber: 5});
		await settle();

		expect(t.runs).toHaveLength(1);
		t.stop();
	});

	it('leaves a candidate the PLAYER is offering alone', async () => {
		// `Checking` means the player has pressed the button. Starting a search
		// underneath that would race the answer they are already waiting for.
		const t = setup({recovery: {step: 'Checking', cycleNumber: 5}});
		await settle();
		expect(t.runs).toEqual([]);
		t.stop();
	});

	it('does nothing at all when there is nothing to recover', async () => {
		const t = setup({recovery: {step: 'Idle'}});
		await settle();
		expect(t.runs).toEqual([]);
		expect(get(t.state)).toEqual({step: 'Idle'});
		t.stop();
	});
});
