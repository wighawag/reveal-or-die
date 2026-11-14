// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.21;

import "../routes/GameGetters.sol";
import "../routes/GameDeposit.sol";
import "../routes/GameCommit.sol";
import "../routes/GameReveal.sol";
import "../routes/GameLoot.sol";
import "./UsingGameTable.sol";

// THE WORLD'S ROUTES, AT A TABLE (stratagems' plan, step R1b, R1b-11): each
// the world's own code with {UsingGameTable}'s hooks compiled in, which is the
// whole of the difference. The table implementation (`030_deploy_tables.ts`)
// deploys these in place of the world's; the world deploys none of them.
//
// THE OVERRIDES BELOW ARE THE SAME SEVEN IN EVERY ROUTE, and only name which
// of the two bases wins: Solidity asks the most derived contract to say so
// whenever a function reaches it through two bases, even when only one of them
// changes it.

/// @dev Reads, every avatar at the end cycle once the table is closed.
contract GameTableGetters is GameGetters, UsingGameTable {
    constructor(
        Config memory config,
        uint256 tableStake
    ) GameGetters(config) UsingGameTable(tableStake) {}

    function _deposit(
        uint256 avatarID,
        address owner
    ) internal override(UsingGameInternal, UsingGameTable) {
        UsingGameTable._deposit(avatarID, owner);
    }

    function _withdraw(
        address owner,
        uint256 seat,
        address to
    ) internal override(UsingGameInternal, UsingGameTable) {
        UsingGameTable._withdraw(owner, seat, to);
    }

    function _commitTurn(
        address sender,
        uint256 avatarID,
        bytes24 commitmentHash
    ) internal override(UsingGameInternal, UsingGameTable) {
        UsingGameTable._commitTurn(sender, avatarID, commitmentHash);
    }

    function _exit(
        ActionResolution memory resolution,
        uint256 data
    ) internal pure override(UsingGameInternal, UsingGameTable) {
        UsingGameTable._exit(resolution, data);
    }

    function _getResolvedAvatar(
        uint256 avatarID,
        uint64 cycleNumber
    )
        internal
        view
        override(UsingGameInternal, UsingGameTable)
        returns (AvatarResolved memory)
    {
        return UsingGameTable._getResolvedAvatar(avatarID, cycleNumber);
    }

    function _releaseBody(
        uint256 body,
        Body storage state
    ) internal override(UsingGameInternal, UsingGameTable) {
        UsingGameTable._releaseBody(body, state);
    }

    function _getBody(
        uint256 body
    )
        internal
        view
        override(UsingGameInternal, UsingGameTable)
        returns (PublicBody memory)
    {
        return UsingGameTable._getBody(body);
    }
}

/// @dev A seat in avatar mode, and every way off the table ({UsingGameTable-_withdraw}).
contract GameTableDeposit is GameDeposit, UsingGameTable {
    constructor(
        Config memory config,
        uint256 tableStake
    ) GameDeposit(config) UsingGameTable(tableStake) {}

    function _deposit(
        uint256 avatarID,
        address owner
    ) internal override(UsingGameInternal, UsingGameTable) {
        UsingGameTable._deposit(avatarID, owner);
    }

    function _withdraw(
        address owner,
        uint256 seat,
        address to
    ) internal override(UsingGameInternal, UsingGameTable) {
        UsingGameTable._withdraw(owner, seat, to);
    }

    function _commitTurn(
        address sender,
        uint256 avatarID,
        bytes24 commitmentHash
    ) internal override(UsingGameInternal, UsingGameTable) {
        UsingGameTable._commitTurn(sender, avatarID, commitmentHash);
    }

    function _exit(
        ActionResolution memory resolution,
        uint256 data
    ) internal pure override(UsingGameInternal, UsingGameTable) {
        UsingGameTable._exit(resolution, data);
    }

    function _getResolvedAvatar(
        uint256 avatarID,
        uint64 cycleNumber
    )
        internal
        view
        override(UsingGameInternal, UsingGameTable)
        returns (AvatarResolved memory)
    {
        return UsingGameTable._getResolvedAvatar(avatarID, cycleNumber);
    }

    function _releaseBody(
        uint256 body,
        Body storage state
    ) internal override(UsingGameInternal, UsingGameTable) {
        UsingGameTable._releaseBody(body, state);
    }

    function _getBody(
        uint256 body
    )
        internal
        view
        override(UsingGameInternal, UsingGameTable)
        returns (PublicBody memory)
    {
        return UsingGameTable._getBody(body);
    }
}

