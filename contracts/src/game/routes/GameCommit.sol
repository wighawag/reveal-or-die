// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import "../internal/UsingGameInternal.sol";
import "../interfaces/IGame.sol";
import {Delegation} from "../../core/Delegation.sol";

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
        address player,
        bytes24 commitmentHash,
        uint256 bond,
        address payable payee
    ) external payable {
        _makeCommitment(_accountFor(player), commitmentHash, bond);

        // extra steps for which we do not intend to track via events
        if (payee != address(0) && msg.value != 0) {
            payee.transfer(msg.value);
        }
    }

    /// @inheritdoc IGameCommit
    function cancelCommitment(address player) external {
        _cancelCommitment(_accountFor(player));
    }

    /// @notice Whose move this is, having checked the caller may make it.
    /// @dev The LIBRARY rather than {UsingDelegation}, deliberately. Inheriting
    ///      that contract would bring its seven external functions along, and a
    ///      router maps each selector to exactly one route - they belong to
    ///      {GameDelegation}, so having them here too would be a collision at
    ///      deploy time. The library reads no `msg.sender` of its own, which is
    ///      what makes it usable this way.
    ///
    ///      Reverts with `NotDelegate` when the caller is not authorised, which
    ///      is a better failure than the alternative: without the check a
    ///      stranger could bond someone else's reserve to a commitment only
    ///      they can reveal, and the reserve owner would lose it.
    function _accountFor(address player) internal view returns (address) {
        return Delegation.requireAccountFor(msg.sender, player);
    }
}
