// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import "../internal/UsingGameInternal.sol";
import "../interfaces/IGame.sol";

contract GameCommit is IGameCommit, UsingGameInternal {
    constructor(Config memory config) UsingGameInternal(config) {}

    /// @inheritdoc IGameCommit
    function addToReserve(address player, uint256 amount) external {
        if (amount > 0) {
            // Paid by msg.sender, CREDITED to `player`. These are deliberately
            // allowed to differ: a player's moves are signed by a local key that
            // never holds funds, while the stake is paid from the wallet that
            // does. Without this split the wallet would have to sign every commit
            // and reveal, and an email/social account (which has no wallet at
            // all) could not play.
            //
            // Safe to leave open: topping up someone else's reserve is a gift,
            // and the reserve can only ever be withdrawn by its owner.
            _addToReserve(player, amount);
            TOKENS.transferFrom(msg.sender, address(this), amount);
        }
    }

    /// @inheritdoc IGameCommit
    function withdrawFromReserve(uint256 amount) external {
        if (amount > 0) {
            _withdrawFromReserve(msg.sender, amount);
            TOKENS.transfer(msg.sender, amount);
        }
    }

    /// @inheritdoc IGameCommit
    function makeCommitment(
        bytes24 commitmentHash,
        uint256 bond,
        address payable payee
    ) external payable {
        _makeCommitment(msg.sender, commitmentHash, bond);

        // extra steps for which we do not intend to track via events
        if (payee != address(0) && msg.value != 0) {
            payee.transfer(msg.value);
        }
    }

    /// @inheritdoc IGameCommit
    function cancelCommitment() external {
        _cancelCommitment(msg.sender);
    }
}