/// @dev Nobody commits once the table is closed.
contract GameTableCommit is GameCommit, UsingGameTable {
    constructor(
        Config memory config,
        uint256 tableStake
    ) GameCommit(config) UsingGameTable(tableStake) {}

    function _deposit(
        uint256 avatarID,
        address owner
    ) internal override(UsingGameInternal, UsingGameTable) {
        UsingGameTable._deposit(avatarID, owner);
    }

    function _withdraw(
        address owner,
        uint256 seat,
        address to
    ) internal override(UsingGameInternal, UsingGameTable) {
        UsingGameTable._withdraw(owner, seat, to);
    }

    function _commitTurn(
        address sender,
        uint256 avatarID,
        bytes24 commitmentHash
    ) internal override(UsingGameInternal, UsingGameTable) {
        UsingGameTable._commitTurn(sender, avatarID, commitmentHash);
    }

    function _exit(
        ActionResolution memory resolution,
        uint256 data
    ) internal pure override(UsingGameInternal, UsingGameTable) {
        UsingGameTable._exit(resolution, data);
    }

    function _getResolvedAvatar(
        uint256 avatarID,
        uint64 cycleNumber
    )
        internal
        view
        override(UsingGameInternal, UsingGameTable)
        returns (AvatarResolved memory)
    {
        return UsingGameTable._getResolvedAvatar(avatarID, cycleNumber);
    }

    function _releaseBody(
        uint256 body,
        Body storage state
    ) internal override(UsingGameInternal, UsingGameTable) {
        UsingGameTable._releaseBody(body, state);
    }

    function _getBody(
        uint256 body
    )
        internal
        view
        override(UsingGameInternal, UsingGameTable)
        returns (PublicBody memory)
    {
        return UsingGameTable._getBody(body);
    }
}

/// @dev No exit, the death clock from the start, and the bodies released the table's way.
contract GameTableReveal is GameReveal, UsingGameTable {
    constructor(
        Config memory config,
        uint256 tableStake
    ) GameReveal(config) UsingGameTable(tableStake) {}

    function _deposit(
        uint256 avatarID,
        address owner
    ) internal override(UsingGameInternal, UsingGameTable) {
        UsingGameTable._deposit(avatarID, owner);
    }

    function _withdraw(
        address owner,
        uint256 seat,
        address to
    ) internal override(UsingGameInternal, UsingGameTable) {
        UsingGameTable._withdraw(owner, seat, to);
    }

    function _commitTurn(
        address sender,
        uint256 avatarID,
        bytes24 commitmentHash
    ) internal override(UsingGameInternal, UsingGameTable) {
        UsingGameTable._commitTurn(sender, avatarID, commitmentHash);
    }

    function _exit(
        ActionResolution memory resolution,
        uint256 data
    ) internal pure override(UsingGameInternal, UsingGameTable) {
        UsingGameTable._exit(resolution, data);
    }

    function _getResolvedAvatar(
        uint256 avatarID,
        uint64 cycleNumber
    )
        internal
        view
        override(UsingGameInternal, UsingGameTable)
        returns (AvatarResolved memory)
    {
        return UsingGameTable._getResolvedAvatar(avatarID, cycleNumber);
    }

    function _releaseBody(
        uint256 body,
        Body storage state
    ) internal override(UsingGameInternal, UsingGameTable) {
        UsingGameTable._releaseBody(body, state);
    }

    function _getBody(
        uint256 body
    )
        internal
        view
        override(UsingGameInternal, UsingGameTable)
        returns (PublicBody memory)
    {
        return UsingGameTable._getBody(body);
    }
}

/// @dev A claim settled at a table releases its body the table's way.
contract GameTableLoot is GameLoot, UsingGameTable {
    constructor(
        Config memory config,
        uint256 tableStake
    ) GameLoot(config) UsingGameTable(tableStake) {}

    function _deposit(
        uint256 avatarID,
        address owner
    ) internal override(UsingGameInternal, UsingGameTable) {
        UsingGameTable._deposit(avatarID, owner);
    }

    function _withdraw(
        address owner,
        uint256 seat,
        address to
    ) internal override(UsingGameInternal, UsingGameTable) {
        UsingGameTable._withdraw(owner, seat, to);
    }

    function _commitTurn(
        address sender,
        uint256 avatarID,
        bytes24 commitmentHash
    ) internal override(UsingGameInternal, UsingGameTable) {
        UsingGameTable._commitTurn(sender, avatarID, commitmentHash);
    }

    function _exit(
        ActionResolution memory resolution,
        uint256 data
    ) internal pure override(UsingGameInternal, UsingGameTable) {
        UsingGameTable._exit(resolution, data);
    }

    function _getResolvedAvatar(
        uint256 avatarID,
        uint64 cycleNumber
    )
        internal
        view
        override(UsingGameInternal, UsingGameTable)
        returns (AvatarResolved memory)
    {
        return UsingGameTable._getResolvedAvatar(avatarID, cycleNumber);
    }

    function _releaseBody(
        uint256 body,
        Body storage state
    ) internal override(UsingGameInternal, UsingGameTable) {
        UsingGameTable._releaseBody(body, state);
    }

    function _getBody(
        uint256 body
    )
        internal
        view
        override(UsingGameInternal, UsingGameTable)
        returns (PublicBody memory)
    {
        return UsingGameTable._getBody(body);
    }
}
