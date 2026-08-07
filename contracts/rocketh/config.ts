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

// we define our config and export it as "config"
export const config = {
	chains: {
		31337: {
			properties: {
				expectedWorstGasPrice: parseEther('1', 'gwei'), // TODO use same value from hardhat config
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
	// Chain properties are exported with the deployments and read by the web app
	// (see web/src/lib/context/config.ts). Uncomment to denominate the local
	// signer's gas balance as CREDITS - "12 credits" instead of "0.0012 ETH" -
	// so a player reads how many moves they can still make rather than a wei
	// figure. See web/src/lib/core/connection/credits.ts.
	//
	// BOTH are required, and neither is defaulted: half a configuration would
	// produce a confident, wrong move count, so the app falls back to showing
	// native currency unless it knows what an action actually costs.
	//
	// chains: {
	// 	31337: {
	// 		properties: {
	// 			// The worst gas price this chain is expected to charge, in wei.
	// 			// A string, because a mainnet-scale value does not survive JSON as
	// 			// a number. Pessimistic on purpose: it makes the credit count a
	// 			// floor the player always gets, rather than one that drifts down
	// 			// with the mempool while they sit still.
	// 			expectedWorstGasPrice: '1000000000',
	// 			// Gas one credit buys, i.e. what a single user action costs. Sum
	// 			// the worst-case gas of the transactions one move sends.
	// 			creditsGasMultiplier: 100000,
	// 			// Credits per top-up. Optional; defaults to 100.
	// 			creditsPerTopUp: 100,
	// 		},
	// 	},
	// },
	data: {
		sale: {
			default: {
				price: parseEther('0.00000001'),
			},
		},
		/**
		 * Phase durations.
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
		 */
		Game: {
			localhost: {
				commitPhaseDuration: 30n,
				revealPhaseDuration: 10n,
				numMoves: 10n,
			},
			default: {
				commitPhaseDuration: 30n,
				revealPhaseDuration: 10n,
				numMoves: 10n,
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
