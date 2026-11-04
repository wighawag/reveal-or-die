import {describe, expect, it} from 'vitest';
import {writable} from 'svelte/store';
import {
	createDeposited,
	hasAvatarInGame,
	isAtRisk,
	type DepositedAvatar,
	type DepositedState,
} from '$lib/world/deposited';
import {chooseActiveAvatar} from '$lib/world/active-avatar';

const avatar = (o: Partial<DepositedAvatar> = {}): DepositedAvatar => ({
	avatarID: 1n,
	inGame: true,
	position: 0n,
	lastCycleNumber: 6n,
	life: 1,
	...o,
});

const loaded = (...avatars: DepositedAvatar[]): DepositedState => ({
	step: 'Loaded',
	avatars,
});

/**
 * What `commitWhenIdle` is actually asking.
 *
 * The client commits an empty turn every cycle the player stands still,
 * because this contract kills an avatar that goes quiet. The question that
 * decides whether to spend that gas is "does this avatar have anything to
 * lose", and it was being answered with "is it standing somewhere", which is a
 * different question for exactly one avatar: a dead one.
 */
describe('whether an avatar has anything to lose by going quiet', () => {
	it('says yes for an avatar standing in the world', () => {
		expect(isAtRisk(loaded(avatar()), 1n)).toBe(true);
	});

	it('says no for a DEAD avatar, which keeps its position', () => {
		// The body stays where it fell, so it still reads as "in the world" with a
		// position. Nothing about it is at stake any more, and `_makeCommitment`
		// reverts with `AvatarIsDead`: committing for it is a transaction the
		// signer pays for and the contract refuses, once a cycle, forever.
		expect(isAtRisk(loaded(avatar({life: 0})), 1n)).toBe(false);
	});

	it('says no for an avatar waiting to enter', () => {
		// `_getResolvedAvatar` forces `life = 1` while it is not in the world, so
		// no clock is running against it and an empty turn would prevent nothing.
		expect(isAtRisk(loaded(avatar({inGame: false})), 1n)).toBe(false);
	});

	it('says no when there is no avatar to ask about, or no read yet', () => {
		expect(isAtRisk(loaded(avatar()), undefined)).toBe(false);
		expect(isAtRisk(loaded(avatar({avatarID: 2n})), 1n)).toBe(false);
		expect(isAtRisk({step: 'Loading'}, 1n)).toBe(false);
		expect(isAtRisk({step: 'Unloaded'}, 1n)).toBe(false);
	});

	it('agrees with the avatar the client would actually be playing', () => {
		// Two rules about the same corpse, in two files: `chooseActiveAvatar`
		// refuses to select a dead avatar, and this refuses to commit for one.
		// Drift between them is a client that keeps a loop running for an avatar
		// it will not let anybody move.
		const dead = loaded(avatar({life: 0}));
		const chosen = chooseActiveAvatar({
			avatars: [avatar({life: 0})],
			preferred: 1n,
		});
		expect(chosen).toBeUndefined();
		expect(isAtRisk(dead, 1n)).toBe(false);
		// And the setup gate says the same thing a third time.
		expect(hasAvatarInGame(dead)).toBe(false);
	});
});

/**
 * ONLY THE LATEST READ MAY ANSWER, and only for the account still signed in.
 * Every account change starts a read, and on a busy chain they finish in any
 * order: a hotseat switch (and the wallet's own auto-connect landing after it)
 * starts several within milliseconds, and the first person's avatars arriving
 * after the second person's would put them under the second person's account.
 * The template found this in its own identity store (template-commit-reveal
 * 36fb7140); this game reads custody here instead.
 */
describe('reading custody while the account changes', () => {
	const A = '0x000000000000000000000000000000000000000a' as const;
	const B = '0x000000000000000000000000000000000000000b' as const;

	function fakeChain() {
		const pending: {owner: string; resolve: (v: unknown) => void}[] = [];
		return {
			pending,
			deps: {
				deployments: writable({
					contracts: {Game: {address: '0x1', abi: []}},
				}),
				publicClient: {
					readContract: (request: {args: [string, bigint, bigint]}) =>
						new Promise((resolve) =>
							pending.push({owner: request.args[0], resolve}),
						),
				},
			} as never,
		};
	}
	const page = (...ids: bigint[]) => [
		ids.map((id) => avatar({avatarID: id})),
		false,
	];
	const flush = () => new Promise((r) => setTimeout(r, 0));

	it('drops an older read that lands after a newer one', async () => {
		const chain = fakeChain();
		const owner = writable<`0x${string}` | undefined>(A);
		const deposited = createDeposited({deps: chain.deps, owner});

		const first = deposited.update();
		owner.set(B);
		const second = deposited.update();
		await flush();
		const [forA, forB] = chain.pending;
		expect(forA.owner).toBe(A);
		expect(forB.owner).toBe(B);

		// B's custody lands first and is complete (the next page is empty)...
		forB.resolve(page(2n));
		await flush();
		chain.pending[2].resolve(page());
		await second;
		expect(deposited.value).toMatchObject({step: 'Loaded'});

		// ...then A's arrives, late. It must not replace B's.
		forA.resolve(page(1n));
		await flush();
		chain.pending[3]?.resolve(page());
		await first;
		const value = deposited.value;
		expect(value.step).toBe('Loaded');
		if (value.step === 'Loaded') {
			expect(value.avatars.map((a) => a.avatarID)).toEqual([2n]);
		}
	});
});
