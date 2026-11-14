// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import "./UsingGameTypes.sol";
import {UsingCommitRevealErrors} from "../../commit-reveal/interfaces/UsingCommitRevealErrors.sol";

/// @dev THE MECHANISM'S ERRORS ARE THE BASE'S (`UsingCommitRevealErrors`):
///  every phase, commitment, reveal, settlement and advance refusal this game
///  used to declare for its own copy of the mechanism is declared there now,
///  under the same names, so the client decodes them unchanged. What is left
///  here is what an AVATAR is.
interface UsingGameErrors is UsingGameTypes, UsingCommitRevealErrors {
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

    /// @notice happen when attempting to move a dead avatar
    ///  The avatar is dead, no action possible
    /// @param avatarID the id of the dead avatar
    error AvatarIsDead(uint256 avatarID);

    /// @notice `releaseDeadAvatar` was asked about an avatar that is not dead:
    ///  alive in the world, or out of it (where an avatar cannot die).
    error AvatarNotDead(uint256 avatarID);

    /// @notice The cell configuration is invalid
    ///  This can happen win debug mode where admin can setup cell bypassing moves rules
    ///  For example when setting up neighborood configuration that would require a cell to have negative life
    error ImpossibleConfiguration();

    /// @notice happen when attempting to send a non-avatar ERC721 to the game
    error OnlyAvatarsAreAccepted();

    /// @notice Value sent to the game by anything but the avatars' burn.
    error OnlyAvatarsSendValue();

    /// @notice This avatar has no open claim on that body.
    error NoClaim(uint256 collector, uint256 body);

    /// @notice The cycle the claim was made in is not over: its count is not
    ///  final yet.
    error ClaimNotFinal(uint256 body, uint64 cycleNumber);

    /// @notice The body still has claims of its own to settle: what it carries
    ///  is not final, so neither is what its collectors share.
    error BodyHasOpenClaims(uint256 body, uint256 openClaims);

    /// @notice Paying a collected value failed.
    error PaymentFailed(address to, uint256 amount);
}
