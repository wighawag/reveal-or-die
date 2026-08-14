# Handoff: making template-commit-reveal the shared commit-reveal template

Working document for whoever picks this up. **Delete it when the work is done** - it is scaffolding, not documentation, and a stale handoff is worse than none.

Before deleting, move anything still true and still useful to where it belongs, because some of this outlives the task:

- the two commit-reveal rules are already in `AGENTS.md`; keep them there
- the seam decisions and the survey below belong in a short `docs/` note or in the header comments of `web/src/lib/game/core/seams.ts`, which is where someone writing a game will actually look
- the bug list for the other repos should become issues on those repos, not vanish

## The goal

Five games exist that are all commit-reveal, all written independently, and all carrying their own copy of the same machinery. The aim is one template they can all descend from, with the parts they disagree about expressed as seams rather than forked code.

```
jolly-roger (main)                    generic app template
  └── variant/full                    + backend-requiring bits (hosted sign-in)
        └── template-commit-reveal    + the commit-reveal framework  <- THIS REPO
              ├── reveal-or-die       avatar in a maze
              │     └── bomber-world  reveal-or-die + bombs
              ├── conquest-v1         empires and star systems
              ├── catacombs           dungeon crawler, deferred - see below
              └── stratagems          board placement, deferred - see below
```

Every game descends from `template-commit-reveal`, including stratagems and catacombs. An earlier version of this document drew stratagems hanging off `variant/full` instead; that was wrong. They are deferred on GROUNDS OF EFFORT (a different generation of the stack, see the section at the end), not because they sit somewhere else in the tree. The seams have to fit them.

Each descendant is its own repo, tracks its parent as `upstream`, and merges
down. Contracts are NOT inherited: every game writes its own. The template's
contracts are a reference to start from.

## Where things stand

| repo                     | state                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `jolly-roger`            | done, ours merged. **1 unpushed commit that is not ours** (`c93ded2 route: accept relative paths`)                            |
| `template-commit-reveal` | **6 unpushed commits + uncommitted work, in progress.** Contracts green; upstream merged down; the web game works end to end   |
| `conquest-v1`            | done and pushed, descends from jolly-roger directly. **1 unpushed commit that is not ours** (`deb8127`, same change as above) |
| `reveal-or-die`          | untouched. Still on a jolly-roger from ~497 commits back                                                                      |
| `bomber-world`           | untouched. reveal-or-die + ~6 commits (bombs)                                                                                 |
| `catacombs`              | untouched, deferred. Svelte 5 already; indexer + fuzd + WebGL. Contracts and web BOTH unfinished - see below                   |
| `stratagems`             | untouched, deliberately deferred                                                                                              |

The two unpushed `route:` commits appeared during this work and were not made by
the previous session. Leave them alone; ask before touching.

### template-commit-reveal, specifically

`main` was reset onto `upstream/variant/full` and has three commits. The
previous history is preserved on the `old` branch. **Nothing is pushed**, and
the eventual push is a force-push (agreed), keeping `old` as an archive.

**Git tracking is deliberately hybrid, do not "fix" it blindly.**

```
branch.main.remote     = upstream          (jolly-roger)
branch.main.merge      = refs/heads/variant/full
branch.main.pushRemote = origin            (template-commit-reveal)
```

So `git push` goes to this repo's own origin, while `git status` compares
against jolly-roger's `variant/full`. That makes `git status` say "your branch
and 'upstream/variant/full' have diverged, ahead N and behind M", which reads
like a problem and is not: **ahead** is our work, **behind** is upstream work
not yet merged down. Merge it with `git merge upstream/variant/full`.

**Fetch before concluding a commit is missing.** The last merge began with "the
upstream commits are unpushed, this is blocked": they were pushed, and only this
repo's cached remote refs were stale. `git ls-remote upstream` answers it without
changing anything.

**Upstream's e2e tests come down too, and they drive the DEMO.** `delegation.e2e.ts` and `demo.e2e.ts` both need the greetings page this repo removed, so they go with it. Worth deleting promptly rather than leaving to fail: they connect a wallet each, and seven simultaneous wallet connects tipped the documented connect flake from intermittent into every-run. Five is fine; the suite passed twice at five and failed 7-of-7 at seven. If that flake is ever fixed properly, it is a fixture-level fix upstream.

**The conflict is wherever this repo DELETED something upstream still edits.**
The recurring one is the demo route: `web/src/routes/demo/` went with the demo
in `d34ad44`, and upstream keeps developing it, so every merge that touches it
arrives as `CONFLICT (modify/delete)`. Keep the deletion, and delete any test
upstream added alongside it (`web/test/routes/demo/`), or the suite imports a
route that is not there. Earlier merges conflicted in `context/index.ts`
instead, for the opposite reason (upstream editing a monolithic `createContext`
this repo has split); expect either shape.

Once the force-push to `origin/main` has happened, switching to
`git branch -u origin/main main` is the tidier end state (that is how
`conquest-v1` is set up), with upstream merged in explicitly.

```
d34ad44  contracts on jolly-roger's variant/full
29df48f  the seams, and the framework the four games agree on
095cee4  address-based, staked, shared-cell template game
b9309b7  docs: hand off the template work to a fresh context
7c21d1b  docs: record the hybrid git tracking
(merge)  upstream/variant/full merged down
```

All green. 16 commits are committed and unpushed; on top of them sits an UNCOMMITTED merge of `upstream/variant/full` (12e8df3) plus the classifier retirement, left uncommitted deliberately. These are the numbers to reconcile against after a merge, rather than accepting whatever comes out: a suite that silently stops being collected looks exactly like a clean run.

