<!--
  Point-in-time audit, 2026-08-26, taken BEFORE the port began.
  Kept because its findings are still open: the backport candidates for
  template-commit-reveal, and the renderer risks. Line numbers refer to the
  tree as it was on `main`, not to the port branch, so treat them as
  pointers rather than coordinates.
-->

# ROD avatars + sale: what belongs in TCR, what stays in ROD

Read-only investigation. Nothing in either repo was modified. ROD = `/home/wighawag/dev/github/wighawag/reveal-or-die`, TCR = `/home/wighawag/dev/github/wighawag/template-commit-reveal`.

Sibling test applied throughout: a change's HOME is the highest level where it is still meaningful. If a hypothetical sibling descendant of TCR (a different simultaneous-turn game, no avatars, no grid) would want it, it belongs in TCR. If it would be dead code or nonsense there, it stays in ROD.

## Headline

The user's position is right, and the evidence is stronger than expected: TCR has ALREADY decided where most of this lives, and wrote the decision down. `template-commit-reveal/web/src/lib/ui/credits/get-credits.ts:55-107` names ROD's sale contract by signature (`SaleViaNativePayment.purchase(to, subID, data, extraNativeTokenRecipient, extraNativeTokenAmount, referrer)`), calls the `getCredits` body "THE SEAM" that a real game replaces, and then spends fifty lines working out which of the three composed effects (pay, fund the signer, register the delegate) survive a sale contract in the middle. TCR holds the SEAM and the ARGUMENT; ROD holds the INSTANCE. That is the tree working correctly, and it means most of the sale package is already home.

Two things came out of the reading that were not in the brief and that change the answers:

1. ROD's stake invariant is not implemented by `GameDeposit.sol` at all. It is implemented by liveness decay in `_getResolvedAvatar` (`reveal-or-die/onchain/evm/src/game/internal/UsingGameInternal.sol:420-448`), and `_acknowledgeMissedReveal` (same file, `:213-233`) is a stub with two `TODO`s that forfeits nothing.
2. Half the "package" is not wired to anything. `Locker.sol` and `SaleViaERC20Payment.sol` are never deployed (`reveal-or-die/onchain/evm/deploy/` deploys only `Avatars`, the four Game routes, and `AvatarsSale`) and never imported by web or contracts. `ErrorsUtils.sol` has zero call sites in ROD source. Backporting unused code is how a template acquires furniture nobody can delete.

---

## 1. Inventory, decomposed

