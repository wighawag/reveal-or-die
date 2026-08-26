// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../internal/UsingGameInternal.sol";
import "../interfaces/IGame.sol";

contract GameCommit is IGameCommit, UsingGameInternal {
    constructor(Config memory config) UsingGameInternal(config) {}

    function commit(
        uint256 avatarID,
        bytes24 commitmentHash,
        address payable payee
    ) external payable {
        _makeCommitment(msg.sender, avatarID, commitmentHash);

        if (payee != address(0)) {
            payee.transfer(msg.value);
        }
    }

    function cancelCommit(uint256 avatarID) external {
        _cancelCommitment(msg.sender, avatarID);
    }
}
