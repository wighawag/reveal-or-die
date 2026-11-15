import {describe, it, expect, afterEach} from 'vitest';
import {createContext} from '$lib/context/index';
import {createEmbeddedWorld, type EmbeddedWorld} from '$lib/embedded';
import buildTimeDeployments from '$lib/deployments';
import {config, extensions} from 'reveal-or-die-contracts/rocketh/config.js';
import {
	OFFLINE_DEPLOYMENT,
	TABLE_STORAGE_KEY,
	offlineIdentityOf,
	playedByTheWorld,
	stakeForEveryoneAtTheTable,
	stakeForEveryoneInTheWorld,
	stakeForOfflinePlayer,
} from '$lib/offline';
import {
	SEATS_BY_DEFAULT,
	seatsPlayedByTheWorld,
	tableOf,
	type Table,
} from '$lib/game/lobby/seats';
import {resolveWorldConfig} from '$lib/world/config';
import {createPublicClient, createWalletClient, custom} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {lobby as gameLobby} from '$lib/context/index';
import {TABLE_SEATS} from '$lib/game/lobby/lobby';
import {
	seatTheOfflineTable,
	type OfflineTableCreator,
} from '$lib/game/lobby/offline-table';
import {readRoster} from '$lib/game/lobby/table';
import {encodeTableMode, AVATAR_MODE, ETH_MODE} from '$lib/world/table';

// No `.svelte.` infix, so this runs in the `server` project: node, no DOM.
// That is not a compromise, it is the harness this deserves - webevm's core
// runs under node, so a WHOLE WORLD (a chain, a real deploy, a context built on
// both) is testable without a browser.
//
// WHAT IT IS FOR, given that `test/lib/offline-players.test.ts` beside it also
// boots a world: this one is about the DATA and the WIRING rather than the
// play. The mechanism is covered by the suites under `test/lib/embedded`; what
// was untested is that the declaration this game makes - a manual cycle policy
// with both phase durations zero - produces a deployment this game can read,
// and that a context handed a world describes THAT world rather than quietly
// falling back to the app's build-time chain. With one world those two are
// indistinguishable. Here the chain id, the addresses and the records all
// differ.

const CHAIN_ID = 9007199254740123;
const DEPLOYER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const PLAYER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;

let world: EmbeddedWorld | undefined;
afterEach(async () => {
	await world?.dispose();
	world = undefined;
});

type Provision = Parameters<typeof createEmbeddedWorld>[0]['provision'];

async function buildWorld(overrides?: {provision?: Provision}) {
	return createEmbeddedWorld({
		chainId: CHAIN_ID,
		chain: {
			name: 'Offline',
			nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
			properties: {...config.chains[31337].properties},
		},
		rocketh: {config, extensions},
		environment: OFFLINE_DEPLOYMENT.environment,
		scripts: [...OFFLINE_DEPLOYMENT.scripts],
		data: {...OFFLINE_DEPLOYMENT.data},
		accounts: {...OFFLINE_DEPLOYMENT.accounts},
		expectedContracts: [...OFFLINE_DEPLOYMENT.expectedContracts],
		initialBalances: {...OFFLINE_DEPLOYMENT.initialBalances},
		...(overrides?.provision ? {provision: overrides.provision} : {}),
	});
}

function readerFor(w: EmbeddedWorld) {
	const deployments = w.deployments.get();
	return (args: unknown) =>
		(
			w.env as unknown as {
				read: (deployment: unknown, args: unknown) => Promise<unknown>;
			}
		).read(deployments.contracts.Game, args);
}

