// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import "../../core/IDelegation.sol";

import "./UsingGameTypes.sol";
import "./UsingGameEvents.sol";
import "./UsingGameErrors.sol";

interface IGameCommit is UsingGameTypes {
    /// @notice Top up the reserve a player is willing to risk.
    /// @dev Takes `player` rather than crediting msg.sender, so that the stake
    ///      can be paid from the wallet holding the funds while the game is
    ///      played by a local signing key that holds none. Anyone may top up
    ///      anyone; only the owner can withdraw.
    function addToReserve(address player, uint256 amount) external;

    /// @notice Take tokens back out. What is bonded to an open commitment stays.
    /// @dev Deliberately NOT delegable, and the only account-facing function
    ///      here that is not. A delegate is a key held in one browser so that
    ///      moves need no prompt; letting it take the stake OUT would hand
    ///      whatever got hold of that key the player's money. It may spend the
    ///      reserve on playing, which is what it is for, and it may never
    ///      withdraw it. Sent by the owner, so it prompts, which is right for
    ///      the one action that moves money to a person.
    function withdrawFromReserve(uint256 amount) external;

    /// @notice Commit to placements for this epoch, bonding part of the reserve.
    /// @param player The account the commitment is FOR. Pass the zero address
    ///        to play as the caller. Anything else must be an account that has
    ///        authorised the caller as its delegate, which is how a local
    ///        signer commits for the player without holding their stake.
    /// @dev Authority and identity are separate here, and only the FIRST is
    ///      checked: the caller must be allowed to act for `player`. Compare
    ///      {reveal}, which checks nothing, because a reveal is validated by
    ///      the commitment hash rather than by who submits it.
    function makeCommitment(
        address player,
        bytes24 commitmentHash,
        uint256 bond,
        address payable payee
    ) external payable;

    /// @notice Withdraw a commitment before the reveal phase begins.
    /// @param player The account whose commitment it is; zero for the caller.
    ///        Delegable for the same reason committing is: the browser that
    ///        made it is the one that knows it should go.
    function cancelCommitment(address player) external;
}

interface IGameReveal is UsingGameTypes {
    /// @notice Reveal what a player committed to, and apply it to the board.
    /// @dev Takes `player` rather than using msg.sender so that anyone can
    ///      reveal for them: a player who is offline when the reveal phase
    ///      opens should not automatically forfeit.
    function reveal(
        address player,
        Placement[] calldata placements,
        bytes32 secret,
        address payable payee
    ) external payable;

    /// @notice Forfeit the bond of a player who never revealed.
    function acknowledgeMissedReveal(address player) external;

    /// @notice Manually advance the epoch. Only on a manually-timed game.
    function moveToNextEpoch() external returns (ManualEpoch memory);

    /// @notice Manually advance the phase. Only on a manually-timed game.
    function moveToNextPhase() external returns (ManualEpoch memory);
}

interface IGameGetters is UsingGameTypes {
    function getEpoch() external view returns (uint64 epoch, bool commiting);

    function getCommitment(
        address player
    ) external view returns (Commitment memory commitment);

    function getReserve(address player) external view returns (uint256 amount);

    function getConfig() external view returns (Config memory config);

    /// @notice One cell.
    function getCell(uint64 cellID) external view returns (Cell memory cell);

    /// @notice What a specific player holds on a cell.
    function getStakeOnCell(
        uint64 cellID,
        address player
    ) external view returns (uint256 stake);

    /// @notice Every non-empty cell in a zone, plus the epoch the answer is for.
    /// @dev The epoch is returned so a caller can tell a current answer from a
    ///      stale one without a second call.
    function getCellsInZone(
        uint64 zone
    ) external view returns (CellAt[] memory cells, uint64 epoch);

    /// @notice The same across several zones, for a viewport spanning them.
    function getCellsInZones(
        uint64[] calldata zones
    ) external view returns (CellAt[] memory cells, uint64 epoch);
}

interface IGame is IGameCommit, IGameReveal, IGameGetters, IDelegation {}
