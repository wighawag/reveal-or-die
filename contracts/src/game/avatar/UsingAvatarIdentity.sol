// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import "../internal/UsingGameInternal.sol";
import "solidity-kit/solc_0_8/ERC721/interfaces/IERC721.sol";
import {Delegation} from "@etherplay/delegation/contracts/Delegation.sol";

/// @notice WHO PLAYS, and WHAT IS AT STAKE, on a game whose identity is a token.
/// @dev THIS FILE IS THE BRANCH. Everything `with/nft-identity` changes about
///      the contract is two overrides and the custody they read, and rule N4
///      of Decision 3 is why it is shaped this way: a game varies by overriding
///      a virtual internal and NEVER by editing a store, because a store is the
///      file a cascade cannot merge. `UsingGameStore`, `UsingGameInternal`,
///      `IGame`, the events and the routes are byte-identical to `main`'s.
///
///      The two overrides are the two halves of what an identity IS:
///
///      - {_playerOf} says who the caller is acting for. On `main` the
///        identity is the account and the only question is authority; here
///        there is a second question that only this file can answer, which is
///        whether the token is in a state where it can be played at all.
///      - {_forfeit} says what not revealing costs. `main` takes the bond from
///        the reserve; here the reserve is empty and unused (a placement costs
///        nothing on this branch) and the stake is CUSTODY: a player who goes
///        quiet loses the avatar they paid for.
///
///      CUSTODY RATHER THAN OWNERSHIP, and the difference is the whole stake.
///      If the game merely READ `ownerOf`, a player who disliked what they had
///      committed to could sell the avatar inside the reveal window and walk
///      away whole, leaving the buyer to be seized from. That is a costless
///      exit, which is exactly the invariant this template rests on. So the
///      NFT lives in the game while it plays, and comes out only by
///      {_withdrawAvatar}, which refuses while a commitment is open.
abstract contract UsingAvatarIdentity is UsingGameInternal {
    /// @notice This game only accepts its own avatars.
    error OnlyAvatarsAreAccepted(address token);
    /// @notice The deposit payload was not an owner address.
    error InvalidDepositData();
    /// @notice Only the recorded owner may take an avatar back out.
    error NotAvatarOwner(uint256 avatarID, address owner);
    /// @notice The avatar is bound to a commitment that is still open.
    error AvatarIsCommitted(uint256 avatarID, uint64 epoch);

    /// @notice An avatar entered the game, and is at stake from now on.
    event AvatarDeposited(uint256 indexed avatarID, address indexed owner);
    /// @notice An avatar left the game, with nothing owed.
    event AvatarWithdrawn(uint256 indexed avatarID, address indexed owner);
    /// @notice An avatar was lost for never revealing.
    /// @dev Declared here rather than in `UsingGameEvents` for the same reason
    ///      everything else on this branch is: that file exists on `main` and
    ///      an event added to it would be an edit to a shared file. The
    ///      framework's own `CommitmentVoid` still fires alongside this, and
    ///      reports a forfeited bond of zero, which is true.
    event AvatarSeized(uint256 indexed avatarID, address indexed previousOwner);

    /// @notice The avatar NFT this game plays with.
    IERC721 internal immutable AVATARS;

    /// @notice Whose avatar this is, while the game holds it.
    /// @dev Zero means "not playable", and it covers two different histories
    ///      on purpose: an avatar that was never deposited, and one that was
    ///      SEIZED. Neither can commit and neither can be withdrawn, so the
    ///      contract has no reason to tell them apart; the event says which.
    ///
    ///      DECLARED HERE, AFTER every variable `UsingGameStore` declares,
    ///      which is what makes this safe behind the router: every route that
    ///      inherits this contract lays the slot out identically, and a route
    ///      that does not inherit it (the unchanged getters, the delegation
    ///      route) simply never touches it.
    mapping(uint256 avatarID => address owner) internal _avatarOwner;

    /// @notice The avatars an account has in the game, for the client to pick
    ///         one out of.
    /// @dev Append-only, and it may hold ids this account no longer has: a
    ///      withdrawal or a seizure clears the OWNER and leaves the list
    ///      alone, so `getAvatarsOf` is a search space rather than an answer.
    ///      That is deliberate - removal from the middle of an array is the
    ///      kind of bookkeeping that has to stay correct forever, and D6
    ///      (several identities per account) is explicitly not built yet, so
    ///      building the index for it now would be a guess. The reader filters
    ///      by owner, which is one word and cannot go stale.
    mapping(address owner => uint256[] avatarIDs) internal _avatarsOf;

    /// @dev Takes NO config, and that is not an oversight. Every route that
    ///      inherits this also inherits one of `main`'s, which already passes
    ///      the config to {UsingGameInternal}; naming it here as well is
    ///      "base constructor arguments given twice". The one route that has
    ///      no `main` counterpart ({AvatarGameCustody}) passes it itself.
    constructor(IERC721 avatars) {
        AVATARS = avatars;
    }

    //-------------------------------------------------------------------------
    // THE TWO OVERRIDES
    //-------------------------------------------------------------------------

    /// @inheritdoc UsingGameInternal
    /// @dev THE IDENTITY IS THE TOKEN, so there is nothing to widen and
    ///      nothing to truncate: the id the client sent IS the key the round is
    ///      filed under. What has to be established is that this avatar is
    ///      really at stake, and that `sender` may act for whoever put it
    ///      there.
    ///
    ///      An id of zero can never pass, which is worth being deliberate
    ///      about rather than leaving to the mint: on an address game zero
    ///      means "as the caller", so an avatar zero would make one identity
    ///      behave differently from every other one. `AvatarSale` starts at 1
    ///      and this refuses zero anyway, because two independent reasons is
    ///      what a silent aliasing bug is worth.
    function _playerOf(
        address sender,
        uint256 id
    ) internal view virtual override returns (uint256 player) {
        address owner = _avatarOwner[id];
        if (owner == address(0)) {
            revert InvalidPlayer(id);
        }
        // Account-wide authority, exactly as on `main`: a delegate authorised
        // by the owner may play any avatar that owner holds here. It is bound
        // to this contract and this chain, so it is worthless at any other
        // game. Withdrawal deliberately does NOT go through this.
        Delegation.requireAccountFor(sender, owner);
        return id;
    }

    /// @inheritdoc UsingGameInternal
    /// @dev WHAT NOT REVEALING COSTS, and here it is the whole avatar rather
    ///      than a bond. `bond` is always zero on this branch, so nothing is
    ///      returned and `CommitmentVoid` reports a forfeit of zero: the
    ///      framework's only requirement is that SOMETHING is lost, and the
    ///      event that says what is {AvatarSeized}.
    ///
    ///      The NFT stays in this contract forever. Sending it somewhere would
    ///      need a recipient, which is a policy decision (burn it? give it to
    ///      whoever settled? to a treasury?) that this branch has no reason to
    ///      take, and every choice of recipient is a new incentive to reason
    ///      about. Clearing the owner is the whole of the loss.
    function _forfeit(
        uint256 player,
        uint256 bond
    ) internal virtual override returns (uint256 forfeited) {
        address owner = _avatarOwner[player];
        if (owner != address(0)) {
            _avatarOwner[player] = address(0);
            emit AvatarSeized(player, owner);
        }
        // Nothing is settled in tokens. Keeping the bond arithmetic would be
        // worse than useless here: the reserve is always empty, so it would
        // report a loss of zero as though that were the penalty.
        bond;
        return 0;
    }

    //-------------------------------------------------------------------------
    // CUSTODY
    //-------------------------------------------------------------------------

    function _depositAvatar(uint256 avatarID, address owner) internal {
        if (owner == address(0)) {
            revert InvalidDepositData();
        }
        if (avatarID == 0) {
            // Unreachable through `AvatarSale`, which starts at 1. Refused
            // anyway, because an avatar zero would be an identity `_playerOf`
            // can never resolve and therefore a token that is permanently
            // stuck in this contract.
            revert InvalidPlayer(avatarID);
        }
        _avatarOwner[avatarID] = owner;
        _avatarsOf[owner].push(avatarID);
        emit AvatarDeposited(avatarID, owner);
    }

    /// @notice Take an avatar back out, ending its time at stake.
    /// @dev NOT delegable, and it is the only account-facing call here that is
    ///      not - the same line `withdrawFromReserve` draws on `main`. A
    ///      delegate is a key held in one browser so that moves need no
    ///      prompt; letting it take the avatar OUT would hand whatever got
    ///      hold of that key the thing the player paid for.
    ///
    ///      An OPEN commitment blocks it, whatever epoch it belongs to, and
    ///      both cases matter. A commitment in the CURRENT epoch is a turn the
    ///      player has taken and not yet opened, so withdrawing would be
    ///      committing and then walking away, which is the costless exit this
    ///      game exists to prevent. One from a PAST epoch is a missed reveal
    ///      that nobody has settled: the avatar is already forfeit and
    ///      `acknowledgeMissedReveal` is what makes it so, so letting the
    ///      owner rescue it first would make the penalty optional.
    function _withdrawAvatar(uint256 avatarID, address to) internal {
        address owner = _avatarOwner[avatarID];
        if (owner != msg.sender) {
            revert NotAvatarOwner(avatarID, owner);
        }
        Commitment storage commitment = _commitments[avatarID];
        if (commitment.epoch != 0) {
            revert AvatarIsCommitted(avatarID, commitment.epoch);
        }
        _avatarOwner[avatarID] = address(0);
        emit AvatarWithdrawn(avatarID, owner);
        AVATARS.transferFrom(address(this), to, avatarID);
    }
}
