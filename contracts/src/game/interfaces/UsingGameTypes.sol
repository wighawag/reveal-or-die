// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "solidity-kit/solc_0_8/debug/time/interfaces/ITime.sol";
import "solidity-kit/solc_0_8/ERC721/interfaces/IERC721.sol";

interface UsingGameTypes {
    // ------------------------------------------------------------------------
    // EXTERNAL TYPES
    // ------------------------------------------------------------------------

    /// @notice The set of possible action
    enum ActionType {
        Enter,
        Move,
        Exit
    }

    /// @notice Move struct that define the action, type and position
    struct Action {
        ActionType actionType;
        uint128 data;
    }

    struct PublicAvatar {
        address owner;
        uint256 avatarID;
        bool inGame;
        uint64 position;
        uint64 lastEpoch;
        uint8 life;
    }

    struct AvatarResolved {
        uint256 avatarID;
        bool inGame;
        uint64 position;
        uint64 lastEpoch;
        uint8 life;
    }

    /// @notice Config struct to configure the game instance
    struct Config {
        uint256 startTime;
        uint256 commitPhaseDuration;
        uint256 revealPhaseDuration;
        ITime time;
        IERC721 avatars;
        uint256 numMoves;
    }

    struct ManualEpoch {
        uint64 epoch;
        bool commiting;
    }

    // ------------------------------------------------------------------------

    // ------------------------------------------------------------------------
    // INTERNAL TYPES
    // ------------------------------------------------------------------------

    struct Area {
        uint256 firstBytes32;
        uint256 secondBytes32;
    }

    // ------------------------------------------------------------------------
    // STORAGE TYPES
    // ------------------------------------------------------------------------

    struct Player {
        address owner;
        address controller;
    }

    struct Avatar {
        bool inGame; // TODO startEpoch could act as InGame
        uint64 position;
        uint64 zoneIndex;
        uint64 startEpoch;
        uint64 lastEpoch;
        uint8 life;
    }

    struct Zone {
        uint256[] avatars;
    }

    struct Commitment {
        bytes24 hash;
        uint64 epoch;
    }

    // ------------------------------------------------------------------------
}
