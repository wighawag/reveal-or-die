// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../internal/UsingGameInternal.sol";
import "../interfaces/IGame.sol";

contract GameReveal is IGameReveal, UsingGameInternal {
    constructor(Config memory config) UsingGameInternal(config) {}

    function reveal(
        uint256 avatarID,
        Action[] calldata actions,
        bytes32 secret,
        address payable payee
    ) external payable {
        _reveal(avatarID, actions, secret);

        if (payee != address(0)) {
            payee.transfer(msg.value);
        }
    }

    /// @dev The base's advance, ONE PHASE AT A TIME and under the name this
    ///  game has always given it. Its own transaction, never a rider on the
    ///  last reveal.
    function moveToNextPhase()
        external
        returns (uint64 cycleNumber, bool commiting)
    {
        return _advanceCycle();
    }

    function acknowledgeMissedReveal(
        uint256 avatarID,
        Action[] calldata actions,
        bytes32 secret
    ) external {
        _acknowledgeMissedReveal(avatarID, actions, secret);
    }

    function forfeitMissedReveal(uint256 avatarID) external {
        _forfeitMissedReveal(msg.sender, avatarID);
    }

    function releaseDeadAvatar(uint256 avatarID) external {
        _releaseDeadAvatar(avatarID);
    }
}