- `pnpm contracts:test` -> 87 passing (61 solidity, 26 nodejs)
- `pnpm web:check` -> 0 errors
- `pnpm --filter ./web test:unit --run` -> 685 passing in 62 files
- `pnpm test:e2e` -> 19 passing. Pass the ports explicitly, e.g. `cd web && E2E_RPC_PORT=8631 E2E_PORT=4631 pnpm test:e2e`. Bare `pnpm test` chains into e2e against port 8545, which is usually the user's own dev chain.

The e2e run happens in a throwaway git worktree, and it carries the WORKING TREE across (uncommitted diff plus untracked files), so it tests what you are looking at rather than the last commit. For a fast loop on one test, `test.only` restricts the whole run to it (`forbidOnly` is CI-only), taking a full run from ~4.5 minutes to ~1.5.

## Environment gotchas

- **`pnpm` is not on PATH.** Use `~/.volta/bin/pnpm`. Bare `pnpm` fails; `corepack pnpm` also works.
- **Check ports before e2e.** A dev chain of the user's often runs on 8545. Run
  e2e with `E2E_RPC_PORT=8555` so it starts its own node instead of reusing and
  polluting theirs. `scripts/run-e2e-tests.sh` silently reuses whatever is on
  8545 otherwise. Check with `fuser 8555/tcp` first; 8080 has been in use by an
  unrelated process.
- **The e2e connect step is intermittently flaky under parallel load.** Seen three times in about six runs since sign-in became part of the flow, always as `expectWalletConnected` timing out after 30s while the connect dialogs are still in flight. It passes on a re-run. Signing in adds a dialog and a signature to what that 30s has to cover, and four workers all doing it at once is the condition. Worth timing rather than guessing at: if it is simply too tight, the fix is upstream in the fixture, not a retry here.
- **Check for ORPHANED hardhat nodes, not just a busy port.** Several runs can leave nodes behind; they queue on the same port, and when the one holding it dies another takes over with completely different state. The symptom is baffling: a contract you just deployed has no code, or addresses change between deploys. `fuser 8555/tcp` only shows the one that won. Use `ps -eo pid,etimes,cmd | grep contracts/node_modules` and check the ages.
- **`pnpm web:dev` exercises SSR; `pnpm build` does not exercise it the same way.** A dependency without an `exports` field resolves to its CJS build under the dev SSR runner and fails there while the production build succeeds. Test both surfaces; the game route was 500ing in dev while every build and e2e run was green.
- **`vite preview` can serve a stale output dir** (every asset 404s, no CSS).
  For real browser checks serve the actual build:
  `pnpm exec ipfs-emulator --only -d build -p 8081`.

## Decisions already made (do not relitigate without reason)

1. **Contracts stay independent per game.** Not inherited. The template's are a
   reference. Conquest's are 11/17 diverged from the old template's already.
2. **Identity is a type parameter**, not a naming convention. Three real models:
   `address` (template, stratagems), `avatarID` bigint (reveal-or-die,
   bomber-world), `empireID` bigint (conquest). Stratagems keys commitments by
   `msg.sender` directly, which is why this is a seam and not a rename.
3. **The template is deliberately an address game, not an avatar game.** An
   avatar game gives you one entity to control and your identity is a thing in
   the world; an address game gives you no identity but your account and your
   action. Making the template the second kind means the first descendant port
   (reveal-or-die) has to exercise `PlayerIdentity` rather than inherit it.
4. **`OnchainStateStore` is a seam, with indexer support first-class.** Kept to
   value + status + `update()` because polling and event-replay share nothing
   else. Stratagems builds state with `ethereum-indexer-browser`; the template
   ships a camera-scoped poller as one implementation.
5. **The renderer is a seam**, parametrised by surface: pixi (reveal-or-die,
   conquest) and raw WebGL (stratagems) must both fit.
6. **Framework lives in `web/src/lib/game/core/` and `web/src/lib/game/render/`.**
   Never in `web/src/lib/core/`, which is jolly-roger's and must stay mergeable.
   The camera deliberately has no pixi import, because the state layer depends
   on it and that would force pixi on every game.
7. **Embedded play and TEVM are removed.** They will come back later using
   `embedded-eth-node`, not tevm.
8. **Stake, not implicit joining.** The template gates with a token reserve
   bonded at commit and forfeited on missed reveal. reveal-or-die gates with NFT
   custody instead. The framework only requires that _something_ is forfeited.

## Two rules that are easy to break

Both are in `AGENTS.md`. They are repeated here because the previous session got
the first one wrong twice in a single message.

- **A reveal must not branch on state another reveal in the same epoch could
  have changed.** "First reveal wins" and "reject an occupied cell" both look
  reasonable and both make the outcome depend on mempool ordering, which hands
  the game to whoever pays the most gas. Accumulate (`+=`). Stratagems does this
  correctly with `cellUpdate.delta += enemyOrFriend`.

  `contracts/test/Game.test.ts` asserts this by replaying the same commitments
  in both reveal orders. It has been verified to have teeth: reintroducing the
  reject-if-occupied rule fails that test while the other three still pass.

- **Something must be at stake or nobody has to reveal.** A player who dislikes
  what they committed to just goes quiet. This was `// TODO burn / stake ....`
  before, meaning the template shipped commit-reveal with no reason to reveal.

## What exists now

**Contracts** (`contracts/src/`), all address-keyed:

