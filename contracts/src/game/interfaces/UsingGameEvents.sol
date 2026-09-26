// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import "./UsingGameTypes.sol";

interface UsingGameEvents is UsingGameTypes {
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

    /// @notice A player has commited to make a move and reveal it on the reveal phase
    /// @param avatarID avatar whose commitment is made
    /// @param cycleNumber the cycle this commitment belongs to
    /// @param commitmentHash the hash of moves
    event CommitmentMade(
        uint256 indexed avatarID,
        uint64 indexed cycleNumber,
        bytes24 commitmentHash
    );

    /// @notice A player has cancelled its current commitment (before it reached the reveal phase)
    /// @param avatarID avatar whose commitment is cancelled
    /// @param cycleNumber the cycle this commitment belongs to
    event CommitmentCancelled(uint256 indexed avatarID, uint64 indexed cycleNumber);

    /// @notice A player has acknowledged its failure to reveal its previous commitment
    /// @param avatarID the account that made the commitment
    /// @param cycleNumber the cycle this commitment belongs to
    event CommitmentVoid(uint256 indexed avatarID, uint64 indexed cycleNumber);

    /// @notice Player has revealed its previous commitment
    /// @param avatarID avatar id whose action is commited
    /// @param cycleNumber the cycle this commitment belongs to
    /// @param commitmentHash the hash of the moves
    /// @param actions the actions
    event CommitmentRevealed(
        uint256 indexed avatarID,
        uint64 indexed cycleNumber,
        uint64 indexed zone,
        bytes24 commitmentHash,
        Action[] actions
    );

    /// @notice a new phase has been opened by hand
    /// @param cycleNumber the cycle the new phase belongs to
    /// @param commiting whether we are in the commiting phase or not
    event NewPhase(uint64 indexed cycleNumber, bool commiting);

    /// @notice an avatar started or stopped being one the manual cycle waits for
    /// @param avatarID the avatar
    /// @param waitedFor whether it is waited for now
    /// @param count how many avatars are waited for now
    event WaitedForChanged(
        uint256 indexed avatarID,
        bool waitedFor,
        uint64 count
    );

    // allow to easily inspect errors, instead of revert
    event Error(bytes4 selector, bytes data);
}
