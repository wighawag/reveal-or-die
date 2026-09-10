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

    /// @notice WHO PLAYS, as a number, and never as an address.
    /// @dev A player is a `uint256` here whatever a given game means by one,
    ///      which is the storage half of the rule the client keeps in
    ///      `web/src/lib/game/identity.ts`. THIS game is an address game: its
    ///      identity is the account, widened, and there is no avatar and no
    ///      token to own. Games that key by an entity (an avatar, a character,
    ///      an empire) put its token id in the same slot, and the only thing
    ///      that has to change is {UsingGameInternal-_playerOf}.
    ///
    ///      It is deliberately NOT an `address` that a token game would cast
    ///      into. Twenty bytes holds every account and does not hold every
    ///      token id: reveal-or-die's are `owner << 96 | subID` and conquest's
    ///      are derived the same way, so truncating would alias two players
    ///      onto one reserve with nothing raised anywhere. See N4 of Decision 3
    ///      in the plan on the `work` branch.
    mapping(uint256 => uint256) internal _reserve;

    mapping(uint256 => Commitment) internal _commitments;

    /// @notice The board. Accumulated, never contested: see _reveal.
    mapping(uint64 => Cell) internal _cells;
    mapping(uint64 => mapping(uint256 => uint256)) internal _stakeOnCellBy;

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
