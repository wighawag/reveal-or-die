// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../internal/UsingGameInternal.sol";
import "../interfaces/IGame.sol";

contract GameReveal is IGameReveal, UsingGameInternal {
    constructor(Config memory config) UsingGameInternal(config) {}

    function reveal(
        uint256 avatarID,
        bytes calldata actions,
        bytes32 secret,
        address payable payee
    ) external payable {
        _reveal(avatarID, actions, secret);

        if (payee != address(0)) {
            payee.transfer(msg.value);
        }
    }

    function moveToNextEpoch() external returns (ManualEpoch memory) {
        return _moveToNextEpoch();
    }

    function moveToNextPhase() external returns (ManualEpoch memory) {
        return _moveToNextPhase();
    }

    function acknowledgeMissedReveal(uint256 avatarID) external {
        _acknowledgeMissedReveal(avatarID);
    }
}