- `game/interfaces/` - `IGame` (commit/reveal/getters), types, events, errors
- `game/internal/UsingGameStore.sol` - reserve, commitments, cells
- `game/internal/UsingGameInternal.sol` - the round; `_place` is the
  order-independent accumulation, commented as such
- `game/routes/` - `GameCommit`, `GameReveal`, `GameGetters` behind a router+proxy
- `tokens/GameToken.sol` - freely mintable ERC20, template-only
- `utils/PositionUtils.sol` - zone maths (16x16 zones), pre-existing

Key surface: `addToReserve` / `withdrawFromReserve` / `makeCommitment(hash,
bond, payee)` / `reveal(player, placements, secret, payee)` /
`acknowledgeMissedReveal(player)` / `getCellsInZone(zone)`.

`reveal` takes `player` rather than using `msg.sender` so a third party can
reveal for someone who is offline. That is also the precondition for stratagems'
fuzd-scheduled reveal.

**Web framework** (`web/src/lib/game/`):

- `core/seams.ts` - all the seam types, no implementation. Read this first.
- `core/epoch.ts` - timed and manual epoch trackers. Framework, not a seam: all
  four games compute the epoch identically including the `+ 2` offset.
- `core/chain-time.ts` - chain-synced clock the timed epochs read. Ported from
  conquest where it is proven.
- `core/round.ts` - the commit-reveal round. Plans, commits, keeps the secret,
  drives the reveal. Unit-tested against fake seams, and those tests were
  checked for teeth by mutating the two behaviours that protect the stake.
- `render/camera.ts` - renderer-agnostic camera.
- `render/pixi/` - a pixi surface implementing the render seam.
- `web/src/lib/onchain/state.ts` - the seam re-exported plus
  `createPollingOnchainState`, the camera-scoped implementation.
- `web/src/lib/view/index.ts` - the view seam, `createViewState` taking a
  game-supplied `merge`.

## The web game (done)

A grid of shared cells at `/play`: click to plan placements, the round commits as the phase closes, and reveals in the reveal phase. It exists to prove the seams fit, and it does now compile against them and run against a real chain.

- `web/src/lib/placement/` is the GAME. A descendant deletes this whole directory and writes its own; the split is by directory precisely so "what do I replace" has an obvious answer. `cells.ts` (zone maths mirroring `PositionUtils`), `state.ts` (camera-scoped reader), `view.ts` (the merge), `planning.ts` (clicks to a plan), `commit-reveal.ts` (the adapter), `reserve.ts` (what is at stake), `storage.ts` (the secret across reloads), `render/`, `ui/`.
- `web/src/lib/game/core/round.ts` is NEW framework: the round itself. It owns what is planned, when that stops being changeable, keeping the secret, and getting the reveal out. It is what actually exercises `CommitRevealAdapter`.
- `web/src/lib/game/render/pixi/` is the pixi surface, ported from conquest with its three hard-won bug comments intact (click coordinate space, viewport resize, backdrop sizing). Shipped as ONE implementation of the render seam, the same way the poller is one implementation of the state seam.
- `createContext` is decomposed. `context/core.ts` is jolly-roger's half and takes the game as an injected `createGame`; `context/game.ts` is the framework wired to this game; `context/index.ts` is three lines of composition. The core builds the game part-way through its own construction, because the game needs the connection and the RPC-health/refresh wiring needs the game's reads. That ordering is commented at the injection point.

## Who signs what, and who OWNS

A core-template decision, and the one most likely to be got wrong by inheriting jolly-roger's defaults unchanged.

**The template got the second half wrong until recently, and the correction is the most important thing in this document.** It used to make the local signer the PLAYER: the reserve was the signer's reserve, and every cell it won was the signer's cell. Everything worked, and the position was indefensible. An identity that exists only in one browser's storage is one cleared site away from being gone, taking the staked reserve with it and leaving nothing to recover from; and a key with no owner is a key with full authority, so any copy of it held the money. The signer is a local account with ZERO ownership, and delegation is what makes it safe to use.

So: the ACCOUNT is the player, and the signer merely acts for it, authorised on chain. The account owns the reserve, the commitment and the cells; the signer spends gas and nothing else. Losing the browser costs a key, and the player authorises another one and carries on. `@etherplay/delegation` is what records that authority, and `GameDelegation` is the route that exposes it.

**The library is a DEPENDENCY, not a copy in this tree.** It used to live in `contracts/src/core`, merged down from jolly-roger; it now ships as `@etherplay/delegation`, with the Solidity, the TypeScript message builder and the ABI in one package, pinned against a shared vectors file. That is the right shape for a security-critical library whose signed message is consensus between three implementations: this repo having merged its own copy down was already two copies drifting, and the only test pinning the Solidity against the builder lived in a downstream template that neither upstream ran. `GameDelegation` inherits `UsingDelegation`, `GameCommit` calls the `Delegation` library directly (a router maps one selector to one route, so the entry points must live in exactly one of them), and `IGame` composes the package's `IDelegation` so the router's selector list cannot drift from the implementation.

A descendant that wants the readable, editable source back has lost something real, and that is the accepted price. Read the package, do not fork it: an adopter that needs narrower authority overrides `_requireAccountForSender` rather than editing the library.

A commit-reveal round is at least two transactions every epoch, forever. Sent from the wallet that is a MetaMask prompt per commit AND per reveal, which is unplayable, and worse than unplayable here: a reveal the player does not approve in time costs them their stake. An account authenticated by email or social sign-in has no wallet provider at all, so under wallet execution it cannot send anything and simply cannot play.

`variant/full` already derives a local signer at sign-in (`OriginAccount.signer`), so the fix is wiring, not invention:

