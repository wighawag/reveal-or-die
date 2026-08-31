import {beforeEach, describe, expect, it} from 'vitest';
import {writable} from 'svelte/store';
import {keccak256} from 'viem';
import {
	buildWorldCommitment,
	createWorldCommitReveal,
} from '$lib/world/commit-reveal';
import {SignerOutOfFundsError} from '$lib/world/errors';
import {ActionType, type Action} from 'reveal-or-die-contracts';

const SECRET =
	'0x00000000000000000000000000000000000000000000000000000000000000aa' as const;

const pos = (x: bigint, y: bigint) => (y << 32n) | x;

describe('buildWorldCommitment', () => {
	it('returns a bytes24 hash, which is what the contract stores', () => {
		// 2 for '0x' plus 48 hex digits. A hash of the wrong WIDTH is still a
		// plausible-looking string and never matches, and the mismatch only
		// surfaces at reveal, a phase after the commitment became immovable.
		const {hash} = buildWorldCommitment({
			actions: [{actionType: ActionType.Enter, data: pos(0n, 1n)}],
			secret: SECRET,
		});
		expect(hash).toMatch(/^0x[0-9a-f]{48}$/);
	});

	it('takes the LEFTMOST 24 bytes of the digest', () => {
		// truncating the other end is the mistake that produces a right-shaped
		// hash that never matches
		const actions: Action[] = [
			{actionType: ActionType.Move, data: pos(2n, 3n)},
		];
		const {hash, encoded} = buildWorldCommitment({actions, secret: SECRET});
		expect(hash).toEqual(keccak256(encoded).slice(0, 50));
	});

	it('depends on the actions, their order, and the secret', () => {
		const a: Action[] = [{actionType: ActionType.Move, data: pos(0n, 1n)}];
		const b: Action[] = [{actionType: ActionType.Move, data: pos(0n, 2n)}];
		const base = buildWorldCommitment({actions: a, secret: SECRET}).hash;

		expect(buildWorldCommitment({actions: b, secret: SECRET}).hash).not.toEqual(
			base,
		);
		expect(
			buildWorldCommitment({actions: [...a, ...b], secret: SECRET}).hash,
		).not.toEqual(
			buildWorldCommitment({actions: [...b, ...a], secret: SECRET}).hash,
		);
		expect(
			buildWorldCommitment({
				actions: a,
				secret:
					'0x00000000000000000000000000000000000000000000000000000000000000bb',
			}).hash,
		).not.toEqual(base);
	});

	it('distinguishes action types at the same position', () => {
		// Enter and Move to the same cell are different commitments, so the type
		// has to be inside the hash and not merely alongside it
		const at = pos(1n, 1n);
		expect(
			buildWorldCommitment({
				actions: [{actionType: ActionType.Enter, data: at}],
				secret: SECRET,
			}).hash,
		).not.toEqual(
			buildWorldCommitment({
				actions: [{actionType: ActionType.Move, data: at}],
				secret: SECRET,
			}).hash,
		);
	});
});

describe('a move the signer demonstrably cannot pay for', () => {
	/**
	 * Not sent at all, because a doomed send is not free. On EDR a transaction
	 * the node refuses for want of gas still advances the pending nonce, and the
	 * account is then wedged: every later transaction is built at a nonce the
	 * chain will never reach.
	 *
	 * That lands on the one feature this file is most careful about.
	 * `resumeWhenGasArrives` retries the round once the player tops up, and a
	 * retry at a burned nonce can never mine, so a turn that was recoverable is
	 * lost instead. Here it also blocks the NEXT epoch, because a reveal that
	 * never lands needs `acknowledgeMissedReveal` before anything else can
	 * commit.
	 */
	const balance = (value: bigint | undefined, step = 'Loaded') =>
		writable({step, value});

	function deps(signerBalance: ReturnType<typeof balance>) {
		return {
			connection: {ensureConnected: async () => {}},
			signerExecutor: writable({
				status: 'ready',
				account: '0xacc',
				address: '0xacc',
				client: {
					writeContract: async () => {
						sent++;
						return '0xhash' as `0x${string}`;
					},
				},
			}),
			deployments: writable({contracts: {Game: {address: '0xgame', abi: []}}}),
			publicClient: {
				waitForTransactionReceipt: async () => ({status: 'success'}),
			},
			signerBalance,
		} as never;
	}

	let sent = 0;
	beforeEach(() => (sent = 0));

	it('is refused before it reaches the wire', async () => {
		const adapter = createWorldCommitReveal({deps: deps(balance(0n))});
		await expect(
			adapter.commit({
				identity: 1n,
				hash: '0x1',
				actions: [],
				secret: '0x2',
				epoch: 3,
			}),
		).rejects.toBeInstanceOf(SignerOutOfFundsError);
		expect(sent, 'nothing should have been dispatched').toBe(0);
	});

	it('is the app\u2019s own error type, so the round offers the top-up', () => {
		// `resumeWhenGasArrives` and the HUD both branch on this exact type. A
		// plain Error here would be reported as an unexplained failure with no
		// remedy, which is the state the player cannot act on.
		const error = new SignerOutOfFundsError(new Error('x'));
		expect(error).toBeInstanceOf(SignerOutOfFundsError);
	});

	it('does NOT refuse on a balance it has not read', async () => {
		// Deliberately narrow: an unloaded or stale store falls through to the
		// behaviour that shipped before this. Refusing on "we do not know yet"
		// would block every move made before the first balance poll returns.
		const adapter = createWorldCommitReveal({
			deps: deps(balance(undefined, 'Unloaded')),
		});
		await adapter.commit({
			identity: 1n,
			hash: '0x1',
			actions: [],
			secret: '0x2',
			epoch: 3,
		});
		expect(sent).toBe(1);
	});

	it('does not refuse a signer that holds something', async () => {
		const adapter = createWorldCommitReveal({deps: deps(balance(1n))});
		await adapter.commit({
			identity: 1n,
			hash: '0x1',
			actions: [],
			secret: '0x2',
			epoch: 3,
		});
		expect(sent).toBe(1);
	});
});
