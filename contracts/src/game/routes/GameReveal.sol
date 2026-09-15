// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import "../internal/UsingGameInternal.sol";
import "../interfaces/IGame.sol";

contract GameReveal is IGameReveal, UsingGameInternal {
    constructor(Config memory config) UsingGameInternal(config) {}

    /// @inheritdoc IGameReveal
    function reveal(
        uint256 player,
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
    function acknowledgeMissedReveal(uint256 player) external {
        _acknowledgeMissedReveal(player);
    }

    /// @inheritdoc IGameReveal
    /// @dev Its own entry point, deliberately, and it is the reason `reveal`
    ///      above is unchanged by this whole axis: a reveal never advances
    ///      anything, whoever sends it and whenever it lands.
    function advanceRound() external returns (uint64 epoch, bool commiting) {
        return _advanceRound();
    }
}
