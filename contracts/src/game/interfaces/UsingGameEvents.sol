// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./UsingGameTypes.sol";

/// @dev `player` IS A `uint256` IN EVERY EVENT HERE, and it is the same
///      `uint256` the store keys by: whatever this game means by a player,
///      never an address that a token game would have to truncate into. See
///      {UsingGameStore} for why twenty bytes is not enough, and
///      {UsingGameInternal-_playerOf} for where the meaning is decided.
interface UsingGameEvents is UsingGameTypes {
    /// @notice A player topped up the reserve they are willing to risk.
    event ReserveDeposited(
        uint256 indexed player,
        uint256 amountAdded,
        uint256 newAmount
    );

    /// @notice A player took tokens back out of their reserve.
    event ReserveWithdrawn(
        uint256 indexed player,
        uint256 amountRemoved,
        uint256 newAmount
    );

    /// @notice A player committed to a set of placements for this epoch.
    event CommitmentMade(
        uint256 indexed player,
        uint64 indexed epoch,
        bytes24 commitmentHash,
        uint256 bond
    );

    /// @notice A player withdrew their commitment before the reveal phase.
    event CommitmentCancelled(uint256 indexed player, uint64 indexed epoch);

    /// @notice A player revealed what they had committed to.
    event CommitmentRevealed(
        uint256 indexed player,
        uint64 indexed epoch,
        bytes24 commitmentHash,
        Placement[] placements,
        uint256 cost
    );

    /// @notice A player never revealed, and lost whatever this game puts at
    ///         stake for it.
    /// @param forfeited How much of the BOND was taken, which is what this
    ///        game's {UsingGameInternal-_forfeit} settles in. A game whose
    ///        stake is not a bond reports zero here and says what it took in an
    ///        event of its own.
    event CommitmentVoid(
        uint256 indexed player,
        uint64 indexed epoch,
        uint256 forfeited
    );

    /// @notice A player took a share of a cell. Cells are shared, so this does
    ///         not imply anyone lost it.
    event Placed(uint256 indexed player, uint64 indexed cellID, uint256 stake);
}
