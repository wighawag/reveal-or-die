// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import "./UsingGameTypes.sol";

interface UsingGameErrors is UsingGameTypes {
    /// @notice Game has not started yet, can't perform any action
    error GameNotStarted();

    /// @notice happen when an unauthorized account attempt to control an avatar
    error NotAuthorizedController(address account);

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
    ///  It needs to wait the next epoch
    error AvatarNotReady(uint256 avatarID);

    /// @notice When in Reveal phase, it is not possible to commit new moves or cancel previous commitment
    ///  During Reveal phase, players have to reveal their commitment, if not already done.
    error InRevealPhase(uint64 epoch);

    /// @notice When in Commit phase, player can make new commitment but they cannot reveal their move yet.
    error InCommitmentPhase(uint64 epoch);

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

    /// @notice Player can only reveal their move in the same epoch they commited.abi
    ///  If a player reveal later it can only do to minimize the reserve burn cost by calling : `acknowledgeMissedReveal`
    error InvalidEpoch(uint64 expectedEpoch, uint64 epochGiven);

    /// @notice Player have to reveal if they can
    /// prevent player from acknowledging missed reveal if there is still time to reveal.
    error CanStillReveal(uint64 epoch);

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

    /// @notice happen when attempting to move to next phase/epoch when not configured to be able to do it.
    error NextPhaseNotAllowed();

    /// @notice happen when attempting to move to next phase when skip commit is enabled
    error CommitPhaseIsSkipped();
}
