/**
 * A commit secret DERIVED from a key the player already holds, rather than
 * randomised.
 *
 * The framework's default secret is 32 random bytes (`randomSecret` in
 * `round.ts`). It is safe, and it is unrecoverable: it exists only in local
 * storage, so a player who clears site data between the commit and the reveal
 * cannot open their own commitment. In a game with a stake that is not a
 * nuisance, it is the stake.
 *
 * A derived secret is a signature over a message that names the round, hashed.
 * The same key produces the same signature, so the secret can be recomputed on
 * another device, or in the same browser after its storage is gone.
 *
 * WHAT THIS DOES NOT RECOVER, and it is half the problem rather than a detail:
 * the ACTIONS. A commitment is `hash(secret, actions)` and the chain holds only
 * the hash, so the plan is not recoverable from anything here. Where a game's
 * action space is small enough it can be recovered by ENUMERATION once the
 * secret is in hand, and that is the game's own code because only the game
 * knows its space. Where it cannot, "recoverable" honestly means "a device that
 * still has the plan". See `games-on-this-foundation.md` D9 on the template's
 * `work` branch.
 */
import {keccak256} from 'viem';
import type {PlayerIdentity} from './seams.js';

/**
 * Sign a message with a key the player holds and keeps.
 *
 * Deliberately a function rather than a key: the framework never wants a
 * private key, and a caller may be signing through a wallet, a local account or
 * a remote signer without any of that being this module's business.
 *
 * It MUST be the same key on every device the player recovers from, which in
 * this template is the local signer: sign-in derives it from a signature over
 * an origin-scoped message the wallet produces locally, so the same account
 * derives the same signer anywhere. Signing with the ACCOUNT would be equally
 * recoverable and would cost a wallet prompt on every commit, which is the
 * thing the signer exists to remove.
 */
export type SignMessage = (message: string) => Promise<`0x${string}`>;

/**
 * Build the `makeSecret` a round takes.
 *
 * The message is `Commit:<chainId>:<contract>:<identity>:<cycle>`, which names
 * every axis along which two secrets must differ.
 *
 * THE IDENTITY IS IN THE MESSAGE, and leaving it out is a real hole rather than
 * an omission. Where one account controls several identities (conquest's
 * empires), a message without it derives the SAME secret for all of them; a
 * small action space is enumerable against a known secret and a published hash,
 * so one of the player's own identities can open another's commitment, and so
 * can anyone else holding that secret. That enumeration is the same computation
 * a game uses to recover its own actions, and the only thing separating the two
 * is who holds the secret - which is exactly why the secret must not be shared
 * across identities.
 *
 * The chain id and the contract are in it for the ordinary reason: the same
 * cycle of the same game on another chain, or another deployment on the same
 * chain, is a different round.
 */
export function createDerivedSecret<TIdentity extends PlayerIdentity>(params: {
	sign: SignMessage;
	/** The chain the game is deployed on. */
	chainId: number | string;
	/** The game contract. For a routed game, the address the player calls. */
	contract: `0x${string}`;
}): (params: {
	cycleNumber: number;
	identity: TIdentity;
}) => Promise<`0x${string}`> {
	const {sign} = params;
	// NORMALISED ONCE, HERE, and this is the sharp edge of the whole module. The
	// message is a string, so any difference in spelling is a different
	// signature and therefore a different secret - and the failure is silent:
	// nothing throws, the commitment is simply one the player can no longer
	// open, and they find out when the reveal window closes on their stake. An
	// address is the one that will actually bite, because a checksummed literal
	// and a lowercased one are the same address and different text, and both
	// spellings are in circulation in every deployment file.
	const chainId = String(params.chainId);
	const contract = params.contract.toLowerCase();

	return async ({cycleNumber, identity}) => {
		const message = `Commit:${chainId}:${contract}:${identityToMessagePart(identity)}:${cycleNumber}`;
		// Hashed rather than used raw: a signature is 65 bytes and the commitment
		// wants 32, and hashing also means the secret is not itself a valid
		// signature over anything if it ever leaks.
		return keccak256(await sign(message));
	};
}

/**
 * How an identity is spelled in the message.
 *
 * Both shapes of `PlayerIdentity` get one canonical spelling, for the reason
 * above: a bigint has exactly one decimal form, and an address is lowercased so
 * that a checksummed one and a lowercased one agree. A game with an identity
 * type of its own passes it through here as one of the two.
 */
function identityToMessagePart(identity: PlayerIdentity): string {
	return typeof identity === 'bigint'
		? identity.toString(10)
		: identity.toLowerCase();
}
