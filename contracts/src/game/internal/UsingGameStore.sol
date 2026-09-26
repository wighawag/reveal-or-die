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
    /// @notice how the cycle advances: on the clock, or only when pushed
    CyclePolicy internal immutable CYCLE_POLICY;
    /// @notice how many rounds an avatar may go without revealing before it dies
    uint256 internal immutable NUM_MISSES_ALLOWED;

    /// @notice the number of moves a hash represent, after that players make use of furtherMoves
    uint8 internal constant MAX_NUM_MOVES_PER_HASH = 32;

    mapping(uint256 => Player) internal _players;
    mapping(uint256 => Avatar) internal _avatars;

    // allow to get all avatars per owner in the game
    mapping(address owner => uint256[]) internal _ownedAvatars;
    mapping(uint256 avatarID => uint256) internal _ownedAvatarsIndex;

    mapping(uint256 => Commitment) internal _commitments;
    mapping(uint64 => Zone) internal _zones;

    ManualCycle internal _manualCycle;

    /// @notice the avatars a MANUAL cycle waits for: see `_startWaitingFor`
    uint256[] internal _waitedFor;
    /// @notice index in `_waitedFor` plus one, so zero means "not a member"
    mapping(uint256 avatarID => uint256) internal _waitedForIndexPlusOne;
    /// @notice the most avatars a manual game waits for. Unanimity is counted
    ///  by looping over them on every advance and every read, so the loop has
    ///  to be bounded; a quick game's table is at most ten seats.
    uint256 internal constant MAX_WAITED_FOR = 16;

    /// @notice Create an instance of a game
    /// @param config configuration options for the game
    constructor(Config memory config) UsingVirtualTime(config.time) {
        MAX_MOVES = config.numMoves;
        START_TIME = config.startTime;
        COMMIT_PHASE_DURATION = config.commitPhaseDuration;
        REVEAL_PHASE_DURATION = config.revealPhaseDuration;
        AVATARS = config.avatars;
        NUM_MISSES_ALLOWED = config.numMissesAllowed;
        // DECLARED, NOT DERIVED, and `SKIP_COMMIT` is GONE rather than split
        // out beside it. The pair used to be one expression
        // (`COMMIT_PHASE_DURATION == 0 && REVEAL_PHASE_DURATION == 0`, with
        // `TODO allow to specify it separately` beside it), so asking for a
        // manual cycle silently asked for a game with no commit phase. Giving
        // it a flag of its own is the obvious fix and the wrong one: it had no
        // consumer. See {UsingGameTypes-CyclePolicy}.
        CYCLE_POLICY = config.cyclePolicy;

        // AND THE DECLARATION CAN NEVER DRIFT FROM THE TIMINGS. A manual cycle
        // has no clock, so durations would be read by nothing and would sit in
        // the deployment's linked data describing a schedule the chain does not
        // run; a timed cycle with no durations divides by a zero cycle length.
        // Both are configurations that used to be accepted and then behaved as
        // something else, which is exactly what made this look like a mode
        // rather than a policy.
        bool noClock =
            config.commitPhaseDuration == 0 && config.revealPhaseDuration == 0;
        if ((config.cyclePolicy == CyclePolicy.Manual) != noClock) {
            revert UsingGameErrors.CycleConfigurationMismatch(
                config.cyclePolicy
            );
        }
    }
}
