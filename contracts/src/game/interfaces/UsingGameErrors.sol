// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface UsingGameErrors {
    /// @notice the game has not started yet
    error GameNotStarted();

    /// @notice trying to commit while the reveal phase is running
    error InRevealPhase(uint64 epoch);

    /// @notice trying to reveal while the commit phase is running
    error InCommitmentPhase(uint64 epoch);

    /// @notice there is no commitment to reveal or to void
    error NothingToReveal();

    /// @notice there is no commitment to cancel
    error NoCommitmentToCancel();

    /// @notice an earlier commitment was never revealed; resolve it first
    error PreviousCommitmentNotRevealed();

    /// @notice the commitment belongs to a different epoch
    error InvalidEpoch(uint64 currentEpoch, uint64 commitmentEpoch);

    /// @notice the revealed placements do not hash to what was committed
    error CommitmentHashNotMatching();

    /// @notice the player can still reveal, so the commitment cannot be voided
    error CanStillReveal(uint64 epoch);

    /// @notice the player's reserve cannot cover this
    error ReserveTooLow(uint256 current, uint256 required);

    /// @notice the revealed placements cost more than the bond set aside
    error BondTooLow(uint256 bond, uint256 required);

    /// @notice manual epoch control is not available on a timed game
    error NextPhaseNotAllowed();

    /// @notice the commit phase is skipped in this configuration
    error CommitPhaseIsSkipped();
}
