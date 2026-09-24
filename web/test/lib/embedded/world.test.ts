import {describe, it, expect, afterEach} from 'vitest';
import {createContext} from '$lib/context/index';
import {createEmbeddedWorld, type EmbeddedWorld} from '$lib/embedded';
import buildTimeDeployments from '$lib/deployments';
import {config, extensions} from 'reveal-or-die-contracts/rocketh/config.js';
import {
	OFFLINE_DEPLOYMENT,
	offlineIdentityOf,
	stakeForEveryoneInTheWorld,
	stakeForOfflinePlayer,
} from '$lib/offline';
import {SEATS_BY_DEFAULT, tableOf} from '$lib/game/lobby/seats';
import {resolveWorldConfig} from '$lib/world/config';

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
		// false: the deploy is deterministic, so an embedded world lands its
		// contracts at exactly the addresses a fresh local deploy does. What makes
		// these records THIS world's is that the code is there, on this chain.
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
