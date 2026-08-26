import {describe, expect, it} from 'vitest';
import {keccak256} from 'viem';
import {buildWorldCommitment} from '$lib/world/commit-reveal';
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
		const actions: Action[] = [{actionType: ActionType.Move, data: pos(2n, 3n)}];
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
		).not.toEqual(buildWorldCommitment({actions: [...b, ...a], secret: SECRET}).hash);
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
