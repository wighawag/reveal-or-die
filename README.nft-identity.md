# `with/nft-identity`

The reference game, keyed by a token instead of by an account. Same game, same
board, same round: what changes is who a player IS, how they get one, and what
they lose by going quiet.

`main` is deliberately an address game (decision 3 in `work:HANDOFF.md`), so
that `PlayerIdentity` is exercised as a type parameter rather than assumed.
That is right and it leaves identity ACQUISITION with no user upstream, which
is the gap this branch fills: four of the five games this template exists for
identify a player by a token they own (`avatarID`, `characterID`, `empireID`).
See D2 and rules N1 to N6 of Decision 3 in
`work:work/specs/proposed/games-on-this-foundation.md`.

## The three things it changes, and nothing else

| | `main` | here |
| --- | --- | --- |
| **the identity** | the account, widened | an ERC721 token id |
| **acquisition** | one call that mints an ERC20 and stakes it | one call that mints an avatar INTO the game |
| **what is at stake** | a bond taken out of a reserve | custody of the avatar itself |

It does **not** add several tokens per account. That is D6, deferred but not
precluded, and both of D6's architectural rules are kept: the identity arrives
through an active-identity STORE rather than being derived from the account,
and everything keyed by "the player" is keyed by the identity. The provider
here picks the first avatar still in custody; making that a choice is a UI and
a remembered preference, not a change of shape.

## The shared-file edit list

This is rule **N1**'s budget, and the number this branch is judged on. Every
file here also exists on `main`, so every one of them is a place a future
cascade can conflict. Growing the list needs a reason, and each entry below
gives one.

**The plan predicted TWO** (`game/identity.ts`, and one line in
`context/game.ts`). The prediction was right about identity and counted only
identity; D2 lists three differences, and the other two have designated files
of their own. The list is **seventeen**, and it splits into five groups that are
worth reading separately, because they are not the same kind of cost.

### The seams: files that exist in order to differ (5)

| file | what the branch changes | lines |
| --- | --- | --- |
| `web/src/lib/game/identity.ts` | the alias is `bigint`; the provider reads custody | whole file |
| `web/src/lib/placement/stake.ts` | the stake's vocabulary: an avatar, not a bond | whole file |
| `web/src/lib/placement/reserve.ts` | what is at stake: custody, derived from the identity | whole file |
| `web/src/lib/placement/acquisition.ts` | names `AvatarSale`, and reserves more gas for a mint | 3 |
| `web/src/lib/context/game.ts` | the provider is handed what a chain read needs | 6 |

Four of the five say so in their own doc comments on `main`, before this branch
existed. `identity.ts` is N2's designated seam; `reserve.ts` says "a game that
gates differently (holding custody of an item the player bought, say) replaces
this file"; `acquisition.ts` says "a game that gates differently replaces this
file and nothing else"; `stake.ts` was extracted upstream **for** this branch,
which is why `placement/ui/hud.ts` and `routes/play/+page.svelte` are not on
this list. That matters more than the count: those two are a 523-line HUD
assembler and a route, both of which `main` keeps developing, and between them
they held six sentences about the stake.

`context/game.ts` is the one to watch, because it is the composition root and
the most conflicted file in the tree. Six lines, all in one hunk, and all of
them the same idea: an avatar game has to LOOK UP who is playing where an
address game already knows.

### The contracts (2 + 3 test files)

Contracts are not inherited between repos (decision 1 in `work:HANDOFF.md`),
but they ARE cascaded within this one, so N4 applies: a game varies by
overriding a virtual internal and never by editing a store.

| file | what the branch changes | lines |
| --- | --- | --- |
| `contracts/deploy/010_deploy_game.ts` | deploys the avatar routes; `placementCost: 0` | 41 |
| `contracts/deploy/020_deploy_stake_sale.ts` | deploys `AvatarSale` and wires the minter | whole file |
| `contracts/test/js/utils/index.ts` | `enterGame` buys an avatar | 1 function |
| `contracts/test/js/Game.test.ts` | the assertions that are about the STAKE | ~90 |
| `contracts/test/js/StakeSale.test.ts` | the sale's suite, for a different sale | whole file |

**`UsingGameStore.sol`, `UsingGameInternal.sol`, `IGame.sol`,
`UsingGameEvents.sol` and all four of `main`'s routes are byte-identical.** The
whole contract difference is `src/game/avatar/`, which is new: two overrides
(`_playerOf`, `_forfeit`) and the custody they read.

