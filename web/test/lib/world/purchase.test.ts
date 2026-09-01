import {describe, expect, it} from 'vitest';
import {decodeAbiParameters, zeroAddress} from 'viem';
import {
	opensAWallet,
	purchaseArgs,
	purchaseAuthorisation,
} from '$lib/world/purchase';
import {availablePaymentMethods, paymentMethods} from '$lib/core/funding';
import {consentBullets} from '$lib/ui/delegation/grant';
import {
	avatarIDFor,
	ownerOfAvatarID,
	randomSubID,
} from 'reveal-or-die-contracts';

/**
 * Six positional arguments, two of which are addresses that mean opposite
 * things.
 *
 * `AvatarsSale.purchase(to, subID, data, tipTo, tipAmount, referrer)` takes the
 * recipient of the NFT as `to` and the OWNER encoded inside `data`. Here `to` is
 * the Game, so the avatar arrives already deposited, and the owner is the
 * player. Swapping them does not revert: it mints a perfectly good avatar into
 * the player's wallet, where `avatarsPerOwner` never sees it and every commit
 * fails. That failure is why this list is a pure function with a test rather
 * than an inline array.
 */

const GAME = '0x000000000000000000000000000000000000dead' as const;
const PLAYER = '0x1111111111111111111111111111111111111111' as const;

describe('the arguments to AvatarsSale.purchase', () => {
	it('sends the avatar to the GAME, not to the player', () => {
		const [to] = purchaseArgs({gameAddress: GAME, owner: PLAYER, subID: 1n});
		expect(to).toBe(GAME);
		expect(to).not.toBe(PLAYER);
	});

	it('names the player as the owner, in the data payload', () => {
		const [, , data] = purchaseArgs({
			gameAddress: GAME,
			owner: PLAYER,
			subID: 1n,
		});
		const [decoded] = decodeAbiParameters([{type: 'address'}], data);
		expect(decoded.toLowerCase()).toBe(PLAYER);
	});

	it('carries the subID through untouched', () => {
		const subID = 123456789n;
		const [, id] = purchaseArgs({gameAddress: GAME, owner: PLAYER, subID});
		expect(id).toBe(subID);
	});

	it('asks for no tip and no referrer', () => {
		// Both are `SaleViaNativePayment` machinery this game does not use, and a
		// non-zero tip recipient would silently take part of the payment, leaving
		// `paymentAmount != PAYMENT_AMOUNT` and reverting the purchase.
		const [, , , tipTo, tipAmount, referrer] = purchaseArgs({
			gameAddress: GAME,
			owner: PLAYER,
			subID: 1n,
		});
		expect(tipTo).toBe(zeroAddress);
		expect(tipAmount).toBe(0n);
		expect(referrer).toBe(zeroAddress);
	});
});

describe('the avatar id these arguments will produce', () => {
	/**
	 * The packing itself lives in the contracts package and is pinned against a
	 * real chain by `contracts/test/js/Game.test.ts`, which purchases with these
	 * arguments and then commits for this id. What is checked here is only that
	 * the app can name the avatar it is about to buy BEFORE the transaction is
	 * sent, which is what makes the purchase reportable.
	 */
	it('is derivable from the owner and subID alone', () => {
		expect(avatarIDFor(PLAYER, 0n)).toBe(BigInt(PLAYER) << 96n);
		expect(avatarIDFor(PLAYER, 7n)).toBe((BigInt(PLAYER) << 96n) + 7n);
	});

	it('round-trips back to the owner', () => {
		const id = avatarIDFor(PLAYER, randomSubID());
		expect(ownerOfAvatarID(id)).toBe(PLAYER);
	});
});

describe('the random subID', () => {
	it('fits in the uint96 the contract takes', () => {
		// A value that overflows uint96 would be truncated by abi encoding, so the
		// avatar minted would not be the one the client computed, and the client
		// would be left committing for an id that does not exist.
		const limit = 1n << 96n;
		for (let i = 0; i < 64; i++) {
			const subID = randomSubID();
			expect(subID).toBeGreaterThanOrEqual(0n);
			expect(subID).toBeLessThan(limit);
		}
	});

	it('does not repeat', () => {
		// Not a cryptographic claim, just enough to catch a generator that returns
		// a constant, which would make every second purchase revert as
		// already-minted.
		const seen = new Set<bigint>();
		for (let i = 0; i < 64; i++) seen.add(randomSubID());
		expect(seen.size).toBe(64);
	});
});

