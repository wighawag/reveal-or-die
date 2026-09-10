// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import "solidity-kit/solc_0_8/ERC721/implementations/EnumerableERC721.sol";

/// @notice The token a player IS on this branch.
/// @dev `main` is deliberately an address game: your identity is your account
///      and what you did. Four of the five games this template exists for
///      identify a player by a token they own instead (`avatarID`,
///      `characterID`, `empireID`), and this branch is where that shape is
///      proven. See D2 and N1 to N6 of Decision 3 in the plan on the `work`
///      branch.
///
///      A STAKE THAT COSTS NOTHING TO ACQUIRE IS NOT A STAKE. That is the
///      invariant the whole framework rests on - "something must be at stake,
///      or nobody has to reveal" - and it is the reason this contract has an
///      access control at all. Minting is restricted to ONE address, the sale;
///      what paying MEANS lives there rather than here. reveal-or-die shipped
///      this NFT with an open `mint` for months, so a player who disliked what
///      they had committed to could go quiet, lose the avatar and mint another
///      for gas: the mechanism was in place and the door was open. Fixed there
///      on 2026-09-09, and the RULE is what this branch inherits, because
///      contracts are not inherited between repos.
///
///      Zero means NOBODY CAN MINT, which is the right default: a deployment
///      that forgets to wire the sale mints nothing rather than minting for
///      free, and the failure is loud and immediate instead of silent and
///      expensive.
contract GameAvatars is EnumerableERC721 {
    error NotMinter(address sender, address minter);
    error NotMinterAdmin(address sender, address minterAdmin);

    event MinterSet(address indexed previousMinter, address indexed newMinter);

    /// @notice Who may change {minter}. Immutable, set at construction.
    address public immutable MINTER_ADMIN;

    /// @notice The only address allowed to {mint}. Zero until it is set.
    address public minter;

    constructor(address minterAdmin) {
        MINTER_ADMIN = minterAdmin;
    }

    /// @notice Point the mint at a sale contract.
    /// @dev Re-settable rather than one-shot, so that charging in something
    ///      else later is a new sale plus one call rather than a redeployment
    ///      and a migration of every avatar in existence. It costs no trust
    ///      that is not already spent, since the admin could always deploy a
    ///      sale that gives them away.
    function setMinter(address newMinter) external {
        if (msg.sender != MINTER_ADMIN) {
            revert NotMinterAdmin(msg.sender, MINTER_ADMIN);
        }
        emit MinterSet(minter, newMinter);
        minter = newMinter;
    }

    /// @notice Mint an avatar. Only the {minter} may call it.
    /// @dev Not `payable`: this contract has no way to withdraw, so a value
    ///      sent here would be locked forever. The sale takes the payment.
    function mint(address to, uint256 tokenID, bytes calldata data) external {
        if (msg.sender != minter) {
            revert NotMinter(msg.sender, minter);
        }
        _safeMint(to, tokenID, false, data);
    }
}
