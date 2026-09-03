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
        /// @notice How many rounds an avatar may go without revealing before it
        ///  is killed. It dies in the round after that.
        /// @dev A parameter rather than the literal it used to be, because the
        ///  number is the whole of the only way to die in this game and the
        ///  client has to be able to SAY it. Nothing on chain announces a death
        ///  - there is no event, `life` is computed from how far `lastEpoch`
        ///  has fallen behind - so a player is owed an explanation that only
        ///  the client can assemble, and one assembled from a copy of this
        ///  number would drift the moment a game tuned it.
        uint256 numMissesAllowed;
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

    /// @notice Who an avatar belongs to.
    ///
    /// There is no `controller` here any more. Authority to MOVE an avatar is
    /// not a second address stored per avatar; it is delegation, held by
    /// {GameDelegation} in its own namespaced storage and granted by the owner
    /// signing for it. So authority is per ACCOUNT and covers every avatar that
    /// account owns, rather than being granted one avatar at a time.
    ///
    /// `owner` still means exactly what it did: the only address that can get
    /// the NFT back out. A delegate may play, never withdraw.
    struct Player {
        address owner;
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
