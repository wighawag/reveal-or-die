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

    /// @notice How the cycle advances.
    /// @dev DECLARED BY THE DEPLOYMENT, NEVER INFERRED, and that is the whole
    ///  reason this enum exists. It used to be inferred from the two phase
    ///  durations, and one derivation stood for two unrelated things: a game
    ///  with both durations zero was a game whose cycle had to be pushed by
    ///  hand, AND a game that skipped its commit phase entirely (`SKIP_COMMIT`,
    ///  which carried `TODO allow to specify it separately`). So asking for the
    ///  first silently bought the second, and a manual deployment of this game
    ///  had no commit phase at all: `getCycleNumber` answered `commiting: false`
    ///  forever, `_makeCommitment` reverted `InRevealPhase`, and
    ///  `_moveToNextPhase` reverted `CommitPhaseIsSkipped`. A commit-reveal
    ///  game that cannot commit is not a mode, it is a broken configuration
    ///  that nothing refused.
    ///
    ///  `SKIP_COMMIT` IS GONE RATHER THAN FORMALISED, which is the template's
    ///  own answer to this and the one to follow. Splitting it into a flag of
    ///  its own is the obvious fix and the wrong one: it had no consumer here
    ///  either - every environment declared it false, and the only reads were
    ///  the manual-cycle machinery that the derivation had entangled it with -
    ///  so formalising it would have kept a knob nobody turns and given this
    ///  repo a concept its parent deliberately removed. A game that genuinely
    ///  wants a trusted, nothing-hidden setup is asking for a different thing
    ///  from a cycle that is pushed by hand, and should say so then.
    ///
    ///  The VALUES are the framework's, in the framework's order, because they
    ///  cross into the client as a number: `web/src/lib/game/core/cycle.ts`
    ///  indexes `['timed', 'manual', 'hybrid']` with whatever the deployment's
    ///  linked data declares. So the order here is load-bearing in the same way
    ///  the client's array is.
    ///
    ///  The framework's third value, `TimedWithEarlyAdvance`, is deliberately
    ///  NOT declared here. This game has no unanimity on chain to bring a phase
    ///  forward with, and an enum value the contract would have to refuse is
    ///  worse than one it does not offer. Index 2 is reserved for it.
    enum CyclePolicy {
        /// @notice The clock decides, and nothing else can.
        Timed,
        /// @notice There is no clock. The cycle moves when someone pushes it.
        Manual
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
        uint64 lastCycleNumber;
        uint8 life;
    }

    struct AvatarResolved {
        uint256 avatarID;
        bool inGame;
        uint64 position;
        uint64 lastCycleNumber;
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
        /// @notice How the cycle advances. See {CyclePolicy}.
        /// @dev Checked against the two durations at construction, so the
        ///  declaration and the timings can never disagree again.
        CyclePolicy cyclePolicy;
        /// @notice How many rounds an avatar may go without revealing before it
        ///  is killed. It dies in the round after that.
        /// @dev A parameter rather than the literal it used to be, because the
        ///  number is the whole of the only way to die in this game and the
        ///  client has to be able to SAY it. Nothing on chain announces a death
        ///  - there is no event, `life` is computed from how far `lastCycleNumber`
        ///  has fallen behind - so a player is owed an explanation that only
        ///  the client can assemble, and one assembled from a copy of this
        ///  number would drift the moment a game tuned it.
        uint256 numMissesAllowed;
    }

    struct ManualCycle {
        uint64 cycleNumber;
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
        bool inGame; // TODO startCycleNumber could act as InGame
        uint64 position;
        uint64 zoneIndex;
        uint64 startCycleNumber;
        uint64 lastCycleNumber;
        uint8 life;
    }

    struct Zone {
        uint256[] avatars;
    }

    struct Commitment {
        bytes24 hash;
        uint64 cycleNumber;
    }

    // ------------------------------------------------------------------------
}
