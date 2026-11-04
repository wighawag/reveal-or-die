import {deployScript, artifacts} from '../rocketh/deploy.js';

/**
 * The token a player IS, on this branch.
 *
 * Deployed BEFORE the game, because the game holds avatars in custody and
 * needs the address; and its minter is wired AFTER the sale exists, in
 * `020_deploy_stake_sale.ts`. Until that call lands nobody can mint, which is
 * the deliberate default: a deployment that forgets the sale mints nothing at
 * all rather than minting for free.
 */
export default deployScript(
	async ({deploy, namedAccounts}) => {
		const {deployer, admin} = namedAccounts;

		// Deterministic (CREATE2), like every contract here: see "Deterministic
		// deployments" in README.md. The minter admin is passed, never taken
		// from msg.sender, which under CREATE2 is the factory.
		await deploy(
			'GameAvatars',
			{
				account: deployer,
				artifact: artifacts.GameAvatars,
				args: [admin],
			},
			{deterministic: true},
		);
	},
	{tags: ['GameAvatars', 'GameAvatars_deploy']},
);
