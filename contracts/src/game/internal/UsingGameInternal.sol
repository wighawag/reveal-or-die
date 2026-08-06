// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import "./UsingGameStore.sol";
import "../interfaces/UsingGameEvents.sol";
import "../interfaces/UsingGameErrors.sol";
import "../../utils/PositionUtils.sol";

abstract contract UsingGameInternal is
    UsingGameStore,
    UsingGameEvents,
    UsingGameErrors
{
    constructor(Config memory config) UsingGameStore(config) {}

    //-------------------------------------------------------------------------
    // RESERVE
    //-------------------------------------------------------------------------

    /// @notice Tokens a player puts at risk in order to play.
    /// @dev The reserve is what makes commit-reveal work at all. Without
    ///      something at stake a player who dislikes their revealed outcome
    ///      simply never reveals, and nothing can be done about it. A game that
    ///      prefers a different gate (custody of an NFT, say) substitutes its
    ///      own; what the framework needs is only that SOMETHING is forfeited
    ///      by _acknowledgeMissedReveal.
    function _addToReserve(address player, uint256 amount) internal {
        uint256 newAmount = _reserve[player] + amount;
        _reserve[player] = newAmount;
        emit ReserveDeposited(player, amount, newAmount);
    }

    function _withdrawFromReserve(address player, uint256 amount) internal {
        uint256 current = _reserve[player];

        // What is bonded to an open commitment cannot be withdrawn, or a player
        // could commit, see the epoch turn against them, and pull their stake
        // out instead of revealing.
        Commitment storage commitment = _commitments[player];
        uint256 locked = commitment.epoch == 0 ? 0 : commitment.bond;

        if (amount + locked > current) {
            revert ReserveTooLow(current, amount + locked);
        }

        uint256 newAmount = current - amount;
        _reserve[player] = newAmount;
        emit ReserveWithdrawn(player, amount, newAmount);
    }

    //-------------------------------------------------------------------------
    // COMMIT / REVEAL
    //-------------------------------------------------------------------------

    function _makeCommitment(
        address player,
        bytes24 commitmentHash,
        uint256 bond
    ) internal {
        (uint64 epoch, bool commiting) = _epoch();

        if (!commiting) {
            revert InRevealPhase(epoch);
        }

        if (bond > _reserve[player]) {
            revert ReserveTooLow(_reserve[player], bond);
        }

        Commitment storage commitment = _commitments[player];

        if (commitment.epoch != 0 && commitment.epoch != epoch) {
            revert PreviousCommitmentNotRevealed();
        }

        commitment.hash = commitmentHash;
        commitment.epoch = epoch;
        commitment.bond = bond;

        emit CommitmentMade(player, epoch, commitmentHash, bond);
    }

    function _cancelCommitment(address player) internal {
        (uint64 epoch, bool commiting) = _epoch();
        if (!commiting) {
            revert InRevealPhase(epoch);
        }

        Commitment storage commitment = _commitments[player];
        if (commitment.epoch == 0) {
            revert NoCommitmentToCancel();
        }

        if (commitment.epoch != epoch) {
            revert PreviousCommitmentNotRevealed();
        }

        // Note that we do not reset the hash
        // This ensure the slot do not get reset and keep the gas cost consistent across execution
        commitment.epoch = 0;

        emit CommitmentCancelled(player, epoch);
    }

    /// @notice Apply a player's revealed placements to the board.
    /// @dev ORDER INDEPENDENCE. Everything this does to a cell must commute
    ///      with what any other player's reveal does to it in the same epoch,
    ///      because reveals arrive in whatever order the mempool delivers them
    ///      and the final board must not depend on that. Concretely: accumulate
    ///      (`+=`), never branch on another player's state.
    ///
    ///      Rules like "the first to reveal takes the cell" or "reject a cell
    ///      that is already taken" look harmless and are not: they hand the
    ///      outcome to whoever pays the most gas, which is the very thing
    ///      committing was supposed to prevent. Cells are shared here; two
    ///      players placing on the same cell both hold a share of it.
    function _reveal(
        address player,
        Placement[] calldata placements,
        bytes32 secret
    ) internal {
        (uint64 epoch, bool commiting) = _epoch();

        if (commiting) {
            revert InCommitmentPhase(epoch);
        }
        Commitment storage commitment = _commitments[player];

        if (commitment.epoch == 0) {
            revert NothingToReveal();
        }

        if (commitment.epoch != epoch) {
            revert InvalidEpoch(epoch, commitment.epoch);
        }

        bytes24 hashRevealed = commitment.hash;
        _checkHash(hashRevealed, placements, secret);

        uint256 cost = placements.length * PLACEMENT_COST;
        if (cost > commitment.bond) {
            revert BondTooLow(commitment.bond, cost);
        }

        for (uint256 i = 0; i < placements.length; i++) {
            _place(player, placements[i].cellID);
        }

        _reserve[player] -= cost;
        commitment.epoch = 0; // used
        commitment.bond = 0;

        emit CommitmentRevealed(player, epoch, hashRevealed, placements, cost);
    }

    /// @dev Pure accumulation. Reads nothing that another player's reveal in
    ///      this epoch could have written, so it commutes. See _reveal.
    function _place(address player, uint64 cellID) internal {
        Cell storage cell = _cells[cellID];

        if (_stakeOnCellBy[cellID][player] == 0) {
            cell.numClaimants += 1;
        }
        _stakeOnCellBy[cellID][player] += PLACEMENT_COST;
        cell.totalStake += PLACEMENT_COST;

        emit Placed(player, cellID, PLACEMENT_COST);
    }

    /// @notice Forfeit the bond of a player who committed and never revealed.
    /// @dev This is the whole reason the reserve exists.
    function _acknowledgeMissedReveal(address player) internal {
        Commitment storage commitment = _commitments[player];

        if (commitment.epoch == 0) {
            revert NothingToReveal();
        }

        (uint64 epoch, ) = _epoch();

        if (commitment.epoch == epoch) {
            revert CanStillReveal(epoch);
        }

        uint256 forfeited = commitment.bond;
        if (forfeited > _reserve[player]) {
            forfeited = _reserve[player];
        }
        _reserve[player] -= forfeited;

        commitment.epoch = 0;
        commitment.bond = 0;

        emit CommitmentVoid(player, epoch, forfeited);
    }

    //-------------------------------------------------------------------------
    // MANUAL EPOCHS
    //-------------------------------------------------------------------------

    function _getManualEpoch() internal view returns (ManualEpoch memory) {
        if (_manualEpoch.epoch == 0) {
            // we start at 2 like the automatic epoch to make the hypothetical previous epoch be 1
            return ManualEpoch({epoch: 2, commiting: !SKIP_COMMIT});
        }
        return _manualEpoch;
    }

    function _moveToNextEpoch() internal returns (ManualEpoch memory) {
        if (!(COMMIT_PHASE_DURATION == 0 && REVEAL_PHASE_DURATION == 0)) {
            revert NextPhaseNotAllowed();
        }

        ManualEpoch memory currentManualEpoch = _getManualEpoch();
        _manualEpoch.epoch = currentManualEpoch.epoch + 1;
        _manualEpoch.commiting = !SKIP_COMMIT;

        return _manualEpoch;
    }

    function _moveToNextPhase() internal returns (ManualEpoch memory) {
        if (SKIP_COMMIT) {
            revert CommitPhaseIsSkipped();
        }

        if (!(COMMIT_PHASE_DURATION == 0 && REVEAL_PHASE_DURATION == 0)) {
            revert NextPhaseNotAllowed();
        }

        ManualEpoch memory currentManualEpoch = _getManualEpoch();
        if (currentManualEpoch.commiting) {
            _manualEpoch.epoch = currentManualEpoch.epoch;
            _manualEpoch.commiting = false;
        } else {
            _manualEpoch.commiting = true;
            _manualEpoch.epoch = currentManualEpoch.epoch + 1;
        }
        return _manualEpoch;
    }

    //-------------------------------------------------------------------------
    // INTERNALS
    //-------------------------------------------------------------------------

    function _epoch()
        internal
        view
        virtual
        returns (uint64 epoch, bool commiting)
    {
        if (COMMIT_PHASE_DURATION == 0 && REVEAL_PHASE_DURATION == 0) {
            ManualEpoch memory currentManualEpoch = _getManualEpoch();
            epoch = currentManualEpoch.epoch;
            commiting = currentManualEpoch.commiting;
        } else {
            uint256 epochDuration =
                COMMIT_PHASE_DURATION + REVEAL_PHASE_DURATION;
            uint256 time = _timestamp();
            if (time < START_TIME) {
                revert GameNotStarted();
            }
            uint256 timePassed = time - START_TIME;
            epoch = uint64(timePassed / epochDuration + 2); // epoch start at 2, this make the hypothetical previous reveal phase's epoch to be 1
            commiting =
                timePassed - ((epoch - 2) * epochDuration) <
                COMMIT_PHASE_DURATION;
        }
    }

    function _checkHash(
        bytes24 commitmentHash,
        Placement[] calldata placements,
        bytes32 secret
    ) internal pure {
        bytes24 computedHash = bytes24(
            keccak256(abi.encode(secret, placements))
        );
        if (commitmentHash != computedHash) {
            revert CommitmentHashNotMatching();
        }
    }

    //-------------------------------------------------------------------------
}