- `core.ts` builds a SECOND executor pinned to the signer. `gameExecutor` sends moves; `executor` stays for anything that spends the player's money, with a prompt, deliberately.
- The choice is made per DEPLOYMENT (`gameIdentityAvailable`), not per moment. Picking whichever executor happens to be ready would quietly route a move through the wallet while a sign-in was still in flight, which is the exact prompt this removes.
- The signer holds no funds, so `addToReserve(address player, uint256 amount)` takes a beneficiary: the wallet pays, the ACCOUNT is credited. `contracts/test/js/Game.test.ts` pins this ("lets one address pay the stake and another play with it").
- `makeCommitment` and `cancelCommitment` take a `player` and resolve it with `Delegation.requireAccountFor(msg.sender, player)`, so an unauthorised sender reverts with `NotDelegate` instead of quietly bonding its own empty reserve. `reveal` deliberately does NOT check the caller: a reveal is validated by the commitment hash, and anyone being able to submit one is what stops an offline player forfeiting.
- **`withdrawFromReserve` is deliberately NOT delegable**, and is the only account-facing function that is not. The delegate may SPEND the reserve on playing, which is what it is for, and may never take it out. That single line is what makes a disposable browser key safe to hold, and there is a test named for it.
- The setup gate asks for the authorisation BEFORE the stake: both are wallet transactions, and a player who abandons setup half way should have spent as little as possible. The authorisation is one transaction that also funds the signer's gas, which is the same top-up flow the out-of-gas remedy uses.
- Game moves do NOT go through `balanceCheck.ensureCanAfford`. That is the app's user-facing spending check: it opens a modal for the whole call ("Preparing Transaction" while estimating, then insufficient-funds) and it checks the WALLET's balance. Over a game board, on every commit and reveal, against the wrong address.
- The signer needs gas of its own. `createSignerBalanceStore` already existed in `$lib/core` as an explicitly unwired building block for exactly this; it is now wired, and the HUD shows "Play key gas".

**Moves are not gated on `balanceCheck.ensureCanAfford`, deliberately, and this is a live tension with upstream.** That helper is the app's pre-flight check for user-initiated spending: it opens a modal for the whole call ("Preparing Transaction" while estimating, then insufficient funds), and it is `step !== 'idle'` that opens it, so the estimating phase alone is enough. A round is two transactions every epoch, so gating on it puts a modal over the board on every commit and every reveal, which is the interruption the signer exists to remove. Upstream recommends the opposite ("let ensureCanAfford's promise be the gate") and that is right for a purchase and wrong for a move. This repo therefore catches the shortfall AFTER the fact and offers the top-up flow as the remedy, resuming when the signer's balance rises. If upstream ever stops opening the modal for the estimating phase, revisit: the pre-flight version is otherwise better, because it catches the shortfall before a reveal is spent rather than after.

**Recognising the shortfall is now upstream's job, and the game only names whose it is.** `isInsufficientFundsFailure` (jolly-roger `$lib/core/transaction`) classifies; `SignerOutOfFundsError` in `web/src/lib/placement/errors.ts` is the game's own type and all that is left of the local stopgap. Classification happens ONCE, in `send()` in `placement/commit-reveal.ts`, the only place that sees a raw node error and the funnel every write goes through; the HUD and the auto-resume ask `instanceof SignerOutOfFundsError`, because by then they are asking about an error the app itself constructed. One import of upstream's classifier in the whole game.

The HUD keeps its own wording rather than the exported `INSUFFICIENT_FUNDS_SUMMARY`, deliberately and with a comment saying so. Upstream's sentence is "this account does not have enough funds", which is right for a purchase from the player's wallet and wrong here: the account is a signer they were never told about, so "this account" reads as the wallet, which is probably funded. Upstream names the failure; the game has to name WHOSE it is, because that is what makes the remedy a top-up of the signer.

Those three call sites had NO tests, which the migration exposed rather than caused: two deliberate mutations (the boundary classifying a contract revert as out-of-gas, the auto-resume firing on any error) both passed a full green suite. They are covered now, in `test/lib/placement/commit-reveal.test.ts`, `test/lib/placement/hud.test.ts` and `test/lib/context/resume-on-gas.test.ts`, and each was confirmed by re-running the mutation. Getting the boundary wrong is not a cosmetic bug: it offers a player a top-up that cannot fix a revert, or spends gas that has only just arrived on a move that will fail again the same way. "Carry on once the gas arrives" is now `resumeWhenGasArrives` in `context/game.ts`, extracted purely so the one piece of wiring that spends the player's gas unprompted can be tested without standing up an app context.

**The whole remedy is now covered in a browser too**, by `web/e2e/tests/out-of-gas.e2e.ts`: it stakes, takes every wei off the signer with `hardhat_setBalance`, fails a real commit, and asserts the three things in the order they matter - the failure is NAMED as gas, the top-up is offered next to it unprompted, and gas arriving resumes the round all the way to `Revealed`. The refill is an external transfer rather than a press of the app's own top-up button, deliberately: the round watches the signer's BALANCE, not the flow, so a faucet or a transfer by hand has to work too, and pressing the button would only prove the button works. It runs to `Revealed` rather than stopping at `Committed` because the reveal is a second transaction from the same signer, so a remedy that only got as far as the commit would still cost the player their bond. Checked for teeth: unwiring `resumeWhenGasArrives` fails it at the resume, and removing the wrap at the boundary fails it at the naming.

