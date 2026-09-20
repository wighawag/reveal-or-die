# `$lib/embedded`: a chain that runs in this tab

Inherited from jolly-roger's `with/embedded-chain`, through the `integration` node this repo's `stemBranch` points at. It boots an execution-only EVM (`webevm`) in the browser, runs an app's own rocketh deploy scripts onto it through `@rocketh/web`, announces a wallet for it, and hands back a world: a `ConnectionFactory` plus the deployment records that describe THAT chain.

**It is the MECHANISM and it is complete. What is missing here is this game's composition of it**, and that is the whole content of this file.

## What came down, and what was deleted on the way

The stem carries three things, and only the first is the framework's:

| what                    | where                  | kept here?                                                    |
| ----------------------- | ---------------------- | ------------------------------------------------------------- |
| the mechanism           | `lib/embedded/`        | **yes**, and it is what this directory is                     |
| that app's own world    | `lib/offline.ts`       | **no** - it deploys a greetings registry                      |
| the route that shows it | `routes/offline-demo/` | **no** - this repo deletes inherited demo routes (`d34ad44b`) |

Deleting the second two is the rule the stem's own README states: the mechanism lives in `lib/` and a route is only its demo, precisely because a descendant throws the demo away. They arrived as clean ADDS with nothing to conflict against, which is the shape this tree keeps paying for, and so did two things that came with them: a `jolly-roger-contracts` workspace dependency in `web/package.json` naming a package that does not exist in this workspace, and a "Play Offline" button on the home page linking to the route that is now gone.

## THE TEST THAT WAS DELETED, WHICH IS THE COST WORTH KNOWING ABOUT

`web/test/lib/embedded/world.test.ts` did not survive the move, and it was the best test on the branch: it booted a real chain, ran a real deploy on it, built a real `createContext({establishConnection})` on top and asserted the context's members were the world's BY IDENTITY. It is gone here because it deploys `001_deploy_greetings_registry` from the stem's contracts, and contracts are not inherited in this tree.

The other four files under `web/test/lib/embedded/` are the mechanism's own and they stayed: chain-id minting, the deploy config composition, the deployment records and their coherence check, and the wallet. Counted: the stem's five files hold 26 server tests and 2 client ones; here it is 22 and 2, and the missing 4 are exactly `world.test.ts`.

**One of the four that stayed had to be edited, and the reason is a small design point rather than a chore.** `deployments.test.ts` named `GreetingsRegistry`, and one line of it did not merely MENTION the name, it indexed `store.get().contracts` by it - which type-checks only in the app whose generated `$lib/deployments` has that key, because `createEmbeddedDeployments` casts its runtime record back to the build-time literal type. So a test of the MECHANISM was coupled to the app's contracts through an inferred type, and it says `Game` here.

That is a divergence in a shared file and it will conflict whenever the stem edits that file. The fix that would end it belongs upstream and is worth doing when somebody is there: the name is incidental to what the test asserts, so a fixture name the app cannot have (or one read off `expectedContractNames()`) makes the file identical in every repo again.

**So what this repo currently has is a mechanism with unit coverage and no whole-world test, and the honest reading is that `createContext`'s connection parameter has no proven second caller HERE.** Porting that test is cheap in shape and not in substance: swap the two imports to `template-commit-reveal-contracts`, list this repo's three deploy scripts, and name a contract of this game instead of `GreetingsRegistry` - but the deploy needs DATA, and the data is the decision below.

## What this game has to write, in the order the plan gives

1. **A client that calls `advanceCycle`.** `grep -rn advanceCycle web/src` finds the ABI and no caller. Under the manual cycle policy a round is commit, advance, reveal, advance, and a reveal sent before the advance is refused with `InCommitmentPhase`. **This is a gap in the FRAMEWORK and not in the world** - a manual deployment on an ordinary remote chain cannot complete a round either - which is why it is first and why it is not the embedded world's to fix.
2. **The in-tab deploy's data**: `cyclePolicy: Manual` with both phase durations zero, which is one decision and not three because the contract refuses a configuration whose durations disagree with its policy. Everything else (`actionsPerReveal`, `commitGas`, `revealGas`, `expectedActionsPerTurn`) is unchanged, because they are properties of the CONTRACTS and of the EVM, and webevm was measured to agree with hardhat to the unit on all six gas readings.
3. **A provisioning hook that bonds the ERC20 stake.** `createEmbeddedWorld({provision})` runs after the deploy and before the world exists, and is handed the rocketh environment and the node, so it can call contracts and use `evm_setBalance` for gas. It is a hook rather than a branch edit on purpose: written per branch it would land in four divergence tables forever.
4. **This game's `offline.ts` and its entry point**, and only then the "Play Offline" button the home page comments out. A link into a world this game cannot finish a cycle in is worse than no link.

## One thing that is NOT reconciled anywhere yet

A world takes the app's `targetStep` rather than choosing one, deliberately: a world chooses the CHAIN, never how the app authenticates. This repo's `TARGET_STEP` is `SignedIn`, so an embedded world here runs with a LOCAL SIGNER derived over the world's own burner wallet - a combination that exists on no branch upstream, since `with/embedded-chain` alone targets `WalletConnected`. Nothing has pointed a browser at it. Expect that to be the first surprise.

## And one that is known to be wrong and is not yours

`onchain/state.ts` sizes its block range as `floor(4 * cycleDuration / averageBlockTime)`, and under the manual policy `cycleDuration` is zero, so the span is zero and `fromBlock === toBlock` on every poll. This game reads the board out of contract storage and ignores `fromBlock`, so it cannot see it; a game that builds state from LOGS can, and conquest is that game. Do not fix it here. If it DOES bite this game, the finding that says it cannot is wrong and changes in the same commit as whatever proved it.
