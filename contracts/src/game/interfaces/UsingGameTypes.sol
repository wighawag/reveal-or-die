// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "solidity-kit/solc_0_8/debug/time/interfaces/ITime.sol";
import "solidity-kit/solc_0_8/ERC20/interfaces/IERC20.sol";

interface UsingGameTypes {
    // ------------------------------------------------------------------------
    // EXTERNAL TYPES
    // ------------------------------------------------------------------------

    /// @notice Config struct to configure the game instance
    struct Config {
        uint256 startTime;
        uint256 commitPhaseDuration;
        uint256 revealPhaseDuration;
        ITime time;
        /// @notice the token players stake to place
        IERC20 tokens;
        /// @notice how much one placement costs, taken from the player's reserve
        uint256 placementCost;
    }

    struct ManualEpoch {
        uint64 epoch;
        bool commiting;
    }

    /// @notice One placement, as revealed by the player.
    /// @dev The board accumulates these. It never compares one player's
    ///      placement against another's, because that would make the outcome
    ///      depend on the order reveals arrive in. See _reveal.
    struct Placement {
        uint64 cellID;
    }

    /// @notice A cell's public state.
    struct Cell {
        /// @notice total stake placed here by everyone
        uint256 totalStake;
        /// @notice how many distinct players have placed here
        uint32 numClaimants;
    }

    /// @notice A cell plus its id, for range queries.
    struct CellAt {
        uint64 cellID;
        uint256 totalStake;
        uint32 numClaimants;
    }

    // ------------------------------------------------------------------------
    // STORAGE TYPES
    // ------------------------------------------------------------------------

    struct Commitment {
        bytes24 hash;
        uint64 epoch;
        /// @notice reserve earmarked when the commitment was made, forfeited if
        ///         the player never reveals
        uint256 bond;
    }
    // ------------------------------------------------------------------------
}