What that test does NOT cover is the wrong direction, a contract revert being offered a top-up that cannot fix it. That needs a move which reverts on chain rather than being refused by the node, and it is pinned by unit tests instead.

**Still to do:** the HOSTED sign-in path cannot be exercised locally, because no hosted sign-in service is configured anywhere, so every local run takes the wallet-only fallback. Narrower than it first looks, and this was overstated here before: a wallet-only sign-in still DERIVES a signer (`hasLocalSigner` is `targetStep === 'SignedIn'`, not "is there a wallet host"), so e2e does run the whole signer path for real, including draining it and topping it back up. What remains unproven is an account authenticated by email or social sign-in, which is the case with no wallet provider at all. Also, showing the signer balance in the TOP BAR belongs upstream in jolly-roger rather than here, so every descendant gets it rather than this template diverging `lib/core`.

## Sent upstream, or worth sending

- ~~**The delegation client was bound to the demo's contract by NAME**~~ **TAKEN.** It took an address here first; jolly-roger has it now, and the address travels on the delegation store exactly as it did here. The pair carries a chain id alongside it upstream, because a credential is bound to `(chainId, contract)`.
- **A ROUTER-BASED ADOPTER has to know that `address(this)` is the PROXY, and nothing in the package says so.** The signed message names the verifying contract, taken from `address(this)` inside a library whose functions are `internal` and therefore inlined into the caller. Behind a router the caller is a route running under `delegatecall`, so it is the proxy, which is the answer an adopter wants: the client addresses the proxy, the record lives at the proxy, and re-deploying a route invalidates no signature. But `Delegation.sol` only says `address(this)` means "YOUR contract rather than some library address", which answers the library question and not the proxy one, and an adopter reasoning it out from `delegatecall` semantics can talk themselves into either answer. Worth one sentence in `UsingDelegation`'s docs, since this template is the first adopter behind a router and will not be the last. Asserted here rather than reasoned about: see "Game delegation behind the router" in `contracts/test/js/Game.test.ts`, which reads the message off the proxy, finds the proxy's own address in it, registers with a signature built for that address, and refuses one built for the route implementation.
- **`ensureCanAfford` and `writeContract` disagree about `value` for payable functions** (see the findings above). Still unsent.

## What is left

1. **Port reveal-or-die.** First real test of the seams against a game that was not written for them. Expect `CommitRevealAdapter` to need changing again.
2. **Port bomber-world** onto reveal-or-die. Small: ~18 files differ, and 64 of 81 shared web files are byte-identical.
3. **Port conquest** onto the template. Second bigint identity, different actions. Note this is a rewrite of working, tested code (406 unit + 11 e2e), so it needs the same scrutiny: the bugs found there (black map, click offset, scrollbar overflow) were all found by measuring in a real browser, not by reasoning.
4. **Reassess stratagems** once three ports are done.
5. **Make `getCellsInZones` scale.** See the findings below: it is O(256 x zones) regardless of how much is on the board, and the client batches around it. The contract-side fix is to track a zone's occupied cells so a read costs what the zone holds.
6. **`mine` is not drawn.** Which share of a cell belongs to you is deliberately not shown: the contract answers it only per cell (`getStakeOnCell`), and a client-side tally of "what I revealed this session" is wrong after a reload. Worth doing properly (a multicall over visible cells, with the player folded into the fetch scope) since a shared-cell game rather wants it.
7. **The credits `chains` block in `contracts/rocketh/config.ts` is still commented out.** The template now has a real per-move cost (a commit plus a reveal), so it can be filled in with measured gas rather than left as documentation. Until it is, the in-app balance shows native currency rather than a move count.
8. **The mint/approve/stake sequence is still three silent transactions.** A stepper (shadcn has one) was asked for and never built. `addToReserve(player, amount)` already lets the wallet pay and the signer be credited, so the plumbing is right and only the presentation is missing.

## What building the game found

Everything here was found by running the thing, not by reading it. Recorded because each one looks fine on the page.

- **`CommitRevealAdapter.commit` needed the actions, not just the hash.** A game whose stake is proportional to what was planned (this one bonds the exact placement cost) cannot size the bond from a hash, that being the entire point of a hash. The seam now passes `actions` to `commit`. This was the predicted weak spot and it broke on first contact.
- **A 3-second reveal phase forfeits the player's bond by design.** The client must notice the phase turned over (chain clock ticks once a second), estimate gas, sign, broadcast, and be MINED inside the window, and the contract judges by the timestamp of the block it lands in. Measured: a reveal fired as the phase opened still landed ~5s later and reverted `InCommitmentPhase`. Local config moved to 30s commit / 10s reveal.
- **`writeContract` resolves on BROADCAST.** A reverted commitment looked like a successful one, and the only symptom was a baffling `NothingToReveal` a phase later. Commit and reveal now wait for inclusion and throw on revert, so the round's states mean what they say. The reserve top-up waits too, and there it is a correctness fix: `addToReserve` depends on the `approve` before it.
- **One missed reveal locked a player out forever.** An unrevealed commitment from a past epoch makes every later `makeCommitment` revert with `PreviousCommitmentNotRevealed`, and nothing in the client ever called `acknowledgeMissedReveal`. See the section below: this is now surfaced and settled by the player, deliberately.
- **"Missed" is a question about the CURRENT epoch, not a property of the commitment.** The same commitment is live in the epoch it was made and forfeit in the next. Checking only on load and on account change meant a tab open across the boundary answered "nothing is wrong" once and never revisited it, leaving the player blocked with no idea why committing did nothing. The check re-runs on every epoch change.
- **The game canvas was hiding its own clock.** `absolute inset-0` with no positioned ancestor pins to the VIEWPORT, so the canvas slid under the sticky `z-50` navbar, which then covered the top of the HUD. The casualty was the phase countdown, the one thing a player needs to see. The comment justifying `absolute inset-0` had been ported from conquest, whose layout does have a positioned content region; this one does not. The game route stays in normal flow now.
- **`getCellsInZones` blows the node's `eth_call` gas cap.** It walks all 256 cells of every zone TWICE, so cost tracks the zones asked for and not the board. The wall is 14 zones on a stock hardhat node; a camera at default zoom asks for 15. Worse, because the Game sits behind a router, the failure surfaces as "function selector was not recognized" rather than anything resembling out-of-gas. The reader now batches 8 zones per call.
- **The poller treated "node has not reached this epoch" as a failed read**, which starts exponential backoff and feeds the health banner a false outage: a blank board every epoch boundary until the player pans. It now retries within a block-time-scaled budget, which is what conquest already does inside its fetcher.
- **`ensureCanAfford` and `writeContract` disagree about `value` for PAYABLE functions.** Upstream never hit it because the demo only calls nonpayable ones. Cast at that one boundary rather than editing `$lib/core`, which has to stay mergeable. Worth fixing upstream.
- **`web/src/lib/deployments.ts` was stale**, still the OLD avatar-based game (`avatarID`, an `avatars` IERC721, a deposit route). It is generated and gitignored, so it silently disagrees with `contracts/src`. Regenerate it before trusting `web:check`: deploy locally, then `pnpm --filter ./contracts export localhost --ts ../web/src/lib/deployments.ts`.

