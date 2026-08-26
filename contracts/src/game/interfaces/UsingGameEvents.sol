// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./UsingGameTypes.sol";

interface UsingGameEvents is UsingGameTypes {
    /// @notice A player topped up the reserve they are willing to risk.
    event ReserveDeposited(
        address indexed player,
        uint256 amountAdded,
        uint256 newAmount
    );

    /// @notice A player took tokens back out of their reserve.
    event ReserveWithdrawn(
        address indexed player,
        uint256 amountRemoved,
        uint256 newAmount
    );

    /// @notice A player committed to a set of placements for this epoch.
    event CommitmentMade(
        address indexed player,
        uint64 indexed epoch,
        bytes24 commitmentHash,
        uint256 bond
    );

    /// @notice A player withdrew their commitment before the reveal phase.
    event CommitmentCancelled(address indexed player, uint64 indexed epoch);

    /// @notice A player revealed what they had committed to.
    event CommitmentRevealed(
        address indexed player,
        uint64 indexed epoch,
        bytes24 commitmentHash,
        Placement[] placements,
        uint256 cost
    );

    /// @notice A player never revealed, and forfeited their bond for it.
    event CommitmentVoid(
        address indexed player,
        uint64 indexed epoch,
        uint256 forfeited
    );

    /// @notice A player took a share of a cell. Cells are shared, so this does
    ///         not imply anyone lost it.
    event Placed(address indexed player, uint64 indexed cellID, uint256 stake);
}
