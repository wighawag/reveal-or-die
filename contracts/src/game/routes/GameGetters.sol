// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../internal/UsingGameInternal.sol";
import "../interfaces/IGame.sol";

contract GameGetters is IGameGetters, UsingGameInternal {
    constructor(Config memory config) UsingGameInternal(config) {}

    function getCycleNumber() external view returns (uint64 cycleNumber, bool commiting) {
        return _cycleNumber();
    }

    function getAvatarsInZone(
        uint64 zone,
        uint64 fromIndex,
        uint64 limit
    )
        external
        view
        returns (PublicAvatar[] memory avatars, bool more, uint64 cycleNumber)
    {
        return _getAvatarsInZone(zone, fromIndex, limit);
    }

    function getAvatarsInMultipleZones(
        uint64[] calldata zones,
        uint64 fromIndex,
        uint64 limit
    )
        external
        view
        returns (PublicAvatar[] memory avatars, bool more, uint64 cycleNumber)
    {
        return _getAvatarsInMultipleZones(zones, fromIndex, limit);
    }

    function getAvatar(
        uint256 avatarID
    ) external view returns (PublicAvatar memory) {
        (uint64 cycleNumber, ) = _cycleNumber();
        return _getPublicAvatar(avatarID, cycleNumber);
    }

    function getCommitment(
        uint256 avatarID
    ) external view returns (Commitment memory commitment) {
        return _commitmentOf(avatarID);
    }

    /// @notice Who the cycle waits for, and how many have acted in the current
    ///  cycle: the base's tally, the numbers `moveToNextPhase` judges by.
    ///  `waitedFor` counts every avatar in custody until it leaves or, dead,
    ///  is released (`releaseDeadAvatar`).
    function getAttendance()
        external
        view
        returns (Attendance memory attendance)
    {
        (uint64 cycleNumber, ) = _cycleNumber();
        return _attendance(cycleNumber);
    }

    function getConfig() external view returns (Config memory config) {
        return
            Config({
                startTime: START_TIME,
                commitPhaseDuration: COMMIT_PHASE_DURATION,
                revealPhaseDuration: REVEAL_PHASE_DURATION,
                avatars: AVATARS,
                time: TIME,
                numMoves: MAX_MOVES,
                cyclePolicy: CYCLE_POLICY,
                numMissesAllowed: NUM_MISSES_ALLOWED,
                actionsPerReveal: ACTIONS_PER_REVEAL
            });
    }
}
