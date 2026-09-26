// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import "./UsingGameTypes.sol";

interface UsingGameErrors is UsingGameTypes {
    /// @notice Game has not started yet, can't perform any action
    error GameNotStarted();

    /// @notice happen when an unauthorized account attempt to control an avatar

    /// @notice happen when an unauthorized account attempt to withdraw an avatar
    error NotAuthorizedOwner(address account);

    /// @notice happen when transfering an avatar with invalid data
    error InvalidData();

    /// @notice happen when attempting to leave the game from a non-exit position
    error UnableToExitFromThisPosition(uint64 position);

    /// @notice happen when attempting to move an avatar not in the game
    error AvatarNotAvailable(uint256 avatarID);

    /// @notice happen when attempting to move an avatar not in the game
    error AvatarNotInGame(uint256 avatarID);

    /// @notice happen when attempting to enter an avatar already in the game
    error AvatarAlreadyInGame(uint256 avatarID);

    /// @notice happen when attempting to extract an avatar still in the game
    error AvatarStillInGame(uint256 avatarID);

    /// @notice happen when attempting to move an avatar that just entered the game. \
    ///  It needs to wait for the next cycle
    error AvatarNotReady(uint256 avatarID);

    /// @notice When in Reveal phase, it is not possible to commit new moves or cancel previous commitment
    ///  During Reveal phase, players have to reveal their commitment, if not already done.
    error InRevealPhase(uint64 cycleNumber);

    /// @notice When in Commit phase, player can make new commitment but they cannot reveal their move yet.
    error InCommitmentPhase(uint64 cycleNumber);

    /// @notice Previous commitment need to be revealed before making a new one. Even if the corresponding reveal phase has passed.\
    ///  It is also not possible to withdraw any amount from reserve until the commitment is revealed.\
    /// @notice If player lost the information to reveal, it can acknowledge failure which will burn all its reserve.\
    error PreviousCommitmentNotRevealed();

    /// @notice There is no commitment registered, cannot cancel.
    error NoCommitmentToCancel();

    /// @notice Player have to reveal their commitment using the exact same move values
    ///  If they provide different value, the commitment hash will differ and Game will reject their reveal.
    error CommitmentHashNotMatching();

    /// @notice Player can only reveal moves they commited.
    error NothingToReveal();

    /// @notice Player can only reveal their move in the same cycle they committed.
    ///  If a player reveal later it can only do to minimize the reserve burn cost by calling : `acknowledgeMissedReveal`
    error InvalidCycle(uint64 currentCycleNumber, uint64 commitmentCycleNumber);

    /// @notice Player have to reveal if they can
    /// prevent player from acknowledging missed reveal if there is still time to reveal.
    error CanStillReveal(uint64 cycleNumber);

    /// @notice happen when attempting to move a dead avatar
    ///  The avatar is dead, no action possible
    /// @param avatarID the id of the dead avatar
    error AvatarIsDead(uint256 avatarID);

    /// @notice The cell configuration is invalid
    ///  This can happen win debug mode where admin can setup cell bypassing moves rules
    ///  For example when setting up neighborood configuration that would require a cell to have negative life
    error ImpossibleConfiguration();

    /// @notice happen when attempting to send a non-avatar ERC721 to the game
    error OnlyAvatarsAreAccepted();

    /// @notice happen when attempting to move to the next phase when not configured to be able to do it.
    error NextPhaseNotAllowed();

    /// @notice nobody is being waited for, so unanimity has no denominator
    error NoOneToWaitFor();

    /// @notice some of the living members have not committed in this cycle yet
    error StillWaitingToCommit(uint64 committed, uint64 waitedFor);

    /// @notice some of this cycle's commitments have not been revealed yet
    error StillWaitingToReveal(uint64 revealed, uint64 committed);

    /// @notice a manual game waits for at most this many avatars
    error TooManyToWaitFor(uint256 max);

    /// @notice The declared cycle policy and the phase durations disagree.
    /// @dev Refused at CONSTRUCTION, so a game can never run a schedule it did
    ///  not declare. `Manual` requires both durations to be zero (there is no
    ///  clock, so a duration would describe a schedule nothing reads) and
    ///  `Timed` requires at least one to be non-zero (a timed cycle of length
    ///  zero divides by it). The two used to be one derivation, which is how a
    ///  manual deployment quietly became a game with no commit phase.
    /// @param cyclePolicy the policy that was declared
    error CycleConfigurationMismatch(CyclePolicy cyclePolicy);
}