| Piece | File | What it actually provides | Generic or ROD | HOME |
|---|---|---|---|---|
| `Avatars` | `onchain/evm/src/avatars/Avatars.sol:1-16` | An `EnumerableERC721` with a 7-line unpermissioned `mint` | ROD (see finding F1) | ROD |
| `AvatarsSale` | `avatars/AvatarsSale.sol:13-21` | Binds tokenID = `(owner << 96) + subID`, decodes `(owner, delegate)` out of `data` | ROD (the ID scheme is ROD's) | ROD |
| `SaleViaNativePayment` | `avatars/SaleViaNativePayment.sol:134-201` | Fixed-price native sale + `_executeMint` hook + freemap + **`extraNativeTokenRecipient` split** | Mixed | mostly ROD; one idea for TCR |
| `SaleViaERC20Payment` | `avatars/SaleViaERC20Payment.sol:87-273` | Three purchase paths (permit / approved / ETH-via-Uniswap-UniversalRouter) + rescue functions | ROD (undeployed) | ROD |
| `Locker` | `avatars/Locker.sol:1-224` | Generic NFT escrow: owner + delegate per token, admin-vetted destinations, re-entry via `onERC721Received` | Generic in shape, unused in fact | ROD (see §3) |
| `GameDeposit` | `game/routes/GameDeposit.sol:1-74` | NFT custody route, deposit-via-`data`, withdraw, `avatarsPerOwner` | Mixed | ROD; two ideas for TCR |
| `ErrorsUtils` | `game/internal/ErrorsUtils.sol:1-72` | Collect-errors-as-events instead of reverting | Generic in shape, dead code | ROD (see §4) |
| `GameUtils` | `game/internal/GameUtils.sol:1-89` | 16x16 zone bitfield decode: wall / box / obstacle | Pure ROD | ROD |
| `avatars.ts` store | `web/src/lib/onchain/avatars.ts:26-176` | Poll-with-backoff store over `tokensOfOwner` + `avatarsPerOwner`, tri-state (wallet / bench / in-game) | ROD domain, generic polling shape TCR already has | ROD |
| `purchaseFlow` | `web/src/lib/ui/flows/purchase/purchaseFlow.ts:26-116` | 5-state flow, faucet-or-wallet fork, poll-until-owned | ROD, and strictly weaker than TCR's | ROD |
| `enterFlow` | `web/src/lib/ui/flows/enter/enterFlow.ts:41-165` | Gate chain: signed-in? loaded? has bench avatar? else purchase | ROD | ROD |

### Generic facilities the package genuinely contains

There are only four, and two of them TCR already has:

- **Split `msg.value` between the purchase and the local signer's gas** (`SaleViaNativePayment.sol:143-150`). TCR already knows about this; it is the seam doc at `get-credits.ts:55-62`. What TCR does not have is a working contract-side example.
- **`payee` + `msg.value` forwarding on a game route** (`GameDeposit.sol:22-26`). TCR already has exactly this on `GameCommit.makeCommitment` (`contracts/src/game/routes/GameCommit.sol:43-47`) and `GameReveal.reveal` (`GameReveal.sol:18-22`). Nothing to backport.
- **A stake that is not fungible** (NFT custody rather than a token reserve). TCR already asserts this is allowed, in prose, twice: `AGENTS.md:67-72` and `UsingGameInternal.sol:21-26`. See §2.
- **Cursor pagination on view functions** (`GameDeposit.sol:52-73`, `UsingGameInternal.sol:469-494`). TCR has NO pagination anywhere and has already been bitten by it. This is the one clear, uncontested backport. See §5-C.

Everything else is furniture: the tokenID packing scheme, the freemap, the Uniswap route, the referrer field, the tri-state avatar store, the enter-flow gate chain.

---

## 2. `GameDeposit.sol` and the stake invariant

**TCR's invariant** (`AGENTS.md:67-72`): "Something must be at stake, or nobody has to reveal... A game may gate differently (custody of an NFT, for instance); what the framework needs is only that *something* is lost by not revealing." The same sentence appears at the code (`contracts/src/game/internal/UsingGameInternal.sol:21-26`), where it explicitly nominates NFT custody as the alternative.

So the abstract question ("is a deposit/stake facility generic?") is already answered yes by TCR, and TCR chose to express it as a token reserve.

**Is a deposit/stake facility generic to commit-reveal games?** Yes, but TCR already HAS it. `_addToReserve` / `_withdrawFromReserve` (`TCR UsingGameInternal.sol:27-48`) plus `addToReserve` / `withdrawFromReserve` (`TCR GameCommit.sol:12-33`) plus `GameToken` (`contracts/src/tokens/GameToken.sol`, whose own doc comment says "a real game replaces this with whatever it actually wants at stake, or points the game at an existing token"). TCR's gap is not "no deposit route"; it is "the stake is hardcoded to `IERC20`". That is a real gap but it is a PARAMETERISATION gap, not a missing feature.

**Does ROD implement the invariant differently?** Yes, and worse. Three concrete differences, all in ROD's favour on paper and against it in the code:

| Property | TCR | ROD |
|---|---|---|
| What is staked | `IERC20` amount, bonded per commitment (`Commitment.bond`, `UsingGameTypes.sol:57-63`) | The avatar NFT itself, held in custody |
| Forfeiture | `_acknowledgeMissedReveal` burns the bond (`TCR UsingGameInternal.sol:195-219`) | `_acknowledgeMissedReveal` (`ROD:213-233`) forfeits **nothing**: body is `commitment.epoch = 0` plus `// TODO burn / stake ....` and `// TODO block nft control` |
| Actual penalty for silence | Cannot commit again until acknowledged and burned (`TCR:70-72` reverts `PreviousCommitmentNotRevealed`) | `life = 0` after 3 missed epochs, computed lazily at read time (`ROD:427-438`); the equivalent commit-time guard is **disabled**, `ROD:81-88`: `// TODO reenable`, replaced by a debug event |
| Can the stake be withdrawn while a commitment is open? | No: `_withdrawFromReserve` locks `commitment.bond` and says why (`TCR:36-44`) | `_withdraw` checks only `_avatars[avatarID].inGame` (`ROD:36-45`); an open unrevealed commitment is not consulted at all |

ROD's stake works only by accident of the second-order effect: a dead avatar has `inGame == true` and there is no path that clears it (an `Exit` action needs `life > 0`), so a dead avatar's NFT is permanently bricked inside the Game contract. It is forfeited by being unreachable, not by being taken. That is not a design a template should copy.

**Which is the better generalisation?** TCR's, clearly.

- TCR's forfeiture is EXPLICIT (an amount moves, an event says how much: `CommitmentVoid(player, epoch, forfeited)`, `TCR UsingGameEvents.sol:42`). ROD's is a side effect of a liveness rule.
- TCR's is *self-enforcing without a third party*: the defector cannot play again until they acknowledge, so nobody has to be paid to punish them. ROD's `acknowledgeMissedReveal` is optional and forfeits nothing, so it exists only to unstick the player.
- TCR's is DIVISIBLE. A bond is proportional to what was committed (`cost = placements.length * PLACEMENT_COST`, `TCR:143-148`). NFT custody is all-or-nothing: you cannot risk *some* of an avatar, which is why ROD had to invent a separate life system on top and ended up with two half-mechanisms instead of one.

**One idea in ROD's version is genuinely better and is worth stealing without the rest:** the penalty is COMPUTED at read time (`_getResolvedAvatar`) rather than CLAIMED by a transaction. TCR's `_acknowledgeMissedReveal` needs somebody to call it before the board reflects the defection. That is a legitimate design note for TCR's commit-reveal rules, not a code backport.

**Verdict on `GameDeposit.sol`: stays in ROD.** Every line of it is about `AVATARS` (`GameDeposit.sol:20`, `:34`, and the whole `_ownedAvatars` index at `ROD UsingGameStore.sol:29-30`). It is not a generalisation of TCR's reserve; it is a second, weaker instance of the same invariant. What TCR should take from having read it is described in §5-A and §5-C.

---

## 3. The sale abstraction

**Is "sell a token two ways" a generic facility TCR lacks?**

No. Three reasons, in increasing order of force.

**(a) The two are not two implementations of one abstraction.** There is no shared interface, no shared base, no shared file. `SaleViaNativePayment` (204 lines) and `SaleViaERC20Payment` (291 lines) are two independent `abstract contract ... is Proxied` with duplicated `Config` structs, duplicated `freemap` + `addToFreeMap` / `removeFromFreeMap` (`Native:168-188` vs `ERC20:227-247`), duplicated `Mint` event, duplicated `_mint` / `_executeMint` pair (`Native:190-203` vs `ERC20:277-291`), and duplicated error declarations. The abstraction that would be worth backporting has not been extracted yet; what exists is a copy-paste pair. `SaleViaNativePayment.sol:61-131` is a 70-line commented-out copy of the ERC20 file's Uniswap body, which is what copy-paste divergence looks like mid-flight.

**(b) The ERC20 variant is dead.** Not deployed (`deploy/020_deploy_sale.ts:13-18` deploys `AvatarsSale`, which extends `SaleViaNativePayment` only), not imported by `web/src/lib/onchain/writes.ts` (only `deployments.contracts.AvatarsSale`, `writes.ts:164` and `:215`). It also hardcodes a Uniswap V3 Universal Router command string (`ERC20:172-215`, `hex"0B010C"`) with a hardcoded fee tier and WETH address. Backporting a dead Uniswap integration into a template makes every sibling carry a DEX dependency none of them asked for. That is the definition of failing the sibling test.

**(c) TCR already made the call.** `get-credits.ts:52-107` is a deliberate, reasoned decision that the sale is a SEAM in the template and an IMPLEMENTATION in the game, plus a careful analysis of what does and does not compose across the hop. Backporting a concrete sale contract would overwrite a decision with an instance.

**`Locker.sol`: also stays in ROD, but for a different reason.** Unlike the sales, `Locker` is genuinely generic in shape: nothing in it mentions avatars or ROD, it is a per-token `{owner, delegate}` escrow with admin-vetted destinations (`Locker.sol:164-199`), and its `onERC721Received` re-registration (`:145-162`) is a reasonable pattern. But:

- It is dead code in ROD. No deploy script, no import, no test.
- It COLLIDES with TCR's existing delegation facility. `Locker`'s `{owner, delegate}` per token (`Locker.sol:68-71`) is a narrower, unauthenticated version of what `@etherplay/delegation` does at ACCOUNT level in `contracts/src/game/routes/GameDelegation.sol`. TCR's version binds the authorisation to the chain id and the contract address inside the signed message (`GameDelegation.sol:36-47`), supports signature-based registration, and supports withdrawal. `Locker`'s delegate is whatever the depositor typed into `data`. Adding it to TCR would present adopters with two delegation stories, of which the new one is weaker.
- Its authorisation model has a governance smell that a template must not normalise: `safeTransfer` (`:164-181`) lets the *delegate* move a token to any admin-vetted destination, and "vetted" means one admin address said so (`:100-114`). That is fine for one game whose admin is the game's own author; it is not a facility to hand every sibling.

**Verdict on all three: stays in ROD.** What TCR should take is described in §5-A.

---

## 4. `ErrorsUtils.sol` and `GameUtils.sol`

**`GameUtils.sol` -> stays in ROD. Not close.** Every function decodes ROD's 16x16 zone bitfield: `computeArea` asserts `PositionUtils.ZONE_SIZE == 16` (`GameUtils.sol:14`), `areaAt` hashes zone coordinates into `Areas.getAreaFromHash` (`:24-29`, generated data at `src/game/data/generated/Areas.sol`), and `obstacleAt` / `wallAt` / `boxAt` (`:31-88`) read 2-bit cell types out of two `bytes32`. A sibling game with no walls, no boxes and no 16x16 areas gets three functions that decode a data file it does not have. Its only consumers are `ROD UsingGameInternal.sol:663-664`. It also carries `import "hardhat/console.sol"` at `GameUtils.sol:7`, which should not exist in any deployed contract and certainly must not be inherited by a template.

**`ErrorsUtils.sol` -> stays in ROD, and should probably be deleted there.** The idea is generic and mildly interesting: instead of reverting, emit `Error(bytes4 selector, bytes data)` so a failure is inspectable from logs without tracing, and optionally accumulate several failures in one call (`ErrorsUtils.sol:39-71`). But:

- **It has no call sites.** `grep` for `ErrorsUtils`, `createErrorsCollector`, `revertWithEvent`, `collectError`, `ErrorsCollector` across `reveal-or-die/onchain/**/*.sol` and `**/*.ts` returns only the file itself and machine-generated artifacts under `onchain/evm/generated/` and `onchain/evm/artifacts/`. Nothing uses it.
- **`revertWithEvent` does not revert** (`:32-34`: the body is a single `emit`). The name states a postcondition the function does not have, and the doc comment above it pushes the obligation onto the caller ("the contract call need to be terminated and ideally no state should have been changed"). Shipping that to every sibling of TCR is shipping a trap.
- **It hardcodes a coupling to the game's event surface**: it emits `UsingGameEvents.Error` (`ROD UsingGameEvents.sol:91`), so it is not a standalone utility; a sibling would have to declare that exact event.
- **`hasErrors` and both `collectError` overloads are `internal` non-`view` while doing no state writes** (`:40-42`), which is a smell, and the collector silently writes past its array bound once `numErrors` exceeds `maxErrorCount` (default 10, `:23-25`) - Solidity will panic-revert on the index, which is precisely the revert-instead-of-report the design was trying to avoid.

If the pattern is ever wanted in TCR, it should be RE-DERIVED from the requirement, not lifted. The requirement is worth writing down; the code is not worth moving.

---

## 5. Backport candidates

Only three survive the sibling test. Each is stated as name / HOME / reason / cost.

### A. The composed entry transaction, as a documented pattern (NOT as code)

- **What:** one user transaction that pays, funds the local signer, and establishes the player's authority. ROD does it: `AvatarsSale.purchase` mints straight to the Game address (`writes.ts:164-172` passes `deployments.contracts.Game.address` as `to`), `_executeMint` forwards `data` (`AvatarsSale.sol:13-21`), the Game's `onERC721Received` decodes `(owner, controller)` and registers both (`GameDeposit.sol:29-46`), while `extraNativeTokenRecipient` peels the signer's gas out of the same `msg.value` (`SaleViaNativePayment.sol:143-150`). Buy + deposit + delegate + fund, one confirmation.
- **HOME: TCR** - but as a worked example in the existing seam doc, not as contracts. Every sibling of TCR faces the identical problem, TCR has already written 50 lines about it (`get-credits.ts:52-107`), and it currently has no instance to point at other than a signature quoted from another repo.
- **Why it is only prose:** the mechanism that makes ROD's version safe is that the ASSET IS THE AUTHORITY. Transferring the NFT is itself the consent, so the game can believe `data` without violating TCR's own rule ("A payment proves that somebody spent money, never whose account they are... Paying for somebody is always safe, speaking for somebody never is", `get-credits.ts:90-95`). A sibling whose stake is fungible has no such carrier and cannot copy the trick. So the generalisable content is the ARGUMENT, not the code.
- **Cost:** near zero. A paragraph in `get-credits.ts` or in `AGENTS.md` under "Commit-reveal rules", naming ROD as the instance and stating the precondition (the transferred asset must itself carry the authority). No collision.

### B. "The forfeiture should be computed, not claimed" (design note)

- **What:** ROD's defection penalty is evaluated lazily on read (`ROD UsingGameInternal.sol:427-438`, life decays after 3 missed epochs) rather than requiring a transaction. TCR's requires `acknowledgeMissedReveal(player)` to be called (`TCR GameReveal.sol:26-28`).
- **HOME: TCR**, as a note in `AGENTS.md` §Commit-reveal rules (near line 67), because every simultaneous-turn game has to answer "who pays the gas to punish the defector?".
- **Why not code:** TCR's design already answers it acceptably - the defector cannot commit again until they acknowledge and burn (`TCR UsingGameInternal.sol:70-72`), so the punishment is self-enforcing without a third party. ROD's lazy variant is only better for the *observable board*, and ROD's own version of that guard is disabled (`ROD:81-88`). Backporting the mechanism would be backporting from the weaker implementation.
- **Cost:** a paragraph. No collision.

### C. Cursor pagination on unbounded view functions

- **What:** the `(startIndex, limit) -> (items, more)` convention at `ROD GameDeposit.sol:52-73` and `ROD UsingGameInternal.sol:469-494` / `:496-529`.
- **HOME: TCR**, and this is the one with a concrete TCR defect behind it. `TCR GameGetters._cellsInZones` (`GameGetters.sol:84-110`) returns EVERY occupied cell in every requested zone with no bound. Its own doc comment (`:66-83`) records that the previous version already blew the `eth_call` gas cap at 14 zones while the default camera asked for 15, and that behind the router the failure surfaced as "function selector was not recognized". The index rewrite fixed the EMPTY-board case; it did not bound the FULL-board case. A busy board reintroduces exactly the same failure with exactly the same unhelpful error.
- **Cost:** low, and no ROD assumptions to strip - the convention is four lines of arithmetic and one bool. It does collide mildly with TCR's `getCellsInZone` / `getCellsInZones` ABI (`GameGetters.sol:52-64`), which would gain two parameters and a return value, so the web viewport reader would need updating. That is the whole cost.
- **IMPORTANT: do not copy ROD's implementation verbatim.** See finding F2 - the ROD version's `more` flag is inverted. Copy the CONVENTION, write the arithmetic fresh, and pin it with a test (returning fewer than `limit` must mean `more == false`).

### Explicitly rejected

| Candidate | Verdict | Reason |
|---|---|---|
| `SaleViaNativePayment` / `SaleViaERC20Payment` as contracts | ROD | Not one abstraction, ERC20 half is dead + hardcodes Uniswap V3, and TCR already chose the seam over the instance (`get-credits.ts:55`) |
| `Locker.sol` | ROD | Dead in ROD; collides with the stronger `GameDelegation` / `@etherplay/delegation`; single-admin vetted destinations is not a template-grade authorisation model |
| `GameDeposit.sol` as a route | ROD | Every line is `AVATARS`-shaped; it is a weaker second instance of TCR's existing stake invariant, not a generalisation of it |
| `ErrorsUtils.sol` | ROD (delete) | Zero call sites; `revertWithEvent` does not revert; coupled to `UsingGameEvents.Error`; unbounded collector |
| `GameUtils.sol` | ROD | 16x16 zone bitfield + generated `Areas.sol`; nonsense for a sibling; also imports `hardhat/console.sol` |
| `payee` + `msg.value` forwarding | already in TCR | `TCR GameCommit.sol:43-47`, `TCR GameReveal.sol:18-22` |
| Parameterising the stake to a non-fungible | ROD for now | The invariant is already stated in TCR prose (`AGENTS.md:67-72`, `UsingGameInternal.sol:21-26`); ROD has no working NFT-forfeiture implementation to generalise FROM (`ROD:213-233` is a stub). Generalising `IERC20` -> an `IStake` adapter would touch `Config`, `UsingGameStore`, `_addToReserve`, `_withdrawFromReserve`, `_makeCommitment`, `_reveal`, `_acknowledgeMissedReveal`, `GameCommit`, `GameGetters` and `GameToken`, for a second implementation that does not yet exist. Revisit if and when ROD's forfeiture is finished |
| `purchaseFlow.ts` / `enterFlow.ts` / `avatars.ts` | ROD | TCR's `ui/credits/top-up-flow.ts` (1587 lines) is a strict superset of ROD's 122-line purchase flow: payment-method enumeration (`payment-methods.ts`), account-switch handling, faucet integration, stale-credential recovery, session invalidation. Backporting ROD's would be a regression |

---

## 6. Findings (concrete, with severity)

These are ROD-side defects noticed while reading. None require action for the port decision, but F1 and F2 should not be carried forward, and F1 is a live security issue.

- **F1 - critical - `reveal-or-die/onchain/evm/src/avatars/Avatars.sol:9-15`: `mint` has no access control.** It is `external payable` and calls `_safeMint` directly. Anyone can mint any not-yet-existing tokenID to any address, for free, without going anywhere near `AvatarsSale`. `BasicERC721._safeMint` (`node_modules/solidity-kit/solc_0_8/ERC721/implementations/BasicERC721.sol:166-175`) only guards re-minting an EXISTING id. Since ROD's tokenID scheme is `(uint160(owner) << 96) + subID` (`AvatarsSale.sol:18`), an attacker can mint themselves unlimited well-formed avatars. Two consequences: the sale is bypassable, and - given that the NFT is supposed to be the thing at stake (TCR `AGENTS.md:67-72`) - the stake costs nothing, so the commit-reveal invariant is void in practice regardless of what `GameDeposit` does.
- **F2 - major - `reveal-or-die/onchain/evm/src/game/routes/GameDeposit.sol:72`: the `more` flag is inverted.** `return (list, actualLimit != limit);`. With `total = 5, startIndex = 0, limit = 100`: `actualLimit = 5`, so it returns `more = true` when the list is exhausted. With `total = 5, startIndex = 0, limit = 3`: `actualLimit = 3`, so it returns `more = false` when two remain. It is wrong in both directions. Masked today only because `web/src/lib/onchain/avatars.ts:59` and `:82` pass `limit = 100n` and ignore the flag (`avatarsOwnedResult[0]`, `avatarsDepositedResult[0]`), with `// TODO use pagination` at both call sites. Do not copy this into TCR (§5-C).
- **F3 - minor - `reveal-or-die/onchain/evm/src/game/internal/UsingGameInternal.sol:481-483`: off-by-one in `_getAvatarsInZone`'s `more`.** When `fromIndex + limit == numAvatarsInZone` exactly, the `else` branch sets `more = true` although the page is the last one. Same class as F2, benign (one wasted round trip).
- **F4 - major (ROD-internal) - `reveal-or-die/onchain/evm/src/game/internal/UsingGameInternal.sol:81-88`: the `PreviousCommitmentNotRevealed` guard is disabled.** `// TODO reenable`, replaced by `emit PreviousCommitmentNotRevealedEvent(...)`. Combined with `_acknowledgeMissedReveal` forfeiting nothing (`:213-233`), a ROD player can commit, dislike the epoch, stay silent, and commit again next epoch, paying only the 3-epoch life decay. This is the exact failure TCR's `AGENTS.md:67-72` exists to prevent, and TCR guards it at `contracts/src/game/internal/UsingGameInternal.sol:70-72`. Relevant to the port: do not let ROD's version of this file overwrite TCR's guard during the merge.
- **F5 - minor - `reveal-or-die/onchain/evm/src/game/internal/UsingGameInternal.sol:36-62`: `_withdraw` does not consult the open commitment.** It checks `_players[avatarID].owner` and `_avatars[avatarID].inGame`, but not `_commitments[avatarID].epoch`. TCR's equivalent locks the bond and documents why (`TCR UsingGameInternal.sol:36-44`). Currently unexploitable because a committing avatar has `inGame == true`, but the guard is load-bearing by coincidence rather than by construction.
- **F6 - minor - `hardhat/console.sol` imported in production sources**: `reveal-or-die/onchain/evm/src/game/internal/GameUtils.sol:7` and `.../UsingGameInternal.sol:10`. Must not reach TCR.
- **F7 - info - dead code in the "package"**: `avatars/Locker.sol` (224 lines), `avatars/SaleViaERC20Payment.sol` (291 lines) and `game/internal/ErrorsUtils.sol` (72 lines) have no deploy script, no import and no test in ROD. `SaleViaNativePayment.sol:61-131` is 70 lines of commented-out code. ~660 lines of the package are unreferenced.
- **F8 - info - `SaleViaERC20Payment.sol:271-273`**: `receive() external payable {}` with `// TODO use proxy that can receive it`, alongside `rescueETH` / `rescueTokens` gated on `onlyProxyAdmin` (`:259-269`). A silent ETH sink plus an admin sweep is a shape a template should never inherit; another reason this file stays in ROD.

---

## 7. Residual risks and things I did not verify

- I read `top-up-flow.ts` only to line ~1372 of 1588 (tool limit). My claim that it is a strict superset of ROD's purchase flow is based on the exported `TopUpFlow` surface, `TopUpPhase`, `payment-methods.ts` and `get-credits.ts`, all of which I read in full. The unread tail is `confirm` / `retry` / `reauthorise` / `back` / `dismiss` / `cancel` bodies; nothing there can weaken the comparison.
- I did not run any build, test or compiler. Line numbers are from the files as they stand on disk today, with both repos clean except for untracked `docs/` and `.pi-subagents/` in ROD.
- F1 assumes `EnumerableERC721` does not re-guard `mint` above `BasicERC721._safeMint`. I read `_safeMint` (`BasicERC721.sol:166-175`) and the ROD override chain (`Avatars.sol` is 16 lines, no modifier), but I did not read `EnumerableERC721.sol` in full.
- The judgement "TCR already decided this" rests on `get-credits.ts:52-107` being current intent rather than a stale comment. It reads as deliberate and recent (it names ROD's exact function signature), but I have not checked its git history.
- §5-C assumes TCR's viewport reader is the only consumer of `getCellsInZone(s)`. I did not grep TCR's web for every call site.
- I did not assess ROD's `web/src/lib/ui/flows/*/**.svelte` against TCR's Svelte conventions (`TCR AGENTS.md:9-27`, logic-minimal components, no `.svelte.ts`). `EnterFlow.svelte` is 105 lines and `PurchaseFlow.svelte` 40, both backed by `.ts` modules, which is the right shape, but I only skimmed them.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "/tmp/rod-port/02-avatars-backport.md contains an 11-row inventory with per-piece HOME verdicts, dedicated sections for GameDeposit (\u00a72), the sale abstraction + Locker (\u00a73), ErrorsUtils/GameUtils (\u00a74), three named backport candidates with HOME/reason/cost (\u00a75), a rejection table, and 8 severity-tagged findings (\u00a76) with file:line references in both repos, e.g. reveal-or-die/onchain/evm/src/avatars/Avatars.sol:9-15 (critical, unpermissioned mint) and reveal-or-die/onchain/evm/src/game/routes/GameDeposit.sol:72 (major, inverted pagination flag)."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "git status --porcelain (both repos)",
      "result": "passed",
      "summary": "ROD clean except untracked .pi-subagents/ and docs/; TCR fully clean. No repo files touched."
    },
    {
      "command": "grep -rn 'ErrorsUtils|revertWithEvent|collectError|ErrorsCollector' reveal-or-die/onchain",
      "result": "passed",
      "summary": "Only the source file itself plus machine-generated artifacts under generated/ and artifacts/. Zero call sites."
    },
    {
      "command": "grep -n 'artifacts\\.|Sale|Locker|Avatars' reveal-or-die/onchain/evm/deploy/*.ts",
      "result": "passed",
      "summary": "Deploys Avatars, GameGetters/Deposit/Commit/Reveal, AvatarsSale only. Locker and SaleViaERC20Payment are never deployed."
    },
    {
      "command": "grep -n '_safeMint' node_modules/solidity-kit/.../BasicERC721.sol",
      "result": "passed",
      "summary": "BasicERC721.sol:166-175 guards only re-mint of an existing id, confirming finding F1."
    }
  ],
  "validationOutput": [
    "Report written to /tmp/rod-port/02-avatars-backport.md (only file created).",
    "Backport verdicts: 3 candidates for TCR (composed entry transaction as documented pattern; 'forfeiture computed not claimed' design note; cursor pagination convention). 7 explicit rejections with reasons.",
    "Key correction to the brief's premise: ROD's stake invariant is NOT implemented by GameDeposit.sol. It comes from life decay in UsingGameInternal.sol:427-438; _acknowledgeMissedReveal at :213-233 forfeits nothing (two TODOs) and the PreviousCommitmentNotRevealed guard at :81-88 is disabled. TCR's token-reserve approach is the better generalisation on all three axes (explicit, self-enforcing, divisible).",
    "Second correction: TCR has ALREADY decided where the sale lives. web/src/lib/ui/credits/get-credits.ts:55-107 names ROD's SaleViaNativePayment.purchase by signature and designates getCredits as 'THE SEAM' a real game replaces.",
    "~660 lines of the avatars package (Locker.sol, SaleViaERC20Payment.sol, ErrorsUtils.sol) are unreferenced dead code in ROD."
  ],
  "residualRisks": [
    "top-up-flow.ts read to line ~1372 of 1588 (tool output limit); the 'strict superset' claim rests on the exported TopUpFlow surface, TopUpPhase, payment-methods.ts and get-credits.ts, all read in full.",
    "No build, compile or test was run; all line numbers are static reads of the current working tree.",
    "F1 assumes EnumerableERC721 adds no access control above BasicERC721._safeMint; I read _safeMint and the 16-line Avatars.sol override but not EnumerableERC721.sol in full.",
    "The 'TCR already decided this' judgement assumes get-credits.ts:52-107 is current intent rather than a stale comment; git history not checked.",
    "\u00a75-C assumes TCR's viewport reader is the only consumer of getCellsInZone(s); TCR web call sites not exhaustively grepped.",
    "ROD's .svelte files were not audited against TCR AGENTS.md:9-27 Svelte conventions, only skimmed."
  ],
  "noStagedFiles": true,
  "diffSummary": "No changes to either git repository. Single new file written outside both repos: /tmp/rod-port/02-avatars-backport.md",
  "reviewFindings": [
    "critical: reveal-or-die/onchain/evm/src/avatars/Avatars.sol:9-15 - mint() is external payable with NO access control; anyone can mint any unminted tokenID free, bypassing AvatarsSale. Since the NFT is meant to be the thing at stake, this voids the commit-reveal 'something must be at stake' invariant regardless of GameDeposit.",
    "major: reveal-or-die/onchain/evm/src/game/routes/GameDeposit.sol:72 - 'more' pagination flag is inverted in both directions (returns true when exhausted, false when items remain). Masked only because web/src/lib/onchain/avatars.ts:59,82 pass limit=100n and ignore it. Do NOT copy this implementation when backporting the pagination convention.",
    "major: reveal-or-die/onchain/evm/src/game/internal/UsingGameInternal.sol:81-88 - the PreviousCommitmentNotRevealed guard is disabled ('TODO reenable', replaced by a debug event). With _acknowledgeMissedReveal:213-233 forfeiting nothing, a player can commit, stay silent, and commit again. TCR guards this at contracts/src/game/internal/UsingGameInternal.sol:70-72; do not let the ROD file overwrite it during the merge.",
    "minor: reveal-or-die/onchain/evm/src/game/internal/UsingGameInternal.sol:481-483 - off-by-one, _getAvatarsInZone reports more=true when fromIndex+limit lands exactly on the end.",
    "minor: reveal-or-die/onchain/evm/src/game/internal/UsingGameInternal.sol:36-62 - _withdraw never consults _commitments[avatarID].epoch; safe today only by coincidence of the inGame flag. TCR locks the bond explicitly at TCR UsingGameInternal.sol:36-44.",
    "minor: hardhat/console.sol imported in production sources at reveal-or-die/onchain/evm/src/game/internal/GameUtils.sol:7 and UsingGameInternal.sol:10; must not reach TCR.",
    "info: reveal-or-die/onchain/evm/src/avatars/SaleViaERC20Payment.sol:271-273 - empty payable receive() ('TODO use proxy that can receive it') plus onlyProxyAdmin rescueETH/rescueTokens at :259-269; a silent ETH sink with an admin sweep is not a template-grade shape.",
    "info: ~660 lines dead in ROD - Locker.sol (224), SaleViaERC20Payment.sol (291), ErrorsUtils.sol (72) have no deploy script, import or test; SaleViaNativePayment.sol:61-131 is 70 commented-out lines."
  ],
  "manualNotes": "Bottom line for the parent: the user's instinct is correct and the evidence is stronger than expected. Only THREE things should move up to TCR, and two of them are prose rather than code. (A) Document the composed entry transaction (buy + deposit + delegate + fund-signer in one tx) as a worked example inside TCR's EXISTING seam doc at web/src/lib/ui/credits/get-credits.ts:52-107, which already names ROD's SaleViaNativePayment.purchase by signature. It generalises only with a stated precondition: it works because the transferred NFT itself carries the authority, which is why it does not violate TCR's own 'paying for somebody is safe, speaking for somebody never is' rule at get-credits.ts:90-95. (B) Add a design note under AGENTS.md 'Commit-reveal rules' (~line 67) that a defection penalty can be COMPUTED at read time rather than CLAIMED by a transaction - ROD does this via life decay; TCR's claim-based version is nonetheless fine because the defector is self-blocked from committing again. (C) Backport the (startIndex, limit) -> (items, more) pagination CONVENTION, rewritten from scratch. This is the only one with a live TCR defect behind it: GameGetters._cellsInZones (GameGetters.sol:84-110) is unbounded, and its own comment at :66-83 records the previous unbounded version blowing the eth_call gas cap at 14 zones while the camera asked for 15, surfacing behind the router as 'function selector was not recognized'. The index rewrite fixed the empty board, not the full one. Everything else stays in ROD, including GameDeposit.sol, both Sale contracts, Locker.sol, ErrorsUtils.sol and GameUtils.sol. Two premises in the brief needed correcting and both are argued in the report: ROD's deposit does not implement the stake invariant (life decay does, and crudely - a dead avatar's NFT is forfeited only by becoming permanently unwithdrawable), and TCR does not lack a stake facility (it has one, hardcoded to IERC20; the gap is parameterisation, and there is no finished ROD implementation to generalise from yet). Also flagging F1 as a live security issue independent of the port: Avatars.mint is unpermissioned, so the sale is bypassable and the stake is free."
}
```
