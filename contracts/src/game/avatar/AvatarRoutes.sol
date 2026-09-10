// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import "./UsingAvatarIdentity.sol";
import "../routes/GameCommit.sol";
import "../routes/GameReveal.sol";
import "solidity-kit/solc_0_8/ERC721/interfaces/IERC721Receiver.sol";

// THE ROUTES THIS BRANCH DEPLOYS IN PLACE OF TWO OF `main`'S, plus one that is
// new. Each of the first two is `main`'s route plus `UsingAvatarIdentity` and
// nothing else: the bodies are inherited unchanged, and what differs is which
// `_playerOf` and which `_forfeit` they resolve to. That is the whole of N4.
//
// THE BASE ORDER IS LOAD-BEARING. `UsingAvatarIdentity` is listed first so that
// the storage it declares is laid out immediately after `UsingGameStore`'s,
// identically in every route that inherits it. A route that does NOT inherit it
// (the unchanged getters, the delegation route) shares the prefix and never
// touches the extra slots.
//
// These are `//` comments rather than natspec on purpose. The router MERGES the
// documentation of every route into one artifact and refuses two different
// contract-level `@notice` strings, so a second documented route fails the
// DEPLOY with "UserDoc notice conflict" and no mention of which two. Function
// and event natspec merges fine; only the contract-level notice collides.
contract AvatarGameCommit is UsingAvatarIdentity, GameCommit {
    constructor(
        Config memory config,
        IERC721 avatars
    ) UsingAvatarIdentity(avatars) GameCommit(config) {}

    // THE PRICE OF NOT EDITING A SHARED FILE, and it is four lines a route.
    //
    // `main`'s route and {UsingAvatarIdentity} both descend from
    // {UsingGameInternal}, so a leaf that inherits both sees two definitions of
    // each seam and Solidity requires it to say which one wins. It is spelled
    // out rather than left to `super`, whose answer depends on the ORDER of the
    // base list and would therefore change silently if someone tidied it.
    //
    // The alternative was to copy `GameCommit`'s entry points into a contract
    // that inherits only this one - which is duplicating shared code to avoid
    // an override, and duplication is the thing this whole branch is arranged
    // not to do.
    function _playerOf(
        address sender,
        uint256 id
    )
        internal
        view
        override(UsingGameInternal, UsingAvatarIdentity)
        returns (uint256)
    {
        return UsingAvatarIdentity._playerOf(sender, id);
    }

    function _forfeit(
        uint256 player,
        uint256 bond
    )
        internal
        override(UsingGameInternal, UsingAvatarIdentity)
        returns (uint256)
    {
        return UsingAvatarIdentity._forfeit(player, bond);
    }
}

contract AvatarGameReveal is UsingAvatarIdentity, GameReveal {
    constructor(
        Config memory config,
        IERC721 avatars
    ) UsingAvatarIdentity(avatars) GameReveal(config) {}

    /// @dev See {AvatarGameCommit} for why these two blocks exist.
    function _playerOf(
        address sender,
        uint256 id
    )
        internal
        view
        override(UsingGameInternal, UsingAvatarIdentity)
        returns (uint256)
    {
        return UsingAvatarIdentity._playerOf(sender, id);
    }

    function _forfeit(
        uint256 player,
        uint256 bond
    )
        internal
        override(UsingGameInternal, UsingAvatarIdentity)
        returns (uint256)
    {
        return UsingAvatarIdentity._forfeit(player, bond);
    }
}

// GETTING AN AVATAR IN AND OUT, AND FINDING ONE TO PLAY.
//
// A route of its own rather than an addition to an existing one, because a
// router maps one selector to exactly one route: these selectors exist nowhere
// on `main`, so this route can never collide with one and is a pure ADD in
// N1's sense.
contract AvatarGameCustody is UsingAvatarIdentity, IERC721Receiver {
    constructor(
        Config memory config,
        IERC721 avatars
    ) UsingGameInternal(config) UsingAvatarIdentity(avatars) {}

    /// @notice Accept an avatar into the game, and record whose it is.
    /// @dev TWO WAYS IN, AND ONLY ONE OF THEM PROVES ITS OWN CONSENT.
    ///
    ///      A TRANSFER (`from != 0`) proves it: the sender held the NFT and
    ///      gave it up, so `from` IS the owner and the payload is ignored
    ///      entirely. Trusting a payload here instead would let anyone name a
    ///      victim as the owner of an avatar they control.
    ///
    ///      A MINT (`from == 0`) proves nothing on its own, and it exists for
    ///      the one-transaction entry: `GameAvatarSale` mints straight into this
    ///      contract with the buyer in `data`, so buying, staking and funding
    ///      the play key are one confirmation. It is exactly as trustworthy as
    ///      the minter, which is why `GameAvatars.mint` is restricted to one
    ///      address and why that address is a sale that charges. reveal-or-die
    ///      shipped this same path with an open mint, and that is the hole
    ///      this branch inherits the RULE from.
    function onERC721Received(
        address, // operator
        address from,
        uint256 avatarID,
        bytes calldata data
    ) external override returns (bytes4) {
        if (msg.sender != address(AVATARS)) {
            revert OnlyAvatarsAreAccepted(msg.sender);
        }
        if (from != address(0)) {
            _depositAvatar(avatarID, from);
        } else {
            if (data.length != 32) {
                revert InvalidDepositData();
            }
            _depositAvatar(avatarID, abi.decode(data, (address)));
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @notice Take an avatar out of the game. Nothing is owed, or it refuses.
    function withdrawAvatar(uint256 avatarID, address to) external {
        _withdrawAvatar(avatarID, to);
    }

    /// @notice Whose avatar this is while the game holds it, or zero.
    /// @dev Zero for an avatar that was never deposited AND for one that was
    ///      seized: the contract has no reason to tell those apart, and the
    ///      client shows the same thing either way (you have nothing to play).
    function getAvatarOwner(
        uint256 avatarID
    ) external view returns (address owner) {
        return _avatarOwner[avatarID];
    }

    /// @notice Every avatar this account has ever put in, still owned or not.
    /// @dev A SEARCH SPACE, not an answer: see the note on `_avatarsOf`. The
    ///      client asks `getAvatarOwner` about the ones it cares about, which
    ///      is one word that cannot go stale, rather than this contract
    ///      maintaining a removable index for a feature (D6, several
    ///      identities per account) that is deliberately not built yet.
    function getAvatarsOf(
        address owner
    ) external view returns (uint256[] memory avatarIDs) {
        return _avatarsOf[owner];
    }
}
