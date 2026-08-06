// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import "../internal/UsingGameInternal.sol";
import "../interfaces/IGame.sol";

contract GameReveal is IGameReveal, UsingGameInternal {
    constructor(Config memory config) UsingGameInternal(config) {}

    /// @inheritdoc IGameReveal
    function reveal(
        address player,
        Placement[] calldata placements,
        bytes32 secret,
        address payable payee
    ) external payable {
        _reveal(player, placements, secret);

        // extra steps for which we do not intend to track via events
        if (payee != address(0) && msg.value != 0) {
            payee.transfer(msg.value);
        }
    }

    /// @inheritdoc IGameReveal
    function acknowledgeMissedReveal(address player) external {
        _acknowledgeMissedReveal(player);
    }

    /// @inheritdoc IGameReveal
    function moveToNextEpoch() external returns (ManualEpoch memory) {
        return _moveToNextEpoch();
    }

    /// @inheritdoc IGameReveal
    function moveToNextPhase() external returns (ManualEpoch memory) {
        return _moveToNextPhase();
    }
}
