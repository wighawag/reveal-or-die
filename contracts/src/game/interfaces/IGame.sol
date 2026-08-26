// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import "./UsingGameTypes.sol";
import "./UsingGameEvents.sol";
import "./UsingGameErrors.sol";

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

    function moveToNextEpoch() external returns (ManualEpoch memory);

    function moveToNextPhase() external returns (ManualEpoch memory);

    function acknowledgeMissedReveal(uint256 avatarID) external;
}

interface IGameGetters is UsingGameTypes {
    function getEpoch() external view returns (uint64 epoch, bool commiting);

    function getAvatarsInZone(
        uint64 zone,
        uint64 fromIndex,
        uint64 limit
    )
        external
        view
        returns (PublicAvatar[] memory avatars, bool more, uint64 epoch);

    function getAvatarsInMultipleZones(
        uint64[] calldata zones,
        uint64 fromIndex,
        uint64 limit
    )
        external
        view
        returns (PublicAvatar[] memory avatars, bool more, uint64 epoch);

    function getAvatar(
        uint256 avatarID
    ) external view returns (PublicAvatar memory avatar);

    function getCommitment(
        uint256 avatarID
    ) external view returns (Commitment memory commitment);

    function getConfig() external view returns (Config memory config);
}

interface IGameDeposit is UsingGameTypes {
    function deposit(
        uint256 avatarID,
        address controller,
        address payable payee
    ) external payable;
    function withdraw(uint256 avatarID, address to) external;
    function avatarsPerOwner(
        address owner,
        uint256 startIndex,
        uint256 limit
    ) external view returns (PublicAvatar[] memory avatarIDs, bool more);
}

interface IGame is
    UsingGameEvents,
    UsingGameErrors,
    IGameCommit,
    IGameReveal,
    IGameGetters,
    IGameDeposit
{}
