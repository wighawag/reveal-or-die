// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../interfaces/UsingGameTypes.sol";
import "./UsingVirtualTime.sol";

abstract contract UsingGameStore is UsingGameTypes, UsingVirtualTime {
    /// @notice the timestamp (in seconds) at which the game start, it start in the commit phase
    uint256 internal immutable START_TIME;
    /// @notice the duration of the commit phase in seconds
    uint256 internal immutable COMMIT_PHASE_DURATION;
    /// @notice the duration of the reveal phase in seconds
    uint256 internal immutable REVEAL_PHASE_DURATION;
    /// @notice the token players stake in order to place
    IERC20 internal immutable TOKENS;
    /// @notice how much one placement costs
    uint256 internal immutable PLACEMENT_COST;
    /// @notice whether to skip commit phase and let player make their move in the reveal phase (trusted setup)
    bool internal immutable SKIP_COMMIT;

    /// @notice the number of placements a hash represents
    uint8 internal constant MAX_NUM_PLACEMENTS_PER_HASH = 32;

    /// @notice A player is nothing but their address here. There is no avatar,
    ///         no token to own: your identity is your account and what you did.
    ///         Games that want a controllable entity introduce one themselves.
    mapping(address => uint256) internal _reserve;

    mapping(address => Commitment) internal _commitments;

    /// @notice The board. Accumulated, never contested: see _reveal.
    mapping(uint64 => Cell) internal _cells;
    mapping(uint64 => mapping(address => uint256)) internal _stakeOnCellBy;

    /// @notice Which cells of a zone have ever been placed on.
    /// @dev The index that makes reading a viewport cost what the board HOLDS
    ///      instead of a flat 16x16 per zone. Append-only, and safe to be so:
    ///      a cell is claimed by accumulation and nothing ever un-claims it, so
    ///      an entry can never go stale and the list needs no removal. Written
    ///      by _place on a cell's first ever placement; read by _cellsInZones.
    mapping(uint64 => uint64[]) internal _occupiedCellsInZone;

    ManualEpoch internal _manualEpoch;

    /// @notice Create an instance of a game
    /// @param config configuration options for the game
    constructor(Config memory config) UsingVirtualTime(config.time) {
        START_TIME = config.startTime;
        COMMIT_PHASE_DURATION = config.commitPhaseDuration;
        REVEAL_PHASE_DURATION = config.revealPhaseDuration;
        TOKENS = config.tokens;
        PLACEMENT_COST = config.placementCost;
        // TODO allow to specify it separately
        SKIP_COMMIT = COMMIT_PHASE_DURATION == 0 && REVEAL_PHASE_DURATION == 0;
    }
}