describe('this game’s offline world', () => {
	it('boots a chain and runs the game’s real deploy scripts on it', async () => {
		world = await buildWorld();

		// The records come from the deploy that just ran, and the chain they
		// describe is this world's: a MINTED id, which no exporter can emit
		// because the minted range sits above every registered chain.
		const inTab = world.deployments.get();
		expect(inTab.chain.id).toBe(CHAIN_ID);
		expect(inTab.chain.id).not.toBe(buildTimeDeployments.chain.id);

		// NOT "at a different ADDRESS from the build-time one", which would be
		// false: the deploy is deterministic (every contract through the CREATE2
		// factory, see "Deterministic deployments" in README.md), so an embedded
		// world lands its contracts at exactly the addresses a fresh local
		// deploy does. What makes these records THIS world's is that the code
		// is there, on this chain.
		for (const name of ['Game', 'Avatars', 'AvatarsSale'] as const) {
			const code = await world.provider.request({
				method: 'eth_getCode',
				params: [inTab.contracts[name].address, 'latest'],
			});
			expect(code, name).toMatch(/^0x[0-9a-f]{2,}$/);
		}
	});

	it('declares the MANUAL cycle policy, with no clock and nothing else changed', async () => {
		// The one decision an offline deployment of this game makes, and the one
		// thing a test of the mechanism could never have caught.
		// `resolveWorldConfig` is the client's own reader, so this asserts what
		// the GAME will believe rather than what the deploy wrote.
		world = await buildWorld();
		const offline = resolveWorldConfig(world.deployments.get());

		expect(offline.cycle.policy).toBe('manual');
		// Zero durations and the manual policy are ONE fact: the contract refuses
		// a configuration where they disagree, so a deployment that declared
		// `manual` with a clock would not be here to read. AND IT USED TO BE TWO
		// FACTS AND A BUG - the same two zeroes also meant "skip the commit
		// phase", so this exact configuration produced a game that could not
		// commit. See `UsingGameTypes.CyclePolicy`.
		expect(offline.cycle.commitPhaseDuration).toBe(0);
		expect(offline.cycle.revealPhaseDuration).toBe(0);

		// Everything that is a property of the GAME rather than of where the
		// chain runs is untouched, because `OFFLINE_DEPLOYMENT` spreads the
		// deploy's own defaults rather than restating them. A world that restated
		// these would be a second copy of a decision.
		const onNode = resolveWorldConfig(buildTimeDeployments as never);
		expect(offline.numMoves).toBe(onNode.numMoves);
		expect(offline.numMissesAllowed).toBe(onNode.numMissesAllowed);
		expect(offline.sale.price).toBe(onNode.sale.price);
	});

	it('gives the context the world it was handed, member for member', async () => {
		world = await buildWorld();
		const {context} = createContext({
			establishConnection: world.establishConnection,
		});

		// Identity, not equivalence. A core that built its own connection would
		// produce a context that behaves identically against one world and points
		// at the wrong chain the moment there are two.
		expect(context.deployments).toBe(world.deployments);
		expect(context.deployments.get().chain.id).toBe(CHAIN_ID);
		expect(context.publicClient.chain?.id).toBe(CHAIN_ID);
	});

	it('puts an avatar in the game, which is what makes anybody have to reveal', async () => {
		// THE PROVISIONING SEAM, with this game's answer in it. What is at stake
		// here is custody of the avatar itself: the sale mints it straight into
		// the game contract, the account is recorded as who may play it, and
		// going quiet for `numMissesAllowed` cycles is what takes it away.
		// Upstream this same test asserts a bonded ERC20 and a reserve, which is
		// the whole reason the hook exists rather than a list in the framework.
		let stakedDuringProvision = false;
		world = await buildWorld({
			provision: async ({env, accounts}) => {
				expect(accounts.deployer).toBe(OFFLINE_DEPLOYMENT.accounts.deployer);
				await stakeForOfflinePlayer({env, player: PLAYER});
				stakedDuringProvision = true;
			},
		});
		expect(stakedDuringProvision).toBe(true);

		const read = readerFor(world);
		const avatar = (await read({
			functionName: 'getAvatar',
			args: [offlineIdentityOf(PLAYER)],
		})) as {owner: `0x${string}`; life: number};

		// IN THE GAME'S CUSTODY AND PLAYABLE BY THE PLAYER, which is the pair
		// that makes it a stake: the ERC721 belongs to the contract, so nobody can
		// sell it out from under a commitment, and the game records who may act
		// with it.
		expect(avatar.owner.toLowerCase()).toBe(PLAYER.toLowerCase());
		expect(avatar.life).toBeGreaterThan(0);

		// And the payer plays nothing: `purchase` takes the owner in its payload
		// rather than using msg.sender, which is what lets a world set up an
		// account that has never sent anything.
		const payers = (await read({
			functionName: 'getAvatar',
			args: [offlineIdentityOf(DEPLOYER_ADDRESS)],
		})) as {owner: `0x${string}`};
		expect(BigInt(payers.owner)).toBe(0n);
	});

	it('provisions on a RESTORE without handing out a second avatar', async () => {
		// Provisioning runs on every boot and a boot is not always a first boot:
		// the chain and the deployment records persist, so a reload restores the
		// world, skips the deploy, and runs the hook again. A stake that can be
		// replaced by pressing F5 is not a stake - and here a second purchase
		// would revert on the already-minted id, so without the guard a restored
		// world would fail to boot at all.
		world = await buildWorld({
			provision: async ({env}) => {
				await stakeForOfflinePlayer({env, player: PLAYER});
				await stakeForOfflinePlayer({env, player: PLAYER});
			},
		});

		const avatar = (await readerFor(world)({
			functionName: 'getAvatar',
			args: [offlineIdentityOf(PLAYER)],
		})) as {owner: `0x${string}`};
		expect(avatar.owner.toLowerCase()).toBe(PLAYER.toLowerCase());
	});

	it('stakes for EVERY SEAT at the table, not just the human', async () => {
		// The assertion that stops a green suite sitting over a world with one
		// waited-for member, which is a cycle that hides nothing. It walks the
		// TABLE rather than a key list, so the day a seat holds a second human it
		// is staked for by the same line.
		const table = tableOf(SEATS_BY_DEFAULT);
		world = await buildWorld({
			provision: async ({env}) => {
				await stakeForEveryoneInTheWorld({env, player: PLAYER, table});
			},
		});

		const read = readerFor(world);
		const addresses = [
			PLAYER,
			...table.flatMap((seat) =>
				seat.occupant.kind === 'the-world' ? [seat.occupant.address] : [],
			),
		];
		expect(addresses).toHaveLength(SEATS_BY_DEFAULT);

		for (const address of addresses) {
			const avatar = (await read({
				functionName: 'getAvatar',
				args: [offlineIdentityOf(address)],
			})) as {owner: `0x${string}`};
			expect(avatar.owner.toLowerCase(), address).toBe(address.toLowerCase());
		}
	});
});