describe('what the player is shown before their wallet opens', () => {
	/**
	 * Two shortcuts I took, both of which put a wallet dialog in front of someone
	 * who had not been told what it was.
	 *
	 * Neither is testable end to end without a wallet, so what is pinned here is
	 * the DECISION each one turns on. Both were wrong in the same direction:
	 * skipping a step the template already had, because with one obvious answer
	 * the step looked like ceremony.
	 */
	it('offers the choice whenever there is more than one method to show', () => {
		// The bug: with an empty account the only USABLE method was the payment
		// rail, so the chooser was skipped and the player went straight into a
		// wallet picker, never told that paying from their account was an option
		// or why it was refused. `paymentMethods` fills in `unavailableReason` for
		// exactly that, which is worth nothing if the entry is never rendered.
		const methods = paymentMethods({
			accountSpendable: 0n,
			ownerCanSend: true,
			walletsAvailable: 1,
		});
		expect(methods).toHaveLength(2);
		expect(availablePaymentMethods(methods)).toHaveLength(1);

		const account = methods.find((m) => m.id === 'account');
		expect(account?.available).toBe(false);
		// The reason is the whole point of showing it greyed out rather than not
		// at all.
		expect(account?.unavailableReason).toBeTruthy();
	});

	it('has something to say before asking for a signature', () => {
		// The consent list, from the app's own grant. The bug was not that this
		// list was wrong; it was that nothing showed it, so the first the player
		// heard of authorising this browser was their wallet presenting a message
		// to sign. A signature prompt with no preceding explanation is the one
		// thing a careful user is right to refuse.
		const bullets = consentBullets({action: 'play your moves'});
		expect(bullets.length).toBeGreaterThan(1);
		expect(bullets[0]).toContain('play your moves');
		// It has to say what the key CANNOT do, or "authorise" is the word every
		// drainer uses and nothing distinguishes this from one.
		expect(bullets.join(' ')).toMatch(/cannot move your funds/i);
		expect(bullets.join(' ')).toMatch(/withdraw it later/i);
	});
});

describe('how this purchase will authorise the browser', () => {
	/**
	 * The question the dialog's words hang on, and it was being answered by
	 * `signsWithoutPrompt` alone - which recognises the development burner by
	 * name and NOTHING else. So a hosted account, whose credential was minted at
	 * sign-in and is handed back without a prompt, was told "one signature, then
	 * the purchase" and offered a "Sign and buy" button for a signature that was
	 * never going to be requested.
	 *
	 * The inputs are the shared readers' own answers (`isRegistered`,
	 * `DelegationAccount.canSignLive`, `signsWithoutPrompt`), so this pins the
	 * RULE rather than a second reading of a connection.
	 */
	const hosted = {
		registered: false,
		hasSigner: true,
		ownerCanSignLive: false,
		silentWallet: false,
	};

	it('asks a hosted account for nothing: its credential already exists', () => {
		expect(purchaseAuthorisation(hosted)).toBe('pre-signed');
		expect(opensAWallet('pre-signed')).toBe(false);
	});

	it('asks a wallet owner to sign, live', () => {
		expect(purchaseAuthorisation({...hosted, ownerCanSignLive: true})).toBe(
			'live-signature',
		);
		expect(opensAWallet('live-signature')).toBe(true);
	});

	it('knows the one wallet that signs without showing anything', () => {
		// The development burner holds its key in this browser. It IS signing, so
		// it is not the hosted case, and nothing pops up, so it is not the wallet
		// case either.
		expect(
			purchaseAuthorisation({
				...hosted,
				ownerCanSignLive: true,
				silentWallet: true,
			}),
		).toBe('silent-signature');
		expect(opensAWallet('silent-signature')).toBe(false);
	});

	it('has nothing to authorise when the signer is already a delegate', () => {
		// A second avatar, on a browser that was authorised for the first. There is
		// no consent to take and no stipend to forward: it is only a purchase.
		expect(
			purchaseAuthorisation({...hosted, registered: true}),
		).toBeUndefined();
	});

	it('has nothing to authorise when there is no signer at all', () => {
		// A build with no sign-in derives no signer, so the player plays through
		// their wallet and there is no key to authorise. Asking them to consent to
		// one would describe something that does not exist.
		expect(
			purchaseAuthorisation({...hosted, hasSigner: false}),
		).toBeUndefined();
	});
});
