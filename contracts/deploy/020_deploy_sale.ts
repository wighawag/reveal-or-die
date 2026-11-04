import {deployScript, artifacts} from '../rocketh/deploy.js';
import {Abi_Avatars} from '../generated/abis/Avatars.js';

export default deployScript(
	async ({get, deployViaProxy, execute, namedAccounts, data}) => {
		const {deployer, admin} = namedAccounts;
		const config = {
			paymentAmount: data.sale.price,
			recipient: admin,
			freeMapAdmin: admin,
		};
		const Avatars = get<Abi_Avatars>('Avatars');
		const AvatarsSale = await deployViaProxy(
			'AvatarsSale',
			{
				account: deployer,
				artifact: artifacts.AvatarsSale,
				args: [Avatars.address, config],
			},
			{
				owner: admin,
				linkedData: config,
				// The proxy and its implementation. Deterministic (CREATE2), like
				// every contract here: see "Deterministic deployments" in
				// README.md. Neither constructor reads msg.sender, which under
				// CREATE2 is the factory.
				deterministic: true,
			},
		);

		// THE MINT IS CLOSED UNTIL THIS RUNS. `Avatars.minter` is zero on a fresh
		// deployment and zero means nobody can mint, so this is what makes the
		// game playable at all - and it is the line that makes an avatar cost
		// something, because the sale is then the only route to one.
		//
		// Pointed at the PROXY, not the implementation, so upgrading the sale
		// does not need re-wiring. Idempotent because deploy scripts re-run: the
		// GUARD reads `minter` first and skips the write when it is already the
		// sale, and it is also what lets a LAN box replay this call only when its
		// effect is missing (`rocketh/guard-recording.ts`).
		await execute(Avatars, {
			account: admin,
			functionName: 'setMinter',
			args: [AvatarsSale.address],
			guard: {
				kind: 'call',
				functionName: 'minter',
				equals: AvatarsSale.address,
			},
		});
	},
	{tags: ['AvatarsSale', 'AvatarsSale_deploy']},
);
