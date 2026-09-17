// ----------------------------------------------------------------------------
// Typed Config
// ----------------------------------------------------------------------------
import type {
	EnhancedEnvironment,
	UnknownDeployments,
	UserConfig,
} from 'rocketh/types';

// this one provide a protocol supporting private key as account
import {privateKey} from '@rocketh/signer';

import {parseEther} from 'viem';

/**
 * How the cycle advances. Mirrors `UsingGameTypes.CyclePolicy`, whose ORDER is
 * the contract's: these are the enum's numeric values and rearranging them here
 * would silently deploy a different policy from the one named.
 *
 * `Timed` is what a deployed game wants, and it is the only one that needs no
 * transaction to move: the cycle simply is what the clock says.
 *
 * `Manual` has no clock at all. Every phase moves because someone pushed it,
 * and only once every member the cycle waits for has acted - so a member who
 * goes silent freezes it, and the way out is to stop waiting for them rather
 * than to add a timer.
 *
 * `TimedWithEarlyAdvance` is the clock as a DEADLINE, with unanimity able to
 * bring the next phase forward. Never worse than `Timed` for anyone absent,
 * because an advance only ever widens a window.
 *
 * Changing this changes the game the client draws, because it is recorded in
 * the Game's `linkedData` and read back. The e2e suite plays a TIMED game and
 * its waits are sized against the durations below.
 */
export const CYCLE_POLICY = {
	Timed: 0n,
	Manual: 1n,
	TimedWithEarlyAdvance: 2n,
} as const;