`Game.test.ts` is the honest cost, and it is smaller than it looks. Every
structural test in it - order independence, the delegation rules, the router's
selectors, the zone listing - is **unchanged**, and passes here against a
different identity model with the same words. What differs is the assertions
that name the stake, because the stake is different. That the two suites share
their structure is stronger evidence that the seam is in the right place than
either run is on its own, and it is what `enterGame` bought.

`020_deploy_stake_sale.ts` keeps `main`'s filename deliberately: renaming is a
delete plus an add, which arrives in every future cascade as a modify/delete
conflict, the most expensive shape there is. The alternative - leaving `main`'s
script alone and adding a second one - would ship a deployment offering a
purchase that does nothing, and a misleading contract is worse than a
misleading filename.

### Test fixtures that name an identity concretely (3)

| file | what the branch changes | lines |
| --- | --- | --- |
| `web/test/lib/placement/commit-reveal.test.ts` | one fixture: the identity is `255n` | 7 |
| `web/test/lib/placement/missed-reveal.test.ts` | one fixture, and the sentence about what was lost | 16 |
| `web/test/lib/placement/acquisition.test.ts` | the sale's name | 18 |

These are the boundary doing its job rather than failing: a suite that
instantiates the round with a concrete identity cannot be identity-agnostic,
and `web/test/identity-boundary.test.ts` exists to make sure there are no
OTHERS. The framework's own suites (`test/lib/game/core/`) are exempt and
unchanged, which is what keeps the address half of `PlayerIdentity` covered
even here.

### What is at stake, tested (1)

| file | what the branch changes |
| --- | --- |
| `web/test/lib/placement/reserve.test.ts` | custody, and the loading state that upstream does not have |

### The e2e, where the board is different (2)

| file | what the branch changes | lines |
| --- | --- | --- |
| `web/e2e/fixtures/game.ts` | `stakeOnCell` counts CLAIMS, not stake | 1 |
| `web/e2e/tests/game.e2e.ts` | the assertion that a reveal reached the board | 8 |

A placement costs nothing here, so the stake on a cell never moves and an
assertion against it would be trivially true of a board nothing had reached.
The claim count is the right quantity here for a reason that does not hold
upstream, which is why this is a swap rather than a fix: the e2e chain is
shared and reused, and upstream the same burner ACCOUNT plays every run, so its
second placement on a cell adds stake without adding a claimant. Here every run
buys an avatar, so the identity is new and a claim is always a new claim.

**Everything else in the suite is inherited unchanged**, including the setup
gate, the missed reveal and the round recovery. Two of those were made to work
by fixing `main` rather than this branch: the `stake()` fixture pressed a
button by its LABEL (which says what the game sells) and now presses a testid,
and the stalling-wallet fixture filled an address into a `uint256`. Both fixes
are upstream, so every future branch and descendant gets them.

## What is on the branch

```
contracts/src/tokens/GameAvatars.sol              the ERC721, mintable by ONE address
contracts/src/tokens/AvatarSale.sol               one payable call: mint into the game + stipend
contracts/src/game/avatar/UsingAvatarIdentity.sol  _playerOf, _forfeit, and custody
contracts/src/game/avatar/AvatarRoutes.sol        the routes that inherit them
contracts/deploy/005_deploy_avatars.ts            the NFT
web/test/lib/game/identity.test.ts                the provider, which upstream does not have
README.nft-identity.md                            this file
```

## Acquisition costs something, and so does going quiet

This is the rule the branch inherits from reveal-or-die, where the same NFT
shipped with an open `mint` for months: **a stake that costs nothing to acquire
is not a stake**, and a free mint voids the invariant the whole framework rests
on. A player who disliked what they had committed to could go quiet, lose the
avatar and mint another one for gas.

Three things make it real here, each with a test that fails when it is removed:

- **`GameAvatars.mint` reverts unless the caller is `minter`**, and `minter` is
  zero until wired, so a deployment that forgets the sale mints nothing rather
  than minting for free. The suite asserts both halves: a stranger cannot mint,
  and the minter really is the sale the deploy script created.
- **`AvatarSale.purchase` charges exactly**, price plus stipend, checked in
  both directions. What paying MEANS lives in the sale, so charging in an ERC20
  later is a new sale contract and one `setMinter` call.
