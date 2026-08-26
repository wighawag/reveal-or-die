/**
 * What the player has at stake: their avatars, held by the contract.
 *
 * This is where the template keeps a token RESERVE. The shapes are different
 * because the stakes are: there, a player tops up an ERC-20 balance and bonds
 * part of it per round; here, a player deposits an avatar NFT and the game
 * holds it. So there is no amount, no top-up and no per-round bond, and what
 * the context actually wants to know from either is the same single question:
 * can this player take a turn at all.
 */
import {derived, get, writable, type Readable} from 'svelte/store';
import type {Context} from '$lib/context/types';

/** An avatar the contract holds for this owner, as `avatarsPerOwner` returns it. */
export type DepositedAvatar = {
	avatarID: bigint;
	inGame: boolean;
	position: bigint;
	lastEpoch: bigint;
	life: number;
};

export type DepositedState =
	| {step: 'Unloaded'}
	| {step: 'Loading'}
	| {step: 'Loaded'; avatars: readonly DepositedAvatar[]}
	| {step: 'Error'; error: unknown};

export type DepositedStore = Readable<DepositedState> & {
	readonly value: DepositedState;
	update(): Promise<void>;
};

export type DepositedDeps = Pick<Context, 'deployments' | 'publicClient'>;

/** Avatars per page. See the loop for why the contract's flag is not used. */
const PAGE_SIZE = 200n;
const MAX_PAGES = 50;

export function createDeposited(params: {
	deps: DepositedDeps;
	/** The account whose avatars these are; undefined when nobody is signed in. */
	owner: Readable<`0x${string}` | undefined>;
}): DepositedStore {
	const {deps, owner} = params;

	const state = writable<DepositedState>({step: 'Unloaded'});
	let value: DepositedState = {step: 'Unloaded'};
	state.subscribe((v) => (value = v));

	async function update() {
		const $owner = get(owner);
		if (!$owner) {
			state.set({step: 'Unloaded'});
			return;
		}

		state.set({step: 'Loading'});
		try {
			const Game = get(deps.deployments).contracts.Game;
			const collected: DepositedAvatar[] = [];
			let startIndex = 0n;

			for (let page = 0; page < MAX_PAGES; page++) {
				const [avatars] = (await deps.publicClient.readContract({
					address: Game.address,
					abi: Game.abi,
					functionName: 'avatarsPerOwner',
					args: [$owner, startIndex, PAGE_SIZE],
				})) as unknown as [readonly DepositedAvatar[], boolean];

				// The contract's `more` is IGNORED, deliberately. GameDeposit computes
				// it as `actualLimit != limit`, which is wrong in both directions: a
				// page that exhausts the list reports more (limit was clamped), and a
				// page that exactly fills it reports none (nothing was clamped) even
				// when the list continues. Terminating on an EMPTY page is correct
				// whichever way the flag lies, at the cost of one extra call.
				collected.push(...avatars);
				if (avatars.length === 0) break;
				startIndex += BigInt(avatars.length);
			}

			state.set({step: 'Loaded', avatars: collected});
		} catch (error) {
			state.set({step: 'Error', error});
		}
	}

	return {
		subscribe: state.subscribe,
		get value() {
			return value;
		},
		update,
	};
}

/**
 * Whether the player has anything in the game to play with.
 *
 * The equivalent of the template asking whether the reserve is non-zero, and
 * used for the same thing: letting somebody plan a whole turn they cannot
 * commit is worse than not letting them start, because the moves look accepted
 * and the failure only arrives at the commit.
 */
export const hasAvatarInGame = (state: DepositedState): boolean =>
	state.step === 'Loaded' && state.avatars.length > 0;

/** The store form, for composing into `canPlay`. */
export const derivedHasAvatar = (
	deposited: Readable<DepositedState>,
): Readable<boolean> => derived(deposited, hasAvatarInGame);