## A missed reveal is acknowledged BY THE PLAYER

Worth its own section, because the obvious shortcut is wrong and was briefly taken.

The contract keeps one open commitment per player. Miss a reveal phase and that commitment stays on the books, the bond is gone, and every later `makeCommitment` reverts with `PreviousCommitmentNotRevealed`. `acknowledgeMissedReveal` is what settles it, and it FORFEITS THE BOND.

The first attempt made this self-healing: the adapter quietly acknowledged any stale commitment at the start of the next commit. It made the tests pass and it was wrong twice over. It spent the player's stake inside a transaction they thought was about something else, and it meant they were never told they had missed a reveal or what it had cost. Losing a stake is the most important thing this app can ever have to say to someone.

So `web/src/lib/placement/missed-reveal.ts` reads the chain (not local storage, so it still works from another browser or after clearing site data), the HUD states what happened and what it cost, committing is blocked with a reason instead of failing at the contract, and the forfeit is settled only on a deliberate press. `beforeCommit` on the adapter refuses a commitment that cannot succeed and says what to do about it.

The rule to keep: **the framework may spend gas on the player's behalf to protect their stake (that is what auto-reveal is), and must never spend the stake itself without being asked.**

Guarded by unit tests in `web/test/lib/placement/missed-reveal.test.ts` (checked for teeth by reintroducing the auto-acknowledge, which fails two of them) and by an e2e test that misses a reveal for real - it commits, closes the tab before the reveal phase, and comes back in a fresh browser context with empty local storage.

## What all five games say about the seams

All five were read against the seams (catacombs, stratagems, reveal-or-die, bomber-world, conquest). What follows is what that survey found, and it is the best evidence available short of doing the ports.

### Confirmed by every game

- **The epoch maths is framework, not a seam.** `epoch = floor(timePassed / epochDuration) + 2` appears character for character in all five contracts AND in every client that has one, `+ 2` comment included. Same for `commitTimeAllowance = revealPhaseDuration + 0.1` and the `4 * epochDuration / averageBlockTime` block-window heuristic.
- **The commitment hash is `bytes24` everywhere**, a truncated keccak over `abi.encode(secret, actions)`. `hash: 0x${string}` covers it, but nothing enforces the width.
- **`reveal` takes the identity as an argument and does not check the caller**, in every game. Revealing on someone else's behalf is a design goal across the board, not a template quirk.

### Changed as a result of the survey

- **`CommitRevealAdapter.commit` now receives `secret`, `epoch` and `revealDueAt`.** Stratagems and catacombs hand a timelock-encrypted reveal transaction to a scheduler (fuzd, encrypted to a drand round) at COMMIT time, so an offline player still reveals. That is impossible unless commit sees the secret and knows when the reveal falls due. `revealPhaseStartTime` in `epoch.ts` is the inverse of the epoch formula, tested against the forward one.

  Note WHY those two lean on a scheduler: both run a **23h/1h** commit/reveal split, and nobody can be expected at the keyboard for the reveal hour. It is a consequence of the round length, not a rule about how reveals work. A game with a short round reveals from the browser, and conquest wants an offline hot-seat mode where turns are simply waited out.

- **`createRound` gained a three-way `autoReveal`** (`immediately` | `fallback` | `never`, default `immediately`) rather than an on/off switch, because those three cases all exist. `fallback` is the interesting one: the scheduler is expected to reveal, but if the round is still open once most of the reveal phase has gone, this browser tries anyway. A duplicate reveal costs one reverted transaction; a missed one costs the stake, so trying is the right bias.

  **Revealing is never taken away from the player.** `reveal()` is always callable whatever `autoReveal` says, and every one of these contracts takes the identity as an argument instead of using `msg.sender`, so a third party can always reveal too. Scheduling is an addition, never a replacement.
