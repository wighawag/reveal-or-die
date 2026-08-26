import {deployScript, artifacts} from '../rocketh/deploy.js';

export default deployScript(
	async ({deploy, namedAccounts}) => {
		const {deployer} = namedAccounts;

		await deploy('GameToken', {
			account: deployer,
			artifact: artifacts.GameToken,
			args: [],
		});
	},
	{tags: ['GameToken', 'GameToken_deploy']},
);
