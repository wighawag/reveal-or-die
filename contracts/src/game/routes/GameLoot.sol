// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../internal/UsingGameInternal.sol";
import "../interfaces/IGame.sol";

/// @dev THE BODIES' ROUTE (step R1a of stratagems' plan; reveal-or-die `work`:
///  `stake-in-the-avatar`): settling a collector's share of a body, the reads
///  a client needs to show and settle them, and the one way value comes in,
///  which is the avatars paying a burned body's stake.
contract GameLoot is IGameLoot, UsingGameInternal {
    constructor(Config memory config) UsingGameInternal(config) {}

    /// @inheritdoc IGameLoot
    /// @dev ONLY THE AVATARS, which send value only when the game burns a body
    ///  it holds ({_releaseBody}), naming this function as the call the stake
    ///  arrives with: the game's proxy rejects plain transfers. Anything else
    ///  sent here would be value no rule accounts for.
    function receiveStake() external payable {
        if (msg.sender != address(AVATARS)) {
            revert OnlyAvatarsSendValue();
        }
    }

    /// @inheritdoc IGameLoot
    function settleClaim(uint256 collector, uint256 body) external {
        _settleClaim(collector, body);
    }

    /// @inheritdoc IGameLoot
    function getBody(uint256 body) external view returns (PublicBody memory) {
        return _getBody(body);
    }

    /// @inheritdoc IGameLoot
    function getCarried(uint256 avatarID) external view returns (uint256) {
        return _carried[avatarID];
    }

    /// @inheritdoc IGameLoot
    function getOpenClaims(
        uint256 avatarID,
        uint256 start,
        uint256 limit
    ) external view returns (uint256[] memory bodies, uint256 total) {
        uint256[] storage list = _openClaims[avatarID];
        total = list.length;
        if (start >= total) {
            return (bodies, total);
        }
        uint256 end = start + limit > total ? total : start + limit;
        bodies = new uint256[](end - start);
        for (uint256 i = start; i < end; i++) {
            bodies[i - start] = list[i];
        }
    }

    /// @inheritdoc IGameLoot
    function getClaim(
        uint256 collector,
        uint256 body
    ) external view returns (uint64 cycleNumber) {
        return _claims[collector][body];
    }
}
