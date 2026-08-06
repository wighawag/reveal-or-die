// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "solidity-kit/solc_0_8/debug/time/interfaces/ITime.sol";
import "solidity-kit/solc_0_8/ERC721/interfaces/IERC721.sol";

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
        IERC721 avatars;
    }

    struct ManualEpoch {
        uint64 epoch;
        bool commiting;
    }

    // ------------------------------------------------------------------------

    // ------------------------------------------------------------------------
    // INTERNAL TYPES
    // ------------------------------------------------------------------------

    // ------------------------------------------------------------------------
    // STORAGE TYPES
    // ------------------------------------------------------------------------

    struct Player {
        address owner;
        address controller;
    }

    struct Commitment {
        bytes24 hash;
        uint64 epoch;
    }
    // ------------------------------------------------------------------------
}