// we define our config and export it as "config"
export const config = {
	// Chain properties are exported with the deployments and read by the web app
	// (see web/src/lib/context/config.ts).
	//
	// Adding `creditsGasMultiplier` here is what denominates the local signer's
	// gas balance as CREDITS - "12 credits" instead of "0.0012 ETH" - so a player
	// reads how many moves they can still make rather than a wei figure. It is
	// the gas ONE user action costs, so for this game it is the worst-case gas
	// of a commit plus a reveal, and `creditsPerTopUp` (optional, default 100)
	// is how many credits a top-up buys. Neither is defaulted: half a
	// configuration would produce a confident, wrong move count, so
	// web/src/lib/core/connection/credits.ts falls back to native currency
	// unless it knows what an action actually costs.
	chains: {
		31337: {
			properties: {
				// The worst gas price this chain is expected to charge, in wei.
				// Pessimistic on purpose: it makes a credit count a floor the
				// player always gets, rather than one that drifts down with the
				// mempool while they sit still.
				expectedWorstGasPrice: parseEther('1', 'gwei'), // TODO use same value from hardhat config
				// Gas ONE USER ACTION costs, which since the reveal became chunked is
				// a commit plus ONE REVEAL STEP rather than a commit plus a whole
				// turn. A turn is no longer a transaction: it arrives in
				// `ceil(actions / actionsPerReveal)` reveals, so a long turn honestly
				// costs more credits than a short one, and a credit that still meant
				// "one turn" would be a number with no fixed gas behind it.
				//
				// MEASURED ON THIS BRANCH, not inherited. At four actions per reveal
				// the worst case a single transaction can reach is a FULL chunk of
				// cells claimed for the first time, each in a different zone:
				// `_place` appends to a per-zone index only on a cell's first claim,
				// so four first claims across four zones is four new dynamic arrays.
				//
				//   first commit (cold slots)                 99,102
				//   later commit (warm slots)                 64,902
				//   full fresh chunk, four zones, final      374,085
				//   the same chunk, non-final                368,480
				//
				// So one commit plus one reveal step is 473,187 worst case, and this
				// is that plus about 15%, kept a round number because it is a policy
				// figure with a margin rather than a reading.
				//
				// EVERY ONE OF THOSE FIGURES IS LOWER THAN `main`'s, which measured
				// 116,898 and 535,561 for the same two transactions, and the reason
				// is this branch's stake model rather than anything about the chunk.
				// A placement costs NOTHING here - custody of the avatar is the
				// stake - so a reveal never writes a per-cell stake, never writes a
				// cell total, and never touches the reserve, and a commit bonds
				// zero. Merging `main`'s number in unchanged would have priced a
				// credit 58% above what a step here actually costs, and it would
				// have merged cleanly, because the FILE does not differ: only the
				// contracts the number was measured against do.
				//
				// It is therefore NOT the same number as `COMMIT_GAS + REVEAL_GAS`
				// in web/src/lib/placement/config.ts on this branch, and the two
				// answer different questions: this prices what a step is CHARGED,
				// and that sizes a reservation which is deliberately generous.
				creditsGasMultiplier: 550_000n,
				supportsSendRawTransactionSync: false,
			},
			tags: ['local', 'memory', 'testnet'],
		},
		// mega-eth testnet
		6342: {
			properties: {
				expectedWorstGasPrice: parseEther('0.003', 'gwei'),
				supportsSendRawTransactionSync: false,
			},
		},
		// somnia testnet
		50312: {
			properties: {
				expectedWorstGasPrice: parseEther('8', 'gwei'),
				supportsSendRawTransactionSync: false,
			},
		},
		// celo sepolia testnet
		11142220: {
			properties: {
				expectedWorstGasPrice: parseEther('25', 'gwei'),
				supportsSendRawTransactionSync: false,
			},
		},
	},
	defaultChainProperties: {
		// if not specified, fallback on:
		expectedWorstGasPrice: parseEther('0.000001', 'gwei'),
		supportsSendRawTransactionSync: false,
	},
	accounts: {
		deployer: {
			default: 0,
		},
		admin: {
			default: 0, // TODO give the admin its own account
		},
	},
	environments: {
		localhost: {
			chain: 31337,
			overrides: {
				autoMine: true,
			},
		},
	},
	data: {
		/**
		 * What one stake costs and how much of it you get.
		 *
		 * `price` is in the chain's own currency and is checked EXACTLY by
		 * `StakeSale.purchase`, so it belongs on the sale's deployment and nowhere
		 * else. It is deliberately not zero even here: a free purchase would never
		 * exercise the value split that lets one transaction pay for the stake and
		 * fund the key that plays with it.
		 *
		 * `amount` is ten placements at the placement cost below, which is enough
		 * to play with and small enough that running out is a state the game gets
		 * to demonstrate.
		 */
		sale: {
			default: {
				price: parseEther('0.00000001'),
				amount: parseEther('10'),
			},
		},
		/**
		 * Phase durations, and how much of a turn one transaction may carry.
		 *
		 * `actionsPerReveal` IS THE CHUNK, and it is here rather than in the
		 * contract because the two things that decide it are a property of the GAME
		 * (how expensive one action is to resolve) and of the CHAIN (what fits in a
		 * transaction there). A turn longer than this arrives in several reveals;
		 * the turn itself is not capped, and capping it is a game rule this
		 * framework deliberately does not take a position on.
		 *
		 * Four, and ON THIS BRANCH IT IS THE ONLY BOUND A REVEAL HAS. `main` picks
		 * four so that the chaining is exercised, because there a turn is bounded
		 * economically - the reserve buys ten placements and no more - and a bigger
		 * chunk would simply mean no turn anybody can make ever chains. Here a
		 * placement costs nothing, so there is no economic bound at all: a player
		 * may plan a turn of any length, and without this parameter a single reveal
		 * could walk an unbounded number of cells into the per-zone index that every
		 * other player's viewport read then has to walk.
		 *
		 * So the reasoning is different even though the number is the same, and the
		 * consequence below is different with it. A game built from this template
		 * picks its own, from its own measurements on its own chain.
		 *
		 * The reveal phase is the one to be careful with, and it used to be 3-4
		 * seconds. That is not survivable: a client has to NOTICE the phase turned
		 * over (the chain-synced clock ticks once a second), estimate gas, sign,
		 * broadcast, and then be MINED, all inside the window - and the contract
		 * judges the attempt by the timestamp of the block it lands in, not by when
		 * it was sent. Measured against a local node, a reveal fired the instant the
		 * phase opened still landed about 5 seconds later and reverted with
		 * `InCommitmentPhase`, forfeiting the bond.
		 *
		 * A missed reveal costs the player their stake, so this cannot be tuned
		 * optimistically. Size the reveal phase to comfortably exceed one block time
		 * plus a client round trip; ten seconds is generous on a local chain and is
		 * the floor to think from on a real one.
		 *
		 * AND IT IS NOW SIZED FOR SEVERAL TRANSACTIONS, NOT ONE. A turn longer
		 * than `actionsPerReveal` is revealed in `ceil(actions / actionsPerReveal)`
		 * transactions, in order, all of which have to land inside this window;
		 * anything still owed when it shuts is a partially applied turn, and what
		 * the silence costs on this branch is the whole avatar.
		 *
		 * `main` can say how many sends that is - its largest possible turn is ten
		 * placements, the sale's `amount` over `placementCost`, so three - and this
		 * branch CANNOT, because `placementCost` is zero and that division has no
		 * answer. A turn here is unbounded, so the number of reveals it takes is
		 * unbounded, and a long enough one cannot fit in any reveal window however
		 * generous. THAT IS A CLIENT'S PROBLEM RATHER THAN A CLOCK'S: whatever
		 * builds a turn here should refuse to plan one it cannot open in the time
		 * available, and until something does, a player who plans a very long turn
		 * can lose their avatar to the phase ending. Recorded here rather than
		 * silently inheriting a sentence that divides by zero.
		 */
		Game: {
			localhost: {
				commitPhaseDuration: 30n,
				revealPhaseDuration: 10n,
				actionsPerReveal: 4n,
				cyclePolicy: CYCLE_POLICY.Timed,
			},
			default: {
				commitPhaseDuration: 30n,
				revealPhaseDuration: 10n,
				actionsPerReveal: 4n,
				cyclePolicy: CYCLE_POLICY.Timed,
			},
		},
	},
	signerProtocols: {
		privateKey,
	},
} as const satisfies UserConfig;

// then we import each extensions we are interested in using in our deploy script or elsewhere

// this one provide a deploy function
import * as deployExtension from '@rocketh/deploy';
// this one provide read,execute functions
import * as readExecuteExtension from '@rocketh/read-execute';
// this one provide a deployViaProxy function that let you declaratively
//  deploy proxy based contracts
import * as deployProxyExtension from '@rocketh/proxy';
// this one provide a deployViaRouter function, used by the Game which is
//  split across several route contracts (see src/game/routes)
import * as deployRouterExtension from '@rocketh/router';
// this one provide a viem handle to clients and contracts
import * as viemExtension from '@rocketh/viem';

// and export them as a unified object
const extensions = {
	...deployExtension,
	...readExecuteExtension,
	...deployProxyExtension,
	...deployRouterExtension,
	...viemExtension,
};
export {extensions};

// then we also export the types that our config exhibit so other can use it

type Extensions = typeof extensions;
type Accounts = typeof config.accounts;
type Data = typeof config.data;
type Environment = EnhancedEnvironment<
	Accounts,
	Data,
	UnknownDeployments,
	Extensions
>;

export type {Extensions, Accounts, Data, Environment};
