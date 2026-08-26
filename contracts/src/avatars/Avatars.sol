// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "solidity-kit/solc_0_8/ERC721/implementations/EnumerableERC721.sol";

contract Avatars is EnumerableERC721 {
    constructor() {}

    /// @notice Mint an avatar.
    ///
    /// KNOWN AND UNRESOLVED: this has NO ACCESS CONTROL. It is `external`, and
    /// `BasicERC721._safeMint` only rejects a tokenID that already EXISTS, so
    /// anyone can mint any unminted id to any address, for free, without ever
    /// going near `AvatarsSale`. Two consequences, and the second is the one
    /// that matters:
    ///
    ///  1. the sale is bypassable, so its price is advisory;
    ///  2. this NFT is meant to be the thing AT STAKE in the commit-reveal
    ///     round. A stake that costs nothing to acquire is not a stake, and
    ///     "something must be at stake, or nobody has to reveal" is the
    ///     framework invariant this game is built on (see AGENTS.md).
    ///
    /// Note also that the tokenID scheme is `(uint160(owner) << 96) + subID`
    /// (`AvatarsSale.sol`), so an attacker can mint themselves unlimited
    /// well-formed avatars rather than only odd-looking ones.
    ///
    /// Left in place deliberately for now. Fixing it means deciding who is
    /// allowed to mint (the sale only? a minter role? the game?), which is a
    /// design decision rather than a missing modifier. Do not deploy this to a
    /// network where the stake is supposed to mean anything until it is made.
    ///
    /// See also docs/plans/identity-without-consent.md, which composes THIS
    /// function with `GameDeposit.onERC721Received` into a second, worse
    /// problem: minting straight to the Game with a forged `(owner,
    /// controller)` payload registers a victim as the actor for an attacker's
    /// moves.
    function mint(
        address to,
        uint256 tokenID,
        bytes calldata data
    ) external payable {
        _safeMint(to, tokenID, false, data);
    }
}
