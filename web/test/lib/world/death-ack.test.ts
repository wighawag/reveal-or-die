import {describe, expect, it} from 'vitest';
import {
	createDeathAcknowledgement,
	deathAckKey,
	type AckStorage,
} from '$lib/world/ui/death-ack';

/**
 * Acknowledging a death, durably.
 *
 * The bug this pins: the dismissal lived only in the component, so the news
 * repeated on every reload and the only escape was buying another avatar. The
 * interesting behaviour is what one stored acknowledgement DOES and DOES NOT
 * settle - it must settle the death it was given while still letting a new
 * death of the same avatar through.
 */
function memory(): AckStorage & {dump(): Map<string, string>} {
	const entries = new Map<string, string>();
	return {
		getItem: (key) => entries.get(key) ?? null,
		setItem: (key, value) => void entries.set(key, value),
		dump: () => entries,
	};
}

const scoped = (storage: AckStorage) =>
	createDeathAcknowledgement({
		chainID: 1,
		gameAddress: '0x00000000000000000000000000000000000000aa',
		storage,
	});

describe('acknowledging a death', () => {
	it('is unset until acknowledged, and set after', () => {
		const ack = scoped(memory());
		const death = {avatarID: 5n, deathEpoch: 12};
		expect(ack.isAcknowledged(death)).toBe(false);
		ack.acknowledge(death);
		expect(ack.isAcknowledged(death)).toBe(true);
	});

	it('survives a reload, which is the whole point', () => {
		// A SECOND instance over the same storage is what a reload is: the
		// component is rebuilt and reads what the previous one wrote.
		const storage = memory();
		scoped(storage).acknowledge({avatarID: 5n, deathEpoch: 12});
		expect(scoped(storage).isAcknowledged({avatarID: 5n, deathEpoch: 12})).toBe(
			true,
		);
	});

	it('still shows the news when the SAME avatar dies again', () => {
		// `lastEpoch` only advances on reveals, so a second death is a strictly
		// later epoch. Settling the avatar "in general" would swallow it.
		const ack = scoped(memory());
		ack.acknowledge({avatarID: 5n, deathEpoch: 12});
		expect(ack.isAcknowledged({avatarID: 5n, deathEpoch: 30})).toBe(false);
		ack.acknowledge({avatarID: 5n, deathEpoch: 30});
		expect(ack.isAcknowledged({avatarID: 5n, deathEpoch: 30})).toBe(true);
		// and the older acknowledgement is still settled
		expect(ack.isAcknowledged({avatarID: 5n, deathEpoch: 12})).toBe(true);
	});

	it('keeps avatars apart', () => {
		const ack = scoped(memory());
		ack.acknowledge({avatarID: 5n, deathEpoch: 12});
		expect(ack.isAcknowledged({avatarID: 6n, deathEpoch: 12})).toBe(false);
	});

	it('is scoped per chain and game, like the round storage', () => {
		const storage = memory();
		scoped(storage).acknowledge({avatarID: 5n, deathEpoch: 12});
		const elsewhere = createDeathAcknowledgement({
			chainID: 2,
			gameAddress: '0x00000000000000000000000000000000000000aa',
			storage,
		});
		expect(elsewhere.isAcknowledged({avatarID: 5n, deathEpoch: 12})).toBe(
			false,
		);
	});

	it('degrades to "the notice shows again" with no storage at all', () => {
		// Nowhere to record it, so nothing is settled. Annoying, and honest:
		// the alternative would be pretending the news was delivered.
		const ack = createDeathAcknowledgement({
			chainID: 1,
			gameAddress: '0x00000000000000000000000000000000000000aa',
		});
		expect(ack.isAcknowledged({avatarID: 5n, deathEpoch: 12})).toBe(false);
		expect(() => ack.acknowledge({avatarID: 5n, deathEpoch: 12})).not.toThrow();
	});

	it('treats an unreadable entry as never acknowledged', () => {
		const storage = memory();
		storage.setItem(
			deathAckKey({
				chainID: 1,
				gameAddress: '0x00000000000000000000000000000000000000aa',
				avatarID: 5n,
			}),
			'not a number',
		);
		expect(scoped(storage).isAcknowledged({avatarID: 5n, deathEpoch: 12})).toBe(
			false,
		);
	});
});