- **`createRound` gained `makeSecret`.** reveal-or-die, bomber-world and stratagems all DERIVE the secret from a signature over `Commit:<chainId>:<contract>:<epoch>` rather than randomising it. That is strictly better against the failure that costs money here: a random secret exists only in storage, so losing storage forfeits the stake, while a derived one can be recomputed on another device from a key the player still holds.

### Corrections to the record

Kept because both were asserted confidently and both are wrong, and the wrong versions are the kind that get copied forward.

- **The local classifier did NOT misfire on an ERC20 shortfall.** Kept now that the classifier is gone, because the wrong version is the kind that gets copied forward into the next repo that writes one. It was justified upstream by saying `/exceeds the balance/i` matches OpenZeppelin's "ERC20: transfer amount exceeds balance". Measured: it does not. OZ v4 says "exceeds balance" with no "the", OZ v5 uses a custom error, and this repo's `GameToken` is solidity-kit anyway and raises `NotEnoughTokens` / `NotAuthorizedAllowance`, which matched none of the patterns. That pattern was dead weight, not an active bug, and it did not survive the move: upstream's `PATTERNS` never had it. The REAL reason to move was different and has now been acted on: running a prose classifier over contract reverts can false-positive on any `require` string containing wording like "insufficient funds", and upstream excludes reverts by TYPE and by text before reading any prose. That is the difference the game's own tests now pin, since the template's contract raises custom errors, which viem renders with the author's string and no "reverted" anywhere near it.
- **A missed reveal does not always mean a forfeited bond.** Stated here originally as though a burnt deposit were the only shape. conquest and catacombs intend to dock levels from a character the player paid for, which degrades their position instead. The framework only requires that not revealing costs something.

### Known not to fit yet, in rough priority order

1. **The round never reconciles with the chain.** `restore()` trusts local storage alone. Every one of these contracts exposes `getCommitment(identity)`, which would let a client notice "there is a live commitment on chain that this browser knows nothing about". Today that case is a silent forfeit. It pairs with `makeSecret`: a derived secret plus a chain read is a genuinely recoverable round. `missed-reveal.ts` already does the chain read for the FORFEIT case; the live case is the missing half.
2. **No `cancel`.** `cancelCommitment` exists on this template's own contract, and on conquest and reveal-or-die, and `RoundStore` has no way to call it. Cheap to add, and the template is currently shipping an unreachable contract function.
3. ~~**Identity is really a PAIR.**~~ **CLOSED.** catacombs (`characterID` + controller), reveal-or-die/bomber-world (`avatarID` + controller), conquest (`empireID` + `Empire{owner, controller}`) all separate the identity from the address authorised to act for it, usually a burner key. The template now demonstrates that split rather than the degenerate case: the account is the identity, the signer is the controller, and `@etherplay/delegation` records the authority. What is still degenerate is the identity TYPE (an address, not an `avatarID`), which is decision 2's type parameter and a different axis.
4. **Identity ACQUISITION has no seam.** Three games require minting an ERC721 and depositing it before a player exists at all. The round takes `identity: Readable<TIdentity | undefined>` and simply does nothing while it is undefined; the onboarding flow that produces one is off the map. conquest additionally allows several identities per account, which a round keyed on the account address cannot represent.
5. **`createViewState` demands `TState & {epoch: number}`.** Indexer-built state (stratagems, catacombs) carries no epoch; it comes from a separate store. That requirement should be relaxed rather than forcing every indexer game to fake a field.
6. **`OnchainStateStore` needs an adapter for an indexer.** `ethereum-indexer-browser` exposes `{state, syncing, status}` with no `update()` and a different status shape. Anticipated by decision 4, and it is an adapter rather than a redesign, but nobody has written it.
7. **`GameRenderer.tick()` takes no time argument**, and both WebGL games want `render(time)`. Also both drive the frame loop from their own component rather than letting the framework tick them.
8. **The camera is a subset.** stratagems and catacombs each have a `Camera` class owning input, zoom animation, device pixel ratio and localStorage persistence. `CameraWatcher` can be derived from it; `CameraControl` / `CameraSurface` do not match.

### Two rules, checked against reality

**Order independence: the rule stands, and conquest is where it has to be enforced.**

conquest's `_acquireStarSystem` is literally "first to reveal takes the empty system" (`// TODO auction or distance`), the exact pattern `AGENTS.md` forbids. That is NOT evidence the rule is negotiable, it is unfinished work: conquest-v1's resolution rules are not written yet and this is one of the things the port has to tackle. Treat it as a defect to fix, not as a precedent.

stratagems is the one that already gets it right, and it is subtle: it DOES read a same-epoch write (`epochWhenTokenIsAdded == epoch`) but converges regardless of arrival order by turning any contested cell `Evil` and having every placer pay the same. Worth studying before writing resolution rules, because it shows the rule does not forbid reading shared state, only letting the ORDER change the outcome.

**Only this template has a test for the property.** None of the other four do. Every port should bring `contracts/test/Game.test.ts`'s replay-in-both-orders test with it.

**Something at stake: the shapes differ more than "a bonded token".**

The framework requirement is only that not revealing costs something. What that something is varies, and the template must not assume its own answer:

- this template: an ERC20 bond, forfeited by `acknowledgeMissedReveal`
- stratagems: reserve tokens, burnt
- conquest and catacombs: **the character/avatar itself, which the player paid for.** The intent is that a missed reveal DOCKS LEVELS, which degrades the player's position (in conquest, with knock-on consequences for the empire) rather than seizing a deposit. The `// TODO burn / stake ....` left in their `_acknowledgeMissedReveal` is unwritten code, not an absence of design. Whether it works economically is explicitly still open.

