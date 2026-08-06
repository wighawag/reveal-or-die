import {deployScript, artifacts} from '../rocketh/deploy.js';

export default deployScript(
	async ({get, deploy, namedAccounts}) => {
		const {deployer, admin} = namedAccounts;

		await deploy('Avatars', {
			account: deployer,
			artifact: artifacts.Avatars,
			args: [],
		});
	},
	{tags: ['Avatars', 'Avatars_deploy']},
);
