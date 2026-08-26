// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../interfaces/UsingGameTypes.sol";
import "../interfaces/UsingGameErrors.sol";
import "./UsingVirtualTime.sol";

abstract contract UsingGameStore is UsingGameTypes, UsingVirtualTime {
    /// @notice the timestamp (in seconds) at which the game start, it start in the commit phase
    uint256 internal immutable START_TIME;
    /// @notice the duration of the commit phase in seconds
    uint256 internal immutable COMMIT_PHASE_DURATION;
    /// @notice the duration of the reveal phase in seconds
    uint256 internal immutable REVEAL_PHASE_DURATION;
    /// @notice the avatars NFT collection
    IERC721 internal immutable AVATARS;
    /// @notice the max number of actions per turn
    uint256 internal immutable MAX_MOVES;
    /// @notice whether to skip commit phase and let player make their move in the reveal phase (trusted setup)
    bool internal immutable SKIP_COMMIT;

    /// @notice the number of moves a hash represent, after that players make use of furtherMoves
    uint8 internal constant MAX_NUM_MOVES_PER_HASH = 32;

    mapping(uint256 => Player) internal _players;
    mapping(uint256 => Avatar) internal _avatars;

    // allow to get all avatars per owner in the game
    mapping(address owner => uint256[]) internal _ownedAvatars;
    mapping(uint256 avatarID => uint256) internal _ownedAvatarsIndex;

    mapping(uint256 => Commitment) internal _commitments;
    mapping(uint64 => Zone) internal _zones;

    ManualEpoch internal _manualEpoch;

    /// @notice Create an instance of a game
    /// @param config configuration options for the game
    constructor(Config memory config) UsingVirtualTime(config.time) {
        MAX_MOVES = config.numMoves;
        START_TIME = config.startTime;
        COMMIT_PHASE_DURATION = config.commitPhaseDuration;
        REVEAL_PHASE_DURATION = config.revealPhaseDuration;
        AVATARS = config.avatars;
        // TODO allow to specify it separately
        SKIP_COMMIT = COMMIT_PHASE_DURATION == 0 && REVEAL_PHASE_DURATION == 0;
    }
}
