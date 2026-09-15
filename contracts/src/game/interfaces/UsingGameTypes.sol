// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "solidity-kit/solc_0_8/debug/time/interfaces/ITime.sol";
import "solidity-kit/solc_0_8/ERC20/interfaces/IERC20.sol";

interface UsingGameTypes {
    // ------------------------------------------------------------------------
    // EXTERNAL TYPES
    // ------------------------------------------------------------------------

    /// @notice HOW THE ROUND ADVANCES. One of three, chosen by the deployment.
    /// @dev It used to be derived rather than declared: a game whose two phase
    ///      durations were both zero was a manual game, AND was a game that
    ///      skipped the commit phase, because one flag stood for both. Two
    ///      independent things behind one derivation is what made this look
    ///      like a mode instead of a policy, so the policy is now said out loud
    ///      and the commit phase is never skipped by anybody.
    ///
    ///      `Timed` needs no transaction at all: the epoch simply is what the
    ///      clock says. The other two are advanced by {IGameReveal-advanceRound},
    ///      which is permissionless and strictly conditional - it may only do
    ///      what the rules already permit, so letting anyone call it grants
    ///      nothing.
    enum EpochPolicy {
        /// @notice The clock decides, and nothing else can.
        Timed,
        /// @notice There is no clock. The round moves when the players have all
        ///         acted and someone pushes it.
        Manual,
        /// @notice The clock decides the DEADLINE, and unanimity can bring the
        ///         next phase forward. Never the other way round: see
        ///         {UsingGameInternal-_advanceRound}.
        TimedWithEarlyAdvance
    }

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
        /// @notice how the round advances
        EpochPolicy epochPolicy;
    }

    /// @notice WHERE THE ROUND IS, and until when.
    /// @dev The client reads this rather than computing it, because under
    ///      {EpochPolicy-TimedWithEarlyAdvance} the arithmetic alone cannot
    ///      know that a phase was brought forward - that takes a transaction.
    ///      A local clock predicts this correctly right up until someone
    ///      advances early, which is exactly why the prediction is a floor and
    ///      this is the answer.
    struct Round {
        uint64 epoch;
        /// @notice true in the commit phase, false in the reveal phase
        bool commiting;
        /// @notice chain time the current phase opened
        /// @dev ZERO MEANS THERE IS NO CLOCK (a Manual game), not "the epoch".
        uint64 phaseStart;
        /// @notice chain time the current phase closes, if nobody advances it
        /// @dev Zero means there is no clock. Under an early advance this is
        ///      the phase's NOMINAL end, unmoved: an advance widens a window
        ///      and never shortens one, which is what keeps a reveal scheduled
        ///      against the nominal time valid.
        uint64 phaseEnd;
    }

    /// @notice WHO THE EPOCH IS WAITING FOR, and how many have acted.
    /// @dev `waitedFor` is the denominator unanimity is measured against, and
    ///      it is deliberately NOT the number of players who are alive: a game
    ///      may keep a silent player in the world while no longer blocking on
    ///      them. What it costs to stop being waited for is the game's, and it
    ///      is a separate question from this count.
    struct Attendance {
        uint64 waitedFor;
        /// @notice how many of them have committed IN THE CURRENT EPOCH
        uint64 committed;
        /// @notice how many of those commitments have been revealed
        uint64 revealed;
    }

    /// @notice What an advance has written down, if anything.
    /// @dev STORAGE ONLY. Read {Round} instead; this is the raw anchor it is
    ///      computed from, and every field means something different per
    ///      policy, which is why it is not the thing anyone else reads.
    struct EpochState {
        /// @notice the epoch the anchor names; zero means nothing has advanced
        ///         yet, so the anchor is (epoch 2, START_TIME, commit phase)
        uint64 anchorEpoch;
        /// @notice chain time the anchor epoch's COMMIT phase opened (timed
        ///         policies only)
        uint64 anchoredAt;
        /// @notice the epoch whose reveal phase was opened early, if any
        uint64 earlyRevealEpoch;
        /// @notice when that happened, which is when that reveal window opened
        uint64 earlyRevealAt;
        /// @notice which phase the anchor epoch is in (Manual only; the timed
        ///         policies read it off the clock)
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

    /// @notice How many members have acted, in the epoch it names.
    /// @dev The epoch is stored WITH the counts so that one slot can serve
    ///      every epoch: a tally whose epoch is not the current one is a tally
    ///      of zero, and the first player to act in a new epoch resets it.
    struct EpochTally {
        uint64 epoch;
        uint64 committed;
        uint64 revealed;
    }

    struct Commitment {
        bytes24 hash;
        uint64 epoch;
        /// @notice reserve earmarked when the commitment was made, forfeited if
        ///         the player never reveals
        uint256 bond;
    }
    // ------------------------------------------------------------------------
}
