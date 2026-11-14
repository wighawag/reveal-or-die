// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import "./UsingGameTypes.sol";
import "./UsingGameEvents.sol";
import "./UsingGameErrors.sol";
import {IDelegation} from "@etherplay/delegation/contracts/IDelegation.sol";

interface IGameCommit is UsingGameTypes {
    function commit(
        uint256 avatarID,
        bytes24 commitmentHash,
        address payable payee
    ) external payable;

    function cancelCommit(uint256 avatarID) external;
}

interface IGameReveal is UsingGameTypes {
    function reveal(
        uint256 avatarID,
        Action[] calldata actions,
        bytes32 secret,
        address payable payee
    ) external payable;

    /// @notice Move the cycle on by one phase, if the rules already permit it:
    ///  every member has committed (to open the reveal phase) or every
    ///  commitment has been revealed (to close the cycle). The base's advance
    ///  ({UsingCommitReveal-_advanceCycle}); refused under the timed policy.
    function moveToNextPhase()
        external
        returns (uint64 cycleNumber, bool commiting);

    /// @notice Settle a missed reveal by showing the actions it committed.
    ///  Anyone may; nothing is resolved.
    function acknowledgeMissedReveal(
        uint256 avatarID,
        Action[] calldata actions,
        bytes32 secret
    ) external;

    /// @notice Settle a missed reveal without its actions: the owner or a
    ///  delegate of theirs only.
    function forfeitMissedReveal(uint256 avatarID) external;

    /// @notice Stop the cycle waiting for a dead avatar. Anyone may; refused
    ///  unless the avatar is in the world, dead, and still waited for.
    function releaseDeadAvatar(uint256 avatarID) external;
}

interface IGameGetters is UsingGameTypes {
    function getCycleNumber() external view returns (uint64 cycleNumber, bool commiting);

    function getAvatarsInZone(
        uint64 zone,
        uint64 fromIndex,
        uint64 limit
    )
        external
        view
        returns (PublicAvatar[] memory avatars, bool more, uint64 cycleNumber);

    function getAvatarsInMultipleZones(
        uint64[] calldata zones,
        uint64 fromIndex,
        uint64 limit
    )
        external
        view
        returns (PublicAvatar[] memory avatars, bool more, uint64 cycleNumber);

    function getAvatar(
        uint256 avatarID
    ) external view returns (PublicAvatar memory avatar);

    function getCommitment(
        uint256 avatarID
    ) external view returns (Commitment memory commitment);

    function getAttendance()
        external
        view
        returns (Attendance memory attendance);

    function getConfig() external view returns (Config memory config);
}

interface IGameDeposit is UsingGameTypes {
    function deposit(
        uint256 avatarID,
        address payable payee
    ) external payable;
    function withdraw(uint256 avatarID, address to) external;
    function avatarsPerOwner(
        address owner,
        uint256 startIndex,
        uint256 limit
    ) external view returns (PublicAvatar[] memory avatarIDs, bool more);
}

/// @dev Composes {IDelegation} so the delegation selectors appear in the ABI
///      the client is generated from. The route implementing them
///      ({GameDelegation}) deliberately does not declare `is IDelegation`; that
///      agreement is checked by asserting each selector is ROUTED on the
///      deployed proxy, which is the level at which it can actually break.
/// @notice The bodies (step R1a): a dead avatar's stake, shared by whoever
///  collects it in the first cycle it is collected in.
interface IGameLoot is UsingGameTypes {
    /// @notice Settle `collector`'s share of `body`, once the cycle it was
    ///  collected in is over. Anyone may. The first settlement of a body
    ///  burns it, which releases its stake to the game; a body with claims of
    ///  its own still open cannot be released (`BodyHasOpenClaims`).
    function settleClaim(uint256 collector, uint256 body) external;

    /// @notice How a burned body's stake arrives: the avatars contract calls
    ///  it, and nothing else may.
    function receiveStake() external payable;

    /// @notice A body: its count, whether it is released, and its value.
    function getBody(uint256 body) external view returns (PublicBody memory);

    /// @notice What an avatar collected and the game holds for it, in ETH,
    ///  paid at its withdrawal.
    function getCarried(uint256 avatarID) external view returns (uint256);

    /// @notice The bodies an avatar has an open claim on, from `start`, at most
    ///  `limit` of them, in no order, and how many there are: what a client
    ///  settles, and what must be settled before the avatar's own body can be.
    function getOpenClaims(
        uint256 avatarID,
        uint256 start,
        uint256 limit
    ) external view returns (uint256[] memory bodies, uint256 total);

    /// @notice The cycle `collector` collected `body` in, zero if it has no
    ///  open claim on it.
    function getClaim(
        uint256 collector,
        uint256 body
    ) external view returns (uint64 cycleNumber);
}

interface IGame is
    UsingGameEvents,
    UsingGameErrors,
    IGameCommit,
    IGameReveal,
    IGameGetters,
    IGameDeposit,
    IGameLoot,
    IDelegation
{}