So do not read "only two of five have a stake" into the TODOs, and do not build framework helpers that assume settling means burning a bond. A degrading stake also means the `Missed` state is not always terminal-and-total, which is why `RoundState.Missed` is now worded as "lost by the game's own rules" rather than "forfeit".

### Spotted in the other repos (not touched)

Reported, not fixed, because they are outside this repo. The first three look like real bugs; the rest is unfinished work, listed so a port does not mistake a gap for a decision.

- stratagems and catacombs BOTH have the same copy-paste: `commitPhaseDuration: Number(data.revealPhaseDuration.slice(0, -1))`, so the client believes the commit phase is as long as the reveal phase. On a 23h/1h split that is a 23x error.
- stratagems hardcodes `START_TIME = 0` client-side while the contract reads it from config.
- In both, `linkedData` numbers arrive as strings with a trailing character (`"82800n"`), hence the `.slice(0, -1)`. This template's `resolveEpochConfig` uses plain `Number(...)` and would produce `NaN` against that shape. Check the rocketh version when porting.
- catacombs is earlier than the table suggests: the contract does not yet verify the commitment (`// TODO check secret`), `_apply` persists only `position` (HP, XP, monsters and battle results are computed then discarded), the web layer has no epoch clock and no reveal path, and `startCommit` calls the Characters NFT rather than the game. Its fuzd plumbing is fully written and never called. Its PvP layer is not written either.
- conquest's resolution rules are unwritten (`_acquireStarSystem`'s first-come branch, `_acknowledgeMissedReveal`'s missing level penalty). Both need designing as part of the port, not porting as-is.

## Known risks

- **The seams are proven by exactly ONE game, and it is the one they were designed for.** Everything compiles and runs against them now, which is a real step up from the previous handoff, but a template that fits its own example game is the easy case. The ports are still where they get tested.
- **`CommitRevealAdapter` is still the one most likely to be wrong.** It already needed one change (see above). It assumes the framework owns the round and the game owns the calls. Stratagems reveals from a timelock-encrypted commitment via a scheduling service (fuzd), which may not fit. Find out during the reveal-or-die port rather than hardening around it.
- **The round auto-commits and always auto-reveals.** Auto-reveal is not optional and should not be made optional: a missed reveal costs the player their stake, and a UI that merely offers a button takes their money for not watching the clock. `autoCommit` is a flag; auto-reveal deliberately is not.
- **Acknowledging a missed reveal is the player's to make, and must stay that way.** See below.
- **The e2e chain is shared and reused across runs**, so the game test asserts on CHANGES (stake delta on the clicked cell) rather than absolutes. A test asserting "the board is empty" passes once and then never again.
- **Contract override is a permanent conflict zone.** Each game replaces the
  template's `contracts/src/`. Accepted, but expect merges to conflict there.

## Stratagems and catacombs: why they are deferred

Both are descendants of this template in the tree above. They are deferred because of the size of the migration, not because they belong somewhere else, and both have already earned their keep as design input: between them they are why identity is a type parameter, why the state store is a seam, and why `commit` now carries the secret.

**stratagems** is a different generation of the stack: Svelte **4** (no runes), `web3-connection`, `ethereum-indexer-browser`, twgl.js WebGL, hardhat 2 + rocketh 0.10, plus fuzd / tlock-js / missiv and extra `common`, `indexer` and Cloudflare-worker workspaces. 1137 commits, 1022 files, no common ancestor with jolly-roger. Integrating it means a Svelte 4->5 migration, a connection-library swap, a state-model swap, a renderer swap and a hardhat 2->3 + rocketh 0.10->0.19 migration, each about the size of the whole conquest graft. The user wants it merged (histories preserved, no force-push) eventually.

**catacombs** is closer than stratagems in some ways and further in others. Closer: it is already **Svelte 5** with `@sveltejs/kit` 2, and its epoch maths is identical to the template's. Further: it shares stratagems' whole services generation (indexer, fuzd + tlock + remote-account, twgl.js WebGL, `common` / `indexer` / `helper-services` / `farcaster-frame` workspaces), and it is UNFINISHED on both sides. The contract never checks the commitment hash, nothing is at stake, and `_apply` discards everything the reveal computes except position; the web layer has no epoch clock, no round, and no reveal path at all, while its fuzd plumbing is fully written and never called.

Catacombs is two games stacked. Underneath is a solo PvE dungeon crawl that is deterministic per day and can be played offline: the commitment hides a whole day's path and battle plan, so the outcome cannot be ground for a good roll. Over that sits a PvP layer where players compete, or co-operate against shared boss fights. **It has shared state and it is contested**; the PvP half is simply not written yet.

So all five games are simultaneous-turn games over shared state, and the order-independence rule applies to catacombs exactly as it does to the rest. An earlier draft of this document said otherwise, on the strength of reading only the unfinished implementation. Do not conclude anything about a game's design from what its contracts currently do; three of the five are mid-build.

The offline-playable solo layer is worth noting for a different reason: it means the client can simulate a day locally. Catacombs does this through a local EVM (`template-game-contracts-js`), and stratagems does the equivalent with a 700-line TypeScript reimplementation of its contract in `common/`. That simulation is what their view layer projects, which is why `ViewMerge` being "cheap" is wrong for those two: for them the merge IS the simulation. Expected, not a smell.

Porting order suggestion: reveal-or-die, then bomber-world, then conquest, and only then decide whether catacombs or stratagems goes first. Catacombs is the better fourth on stack grounds (Svelte 5 already), but it needs its GAME finished as well as ported, so the two jobs would be tangled.
