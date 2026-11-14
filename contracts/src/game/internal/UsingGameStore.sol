// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../interfaces/UsingGameTypes.sol";
import "../interfaces/UsingGameErrors.sol";
import {UsingCommitReveal} from "../../commit-reveal/UsingCommitReveal.sol";

/// @dev THIS GAME'S STATE, ON THE COMMIT-REVEAL BASE. The clock (start time,
///  phase durations, time source, cycle policy), the commitments, the manual
///  cycle and who the cycle waits for are {UsingCommitReveal}'s, in its own
///  namespaced storage; what is declared here is what an avatar is and where it
///  stands.
abstract contract UsingGameStore is UsingGameTypes, UsingCommitReveal {
    /// @notice the avatars NFT collection
    IERC721 internal immutable AVATARS;
    /// @notice the max number of moves per turn
    uint256 internal immutable MAX_MOVES;
    /// @notice how many rounds an avatar may go without revealing before it dies
    uint256 internal immutable NUM_MISSES_ALLOWED;

    /// @notice How many actions besides its moves the longest turn that can
    ///  resolve carries: an Exit (an Enter stops processing on its own, so it
    ///  never shares a turn with a move).
    /// @dev The floor `actionsPerReveal` is checked against. A game that adds an
    ///  action to a turn raises it.
    /// @notice How many bodies one turn may name (step R1a): the one bound on
    ///  the loops a collect costs.
    uint256 internal constant MAX_COLLECTS = 3;

    /// @notice Besides its moves, the longest turn carries its collects and an
    ///  exit.
    uint256 internal constant ACTIONS_BESIDES_MOVES = 1 + MAX_COLLECTS;

    mapping(uint256 => Player) internal _players;
    mapping(uint256 => Avatar) internal _avatars;

    // allow to get all avatars per owner in the game
    mapping(address owner => uint256[]) internal _ownedAvatars;
    mapping(uint256 avatarID => uint256) internal _ownedAvatarsIndex;

    mapping(uint64 => Zone) internal _zones;

    // ------------------------------------------------------------------------
    // THE BODIES (step R1a). Appended, so the layout above is unchanged.
    // ------------------------------------------------------------------------

    mapping(uint256 body => Body) internal _bodies;
    /// @notice the cycle `collector` collected `body` in, zero once settled
    mapping(uint256 collector => mapping(uint256 body => uint64 cycleNumber))
        internal _claims;
    /// @notice the bodies an avatar has an open claim on, in no order: what a
    ///  client reads to settle them, and what holds a body's release while it
    ///  is not empty
    mapping(uint256 avatarID => uint256[]) internal _openClaims;
    /// @notice where a body is in its collector's `_openClaims`, plus one
    mapping(uint256 avatarID => mapping(uint256 body => uint256))
        internal _openClaimIndex;
    /// @notice what an avatar collected and the game holds for it, in ETH
    mapping(uint256 avatarID => uint256) internal _carried;

    /// @notice Create an instance of a game
    /// @param config configuration options for the game
    /// @dev The policy and the durations are checked against each other by the
    ///  base (`InvalidCycleConfiguration`): a manual cycle has no clock, a timed
    ///  one needs both phases.
    constructor(
        Config memory config
    )
        UsingCommitReveal(
            CommitRevealConfig({
                startTime: config.startTime,
                commitPhaseDuration: config.commitPhaseDuration,
                revealPhaseDuration: config.revealPhaseDuration,
                time: config.time,
                actionsPerReveal: config.actionsPerReveal,
                cyclePolicy: config.cyclePolicy
            })
        )
    {
        // ONE CHUNK PER TURN, so the chunk must hold the longest turn that can
        // resolve. A shorter one is a configuration in which some legal turn can
        // be committed and never revealed, which costs the player the turn and,
        // under a policy that waits, the whole table its cycle.
        if (config.actionsPerReveal < config.numMoves + ACTIONS_BESIDES_MOVES) {
            revert InvalidActionsPerReveal();
        }
        MAX_MOVES = config.numMoves;
        AVATARS = config.avatars;
        NUM_MISSES_ALLOWED = config.numMissesAllowed;
    }
}