- **Custody, not ownership.** The avatar lives in the game while it plays. If
  the game merely READ `ownerOf`, a player could sell the avatar inside the
  reveal window and walk away whole, leaving the buyer to be seized from -
  which is a costless exit with an extra step. `withdrawAvatar` refuses while a
  commitment is open, in the current epoch (you committed) and in a past one
  (you are already forfeit).

## The reserve is still there, and is never funded

`placementCost` is `0` on this branch's deployment, which is what "custody
instead of the bond" means in one number: a bond of zero is what lets a
commitment be made against a reserve nothing ever fills. `GameToken` and the
reserve mapping still exist, unused, because deleting them would mean editing
shared contracts to remove something a cascade will keep bringing back.

The visible consequence: a placement costs nothing, so this branch's board is
claimed rather than bought, and the HUD's cost line always reads "none". The
game is still a commit-reveal game, and what is at risk is the avatar.

## Cascade ritual

```sh
git merge main
pnpm --filter ./web check
pnpm --filter ./web run test:unit
BASE=main FEATURES=with/nft-identity EXT="ts svelte" \
  WATCH="web/src web/test web/e2e" \
  ALLOWED="web/src/lib/game/identity.ts web/src/lib/placement/stake.ts web/src/lib/placement/reserve.ts web/src/lib/placement/acquisition.ts web/src/lib/context/game.ts web/src/lib/placement/config.ts web/test/lib/placement/commit-reveal.test.ts web/test/lib/placement/missed-reveal.test.ts web/test/lib/placement/acquisition.test.ts web/test/lib/placement/reserve.test.ts web/e2e/fixtures/game.ts web/e2e/tests/game.e2e.ts" \
  bash <(git show tooling:check-shared-divergence.sh)
```

`tooling` is a LOCAL orphan branch here, adopted verbatim from jolly-roger's
(N6), so the command needs no sibling checkout on disk. **It is deliberately
not pushed to this repo's origin**: jolly-roger's copy is the only canonical
one, and a pushed copy here would be a second place it can drift. Rebuild it
with

```sh
git fetch stem tooling && git branch -f tooling stem/tooling
```

**The `ALLOWED` list is this README's table, in a shell variable, and the two
must be kept in step.** Anything that drifts under those paths and is NOT on it
is the failure the script exists for: a cascade whose conflicts were all
resolved correctly and which still left a shared file holding two versions of
the same logic. Run it once with `ALLOWED=` empty as well - that run is the one
that proves the clean files are clean because they are identical, rather than
because the script matched nothing.

`EXT="ts svelte"` for the reason `with/pixi-js` needs it: the default watches
`.ts` only, which is right for jolly-roger's connection layer and blind to a
component. This branch has no `.svelte` difference at all, and that is a claim
worth checking rather than remembering: the whole point of `stake.ts` is that
`GameHud.svelte` and `routes/play/+page.svelte` are byte-identical here.

**One thing it will not tell you: a DELETION.** It compares files two branches
SHARE, so a file removed on one side and still imported on the other leaves
nothing to diff. What catches that is the cascade's `verify` step.

## e2e

Not covered by `verify`, which is deliberate (it is too slow to be a gate) and
is its one blind spot: it proves the text compiles and the units pass, and
nothing about a browser. Run it by hand for this node:

```sh
cd web && CI=1 E2E_RPC_PORT=8638 E2E_PORT=4638 pnpm test:e2e
```

**51 passed, no retries, 14.0 minutes, at load average 5.7** (2026-09-10).
That is the strongest single thing this branch has to say: the same 51 tests
that click a real board, miss a reveal, run out of gas and recover a lost round
pass against a game whose players are tokens, whose entry is a mint and whose
stake is custody. Two of them assert on the board and are listed in the budget
above; the other 49 are inherited byte-for-byte.

**One thing that run is NOT evidence for.** The `/contracts` page opens on
whichever contract sorts first, so this branch's sale is called
`GameAvatarSale` in order to sort after `Game`. That is a workaround, and the
real fix already exists downstream: reveal-or-die has a `selectContract`
fixture and a `contracts-page.ts` beside it, neither of which was ever
backported. See
`work:work/notes/observations/the-contracts-suite-assumes-which-contract-sorts-first.md`.