/**
 * A TABLE IN THIS GAME'S OFFLINE WORLD (stratagems' plan, step OT3, OT3-3 to
 * OT3-5, OT3-12): the boot's chain half, as `$lib/offline` runs it, in node.
 * The table is created by the person's account (here a key, there the world's
 * wallet), every seat taken AT it by the mode's rail, started, and its address
 * recorded; a reload repeats nothing; a record the chain does not hold is
 * refused. What needs a page (the wallet, the context on the table's record,
 * the close by the tab) is the e2e's, `tables-offline.e2e.ts`.
 */
describe('a table in this game\u2019s offline world', () => {
	const CREATOR = {
		privateKey:
			'0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
		address: PLAYER,
	} as const;
	const seats: Table = tableOf(3, 1, [], TABLE_SEATS);
	const PLAY_MONEY = `0x${(10n ** 24n).toString(16)}`;

	async function tableWorld() {
		world = await buildWorld({
			provision: async ({node}) => {
				// gas and play money, as provisioning gives them
				for (const address of [
					CREATOR.address,
					...seatsPlayedByTheWorld(seats).map((seat) => seat.address),
				]) {
					await node.provider.request({
						method: 'evm_setBalance',
						params: [address, PLAY_MONEY],
					} as never);
				}
			},
		});
		const records = world.deployments.get();
		const chain = {
			id: records.chain.id,
			name: records.chain.name,
			nativeCurrency: records.chain.nativeCurrency,
			rpcUrls: {default: {http: [] as string[]}},
		};
		const reader = createPublicClient({
			chain,
			transport: custom(world.provider as never),
		});
		const account = privateKeyToAccount(CREATOR.privateKey);
		const client = createWalletClient({
			account,
			chain,
			transport: custom(world.provider as never),
		});
		const calls: string[] = [];
		const creator: OfflineTableCreator = {
			address: CREATOR.address,
			writeContract: (request) => {
				calls.push(request.functionName);
				return client.writeContract({
					...request,
					account,
					chain: null,
				} as never);
			},
		};
		const store = new Map<string, string>();
		const storage = {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
		};
		const nonces = async () =>
			Promise.all(
				[
					OFFLINE_DEPLOYMENT.accounts.deployer,
					...seatsPlayedByTheWorld(seats).map((seat) => seat.privateKey),
				].map((key) =>
					reader.getTransactionCount({
						address: privateKeyToAccount(key).address,
					}),
				),
			);
		return {records, chain, reader, creator, calls, storage, store, nonces};
	}

	async function boot(
		at: Awaited<ReturnType<typeof tableWorld>>,
		mode: number,
	) {
		return seatTheOfflineTable({
			reader: at.reader as never,
			creator: at.creator,
			factory: gameLobby!.factory(at.records).address,
			implementation: gameLobby!.implementation(at.records).address,
			storage: at.storage,
			storageKey: TABLE_STORAGE_KEY,
			seats: seats.length,
			cycles: 2,
			gameOptions: encodeTableMode(mode),
			stake: (table) =>
				stakeForEveryoneAtTheTable({
					env: world!.env,
					provider: world!.provider,
					chain: at.chain,
					table: table.address,
					you: at.creator,
					seats,
				}),
		});
	}

	const read = (deployment: unknown, args: unknown) =>
		(
			world!.env as unknown as {
				read: (deployment: unknown, args: unknown) => Promise<unknown>;
			}
		).read(deployment, args);

	for (const [mode, label] of [
		[AVATAR_MODE, 'avatar'],
		[ETH_MODE, 'eth'],
	] as const) {
		it(`in ${label} mode: creates the table from the person, takes every seat AT it by the mode's rail, starts it, records it, and a reload repeats nothing`, async () => {
			const at = await tableWorld();
			const opened = await boot(at, mode);
			expect(opened.kind).toBe('table');
			if (opened.kind !== 'table') return;
			expect(opened.created).toBe(true);
			expect(at.store.get(TABLE_STORAGE_KEY)).toBe(opened.table.address);
			expect(at.calls).toEqual(
				mode === ETH_MODE
					? ['createGame', 'join', 'start']
					: ['createGame', 'start'],
			);

			const roster = await readRoster(at.reader as never, opened.table.address);
			expect(roster.creator.toLowerCase()).toBe(CREATOR.address.toLowerCase());
			expect(roster.started).toBe(true);
			expect(roster.cycles).toBe(2);
			expect(roster.members).toHaveLength(3);

			const Table = {
				address: opened.table.address,
				abi: at.records.contracts.GameTableImplementation.abi,
			};
			const state = (await read(Table, {functionName: 'getTable'})) as {
				mode: number;
				seated: bigint;
			};
			expect(Number(state.mode)).toBe(mode);
			expect(state.seated).toBe(3n);
			// every seat is its own at the table, by the mode's identity (OT3-5)
			const addresses = [
				CREATOR.address,
				...seatsPlayedByTheWorld(seats).map((seat) => seat.address),
			];
			const tableMode = label;
			for (const address of addresses) {
				const avatar = (await read(Table, {
					functionName: 'getAvatar',
					args: [offlineIdentityOf(address, tableMode)],
				})) as {owner: `0x${string}`};
				expect(avatar.owner.toLowerCase(), address).toBe(address.toLowerCase());
			}
			expect(
				playedByTheWorld(seats, tableMode).map((seat) => seat.identity),
			).toEqual(
				seatsPlayedByTheWorld(seats).map((seat) =>
					offlineIdentityOf(seat.address, tableMode),
				),
			);
			// NOBODY IN THE WORLD'S `Game`
			const inTheWorld = (await read(at.records.contracts.Game, {
				functionName: 'getAttendance',
			})) as {waitedFor: bigint};
			expect(inTheWorld.waitedFor).toBe(0n);

			// A RELOAD: no second create, purchase, join or start
			const calls = at.calls.length;
			const nonces = await at.nonces();
			const again = await boot(at, mode);
			expect(again).toMatchObject({
				kind: 'table',
				created: false,
				table: {address: opened.table.address},
			});
			expect(at.calls.length).toBe(calls);
			expect(await at.nonces()).toEqual(nonces);
		}, 60_000);
	}

	it('refuses a stored table the chain does not hold, with nothing sent', async () => {
		const at = await tableWorld();
		at.store.set(
			TABLE_STORAGE_KEY,
			'0x00000000000000000000000000000000000000aa',
		);
		const opened = await boot(at, AVATAR_MODE);
		expect(opened.kind).toBe('incoherent');
		expect(at.calls).toEqual([]);
	});

	it('plays an avatar in the world and at an avatar table, and the account at an ETH table', () => {
		expect(offlineIdentityOf(PLAYER)).toBe(offlineIdentityOf(PLAYER, 'avatar'));
		expect(offlineIdentityOf(PLAYER, 'eth')).toBe(BigInt(PLAYER));
		expect(offlineIdentityOf(PLAYER, 'avatar')).not.toBe(BigInt(PLAYER));
	});
});
