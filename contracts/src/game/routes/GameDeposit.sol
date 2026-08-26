// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../internal/UsingGameInternal.sol";
import "../interfaces/IGame.sol";
import "solidity-kit/solc_0_8/ERC721/interfaces/IERC721Receiver.sol";

contract GameDeposit is IGameDeposit, UsingGameInternal, IERC721Receiver {
    constructor(Config memory config) UsingGameInternal(config) {}

    // TODO deposit via permit
    function deposit(
        uint256 avatarID,
        address payable payee
    ) external payable {
        // The depositor is the owner. No `controller` argument any more: who
        // may PLAY this avatar is decided by delegation (GameDelegation),
        // account-wide and granted by the owner's own signature, rather than
        // named here one avatar at a time.
        _deposit(avatarID, msg.sender);

        // transfer Character to the game
        AVATARS.transferFrom(msg.sender, address(this), avatarID);

        // extra steps for which we do not intend to track via events
        if (payee != address(0) && msg.value != 0) {
            payee.transfer(msg.value);
        }
    }

    /// @notice Accept an avatar sent straight into the game, and record who
    ///         owns it.
    ///
    /// Two ways in, and only one of them can be proved.
    ///
    /// A TRANSFER (`from != 0`) proves its own consent: the sender held the
    /// NFT and gave it up, so `from` IS the owner and the payload is ignored
    /// entirely. This used to trust a `(owner, controller)` payload here too,
    /// which let anyone name a victim as owner.
    ///
    /// A MINT (`from == 0`) proves nothing. It exists for the one-transaction
    /// entry (buy, deposit and fund the signer in a single confirmation), where
    /// `AvatarsSale` mints straight to this contract and puts the buyer in
    /// `data`. That is only as trustworthy as the minter, and right now it is
    /// not trustworthy at all: `Avatars.mint` has NO ACCESS CONTROL, so anyone
    /// can mint an avatar to this contract naming anyone as owner.
    ///
    /// Delegation does NOT close that: it decides who may act for an account,
    /// not who the account is. Closing it means restricting who may mint, which
    /// is the open decision recorded in Avatars.sol and in
    /// docs/plans/identity-without-consent.md. Until then the mint path is
    /// accepted on the minter's word.
    ///
    /// It is a smaller hole than it was: an attacker can still create an avatar
    /// attributed to a victim, but can no longer take one the victim already
    /// owns, and cannot make themselves able to play it, because playing needs
    /// a delegation the victim would have had to sign.
    function onERC721Received(
        address, // operator
        address from,
        uint256 tokenID,
        bytes calldata data
    ) external override returns (bytes4) {
        if (msg.sender != address(AVATARS)) {
            revert OnlyAvatarsAreAccepted();
        }

        if (from != address(0)) {
            _deposit(tokenID, from);
            return IERC721Receiver.onERC721Received.selector;
        }

        if (data.length != 32) {
            revert UsingGameErrors.InvalidData();
        }
        address owner = abi.decode(data, (address));
        _deposit(tokenID, owner);
        return IERC721Receiver.onERC721Received.selector;
    }

    function withdraw(uint256 avatarID, address to) external {
        _withdraw(msg.sender, avatarID, to);
    }

    function avatarsPerOwner(
        address owner,
        uint256 startIndex,
        uint256 limit
    ) external view returns (PublicAvatar[] memory avatarIDs, bool more) {
        (uint64 epoch, ) = _epoch();
        uint256 total = _ownedAvatars[owner].length;
        if (startIndex >= total) {
            return (new PublicAvatar[](0), false);
        }
        uint256 max = total - startIndex;
        uint256 actualLimit = limit > max ? max : limit;

        PublicAvatar[] memory list = new PublicAvatar[](actualLimit);

        for (uint256 i = 0; i < actualLimit; i++) {
            uint256 avatarID = _ownedAvatars[owner][startIndex + i];
            list[i] = _getPublicAvatar(avatarID, epoch);
        }

        return (list, actualLimit != limit);
    }
}
