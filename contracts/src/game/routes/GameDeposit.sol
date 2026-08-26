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
        address controller,
        address payable payee
    ) external payable {
        _deposit(avatarID, msg.sender, controller);

        // transfer Character to the game
        AVATARS.transferFrom(msg.sender, address(this), avatarID);

        // extra steps for which we do not intend to track via events
        if (payee != address(0) && msg.value != 0) {
            payee.transfer(msg.value);
        }
    }

    function onERC721Received(
        address, // operator
        address, // from
        uint256 tokenID,
        bytes calldata data
    ) external override returns (bytes4) {
        if (msg.sender != address(AVATARS)) {
            revert OnlyAvatarsAreAccepted();
        }
        if (data.length != 64) {
            revert UsingGameErrors.InvalidData();
        }
        (address owner, address controller) = abi.decode(
            data,
            (address, address)
        );
        _deposit(tokenID, owner, controller);
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
