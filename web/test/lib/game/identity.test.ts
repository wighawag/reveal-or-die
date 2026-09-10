import {describe, expect, it, vi} from 'vitest';
import {get, writable} from 'svelte/store';
import {createActiveIdentity} from '$lib/game/identity';

/**
 * WHO IS PLAYING, on a game where that has to be looked up.
 *
 * A branch-only suite, because the thing it tests exists only here: upstream
 * the identity is the account and the provider is one line returning it. Here
 * an account owns avatars, an avatar plays, and the answer comes off the
 * chain - which introduces three states that upstream does not have, all of
 * which are wrong in a way nothing else would report.
 *
 * The one that matters most is the LIST BEING STALE. `getAvatarsOf` is
 * append-only by design (see `UsingAvatarIdentity`), so it holds every avatar
 * this account has ever put in, including the ones it has taken back out and
 * the ones it has LOST by never revealing. Trusting it would let a player go
 * on playing an avatar the contract has seized: every commit would revert with
 * `InvalidPlayer`, the board would look fine, and the stake would appear not
 * to have been taken. So custody is asked about each candidate, and this is
 * where that is pinned.
 */

function fakeDeps(custody: {
	avatarsOf: Record<string, bigint[]>;
	ownerOf: Record<string, string>;
}) {
	const reads: string[] = [];
	return {
		reads,
		deps: {
			deployments: {
				get: () => ({contracts: {Game: {address: '0xgame', abi: []}}}),
			},
			publicClient: {
				readContract: async ({
					functionName,
					args,
				}: {
					functionName: string;
					args?: readonly unknown[];
				}) => {
					reads.push(functionName);
					if (functionName === 'getAvatarsOf') {
						return custody.avatarsOf[String(args?.[0]).toLowerCase()] ?? [];
					}
					if (functionName === 'getAvatarOwner') {
						return (
							custody.ownerOf[String(args?.[0])] ??
							'0x0000000000000000000000000000000000000000'
						);
					}
					throw new Error(`unexpected read ${functionName}`);
				},
			},
		},
	} as never as {
		reads: string[];
		deps: Parameters<typeof createActiveIdentity>[0]['deps'];
	};
}

const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

describe('the active identity', () => {
	it('plays the avatar the game still holds for this account', async () => {
		const {deps} = fakeDeps({
			avatarsOf: {[OWNER]: [4n]},
			ownerOf: {'4': OWNER},
		});
		const identity = createActiveIdentity({
			account: writable(OWNER as `0x${string}`),
			deps,
		});

		await identity.update();

		expect(get(identity)).toBe(4n);
		expect(get(identity.loaded)).toBe(true);
	});

	it('skips an avatar this account no longer holds', async () => {
		// The seized case, which is the stake actually being taken. The id stays
		// in the account's list forever; what changes is custody.
		const {deps} = fakeDeps({
			avatarsOf: {[OWNER]: [4n, 9n]},
			ownerOf: {
				// 4 was lost by missing a reveal: the game cleared the owner.
				'4': '0x0000000000000000000000000000000000000000',
				'9': OWNER,
			},
		});
		const identity = createActiveIdentity({
			account: writable(OWNER as `0x${string}`),
			deps,
		});

		await identity.update();

		expect(get(identity)).toBe(9n);
	});

	it('has no identity when every avatar is gone, and says it has looked', async () => {
		// The two halves are a pair: `undefined` alone is also what "not read
		// yet" looks like, and the setup gate has to tell them apart or it
		// covers a playable board on every load.
		const {deps} = fakeDeps({
			avatarsOf: {[OWNER]: [4n]},
			ownerOf: {'4': '0x0000000000000000000000000000000000000000'},
		});
		const identity = createActiveIdentity({
			account: writable(OWNER as `0x${string}`),
			deps,
		});

		await identity.update();

		expect(get(identity)).toBe(undefined);
		expect(get(identity.loaded)).toBe(true);
	});

	it('has NOT looked when nobody is signed in', async () => {
		// A read about an account that does not exist would let the stake gate
		// answer a question only the sign-in gate should.
		const {deps, reads} = fakeDeps({avatarsOf: {}, ownerOf: {}});
		const identity = createActiveIdentity({
			account: writable(undefined),
			deps,
		});

		await identity.update();

		expect(get(identity.loaded)).toBe(false);
		expect(reads).toEqual([]);
	});

	it('answers again when the account changes', async () => {
		// Switching accounts in the wallet changes who is playing, and no
		// consumer should have to remember to say so.
		const {deps} = fakeDeps({
			avatarsOf: {[OWNER]: [4n], [OTHER]: [8n]},
			ownerOf: {'4': OWNER, '8': OTHER},
		});
		const account = writable<`0x${string}` | undefined>(OWNER as `0x${string}`);
		const identity = createActiveIdentity({account, deps});
		await identity.update();
		expect(get(identity)).toBe(4n);

		account.set(OTHER as `0x${string}`);

		// NOTHING CALLS `update()` HERE, deliberately, and the first version of
		// this test did - which made it pass with the subscription deleted. The
		// whole claim is that the store notices for itself, so the test has to
		// wait for an answer it did not ask for. Found by mutation.
		await vi.waitFor(() => expect(get(identity)).toBe(8n));
	});

	it('never confuses one account\u2019s avatar for another\u2019s', async () => {
		// The list is read per owner, but the CHECK is what makes it safe: a
		// contract that returned somebody else's id here must not turn it into
		// this account's identity, because the client would then sign
		// commitments it has no authority for and every one would revert.
		const {deps} = fakeDeps({
			avatarsOf: {[OWNER]: [8n]},
			ownerOf: {'8': OTHER},
		});
		const identity = createActiveIdentity({
			account: writable(OWNER as `0x${string}`),
			deps,
		});

		await identity.update();

		expect(get(identity)).toBe(undefined);
	});
});
