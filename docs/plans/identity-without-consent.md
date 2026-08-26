# Anyone can play as anyone, for gas (inherited)

Status: pointer. The finding is not this repo's, but the code is.

`onchain/evm` currently carries the pre-rewrite bomber-world contracts, unchanged in the parts that matter. `Avatars.mint` has no access control, and `GameDeposit.onERC721Received` writes `_players[avatarID] = Player({owner, controller})` from a payload nobody has to have consented to. Composed, that is one free call:

```
Avatars.mint(GAME, anyUnusedTokenID, abi.encode(victim, attacker))
```

after which the game records and displays the victim's address as the actor for every move the attacker makes, the victim cannot withdraw the avatar once the attacker has entered it, and there is no function anywhere that changes or clears a controller.

The full analysis, including why "they pay for it" is not a defence and why the victim has no remedy, is in:

**`../bomber-world/docs/plans/identity-without-consent.md`**

It applies here verbatim. Nothing in it is repeated here, because two copies of a finding is two things to keep in step.

## What is different here

That note is written for a codebase being rewritten in place. This one has not started, and is going to be rebuilt as an extension of `template-commit-reveal`, which changes what the note is for: not a bug to fix, but a constraint to build against.

Two things to carry across:

**The per-avatar controller is the right bound and the wrong proof.** Authority over one avatar is a genuinely narrower grant than authority over an account, and it is worth keeping. What has to change is where the pair comes from: proven by the owner sending or the owner signing, never asserted by whoever paid. `template-commit-reveal` brings `GameDelegation` and the `Delegation.requireAccountFor` discipline in `GameCommit._accountFor`, so the proof is inherited; the remaining design question is only whether the per-avatar narrowing sits on top of it, through the documented `_requireAccountForSender` seam, or is dropped for account-wide authority.

**The rule, in the form that is easy to apply:** paying for somebody is always safe, speaking for somebody never is. Value flowing to an account needs nobody's permission, because the worst case is a gift, which is why `GameCommit.addToReserve` lets anyone top up anyone. Authority over an account needs all of it. The inherited bug is exactly that permissiveness carried across from the first to the second.

See also `jolly-roger` on its `work` branch for the other half: `docs/adr/0003-payment-on-the-delegation-carrying-contract.md` decides how a purchase, the signer's gas and the authorisation become one approval without reaching for the shortcut above, and records why the tempting alternatives were refused.
