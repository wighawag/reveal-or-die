// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import "./UsingGameTypes.sol";
import {UsingCommitRevealEvents} from "../../commit-reveal/interfaces/UsingCommitRevealEvents.sol";

interface UsingGameEvents is UsingGameTypes, UsingCommitRevealEvents {
    /// @notice An avatar has been deposited, ready to enter
    /// @param avatarID the id of the NFT being deposited
    /// @param owner the account that owns the avatar: the only one that can
    ///        withdraw it, and the one a delegate plays on behalf of
    event AvatarDeposited(uint256 indexed avatarID, address indexed owner);

    /// @notice A avatar has been withdrawn
    /// @param avatarID the id of the NFT being transfered out
    event AvatarWithdrawn(uint256 indexed avatarID);

    /// @notice A avatar has entered the game
    /// @param avatarID the id of the NFT being added
    /// @param cycleNumber the cycle in which it happened
    /// @param zone the resulting avatar's zone
    /// @param newPosition the resulting avatar's position
    event EnteredTheGame(
        uint256 indexed avatarID,
        uint64 indexed cycleNumber,
        uint64 indexed zone,
        uint64 newPosition
    );

    /// @notice An avatar has left the game
    /// @param avatarID the id of the NFT being removed
    /// @param cycleNumber the cycle in which it happened
    /// @param zoneWhenLeaving the avatar's zone when leaving
    /// @param positionWhenLeaving the avatar's position when leaving
    event LeftTheGame(
        uint256 indexed avatarID,
        uint64 indexed cycleNumber,
        uint64 indexed zoneWhenLeaving,
        uint64 positionWhenLeaving
    );

    /// @notice What a revealed turn did, as the game resolved it.
    /// @dev THE BASE SAYS THAT A COMMITMENT WAS OPENED (`CommitmentRevealed`,
    ///  `UsingCommitRevealEvents`) and cannot say what was in it: it is shown a
    ///  digest and a count, never this game's actions. So the actions are this
    ///  game's own event, as the reference game's `Placed` is. Its own NAME
    ///  because the base took `CommitmentRevealed`: an overloaded event would
    ///  put two entries of one name in the ABI, and the client asks for this
    ///  one by name with an indexed `zone` the base's does not have.
    ///
    ///  `actions` is what RESOLVED, a prefix of what was committed: the first
    ///  action the rules refuse ends the turn, and it and every action after it
    ///  are left out.
    /// @param avatarID avatar whose turn it was
    /// @param cycleNumber the cycle this turn belongs to
    /// @param zone the avatar's zone once the turn resolved
    /// @param actions the actions that resolved
    event ActionsResolved(
        uint256 indexed avatarID,
        uint64 indexed cycleNumber,
        uint64 indexed zone,
        Action[] actions
    );

    // The commitment events (`CommitmentMade`, `CommitmentCancelled`,
    // `CommitmentRevealed`, `CommitmentVoid`), the advance (`CycleAdvanced`, in
    // place of this game's `NewPhase`) and `WaitedForChanged` are the base's,
    // inherited above.

    // allow to easily inspect errors, instead of revert
    event Error(bytes4 selector, bytes data);
}
