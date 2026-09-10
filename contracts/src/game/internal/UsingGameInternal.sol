// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import "./UsingGameStore.sol";
import "../interfaces/UsingGameEvents.sol";
import "../interfaces/UsingGameErrors.sol";
import "../../utils/PositionUtils.sol";
import {Delegation} from "@etherplay/delegation/contracts/Delegation.sol";

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
    function _addToReserve(uint256 player, uint256 amount) internal {
        uint256 newAmount = _reserve[player] + amount;
        _reserve[player] = newAmount;
        emit ReserveDeposited(player, amount, newAmount);
    }

    function _withdrawFromReserve(uint256 player, uint256 amount) internal {
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
        uint256 player,
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

    function _cancelCommitment(uint256 player) internal {
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
        uint256 player,
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

    /// @dev Pure accumulation. No player's outcome depends on what another
    ///      player's reveal did this epoch, so it commutes. See _reveal.
    function _place(uint256 player, uint64 cellID) internal {
        Cell storage cell = _cells[cellID];

        if (cell.numClaimants == 0) {
            // First claim this cell has ever had: index it under its zone, so
            // reading a viewport costs what the board holds (see
            // _cellsInZones) instead of walking 256 slots per zone.
            //
            // This branch READS SHARED STATE - another player's reveal in this
            // same epoch may have claimed the cell first - which the
            // order-independence rule normally forbids. It is sound here, and
            // the reason is worth being precise about rather than trusting:
            // the rule exists so that no player's OUTCOME depends on the order
            // reveals arrive in, and nothing observable to a player changes
            // here. The cell is appended exactly once whoever arrives first,
            // every stake still accumulates, and the client keys the result by
            // cellID. What does differ with order is the POSITION of the entry
            // in the array, and which of the two reveals pays for the append.
            // Neither is part of the game.
            //
            // Guarded on numClaimants rather than totalStake so it stays
            // correct for a game configured with a zero placement cost, where
            // an occupied cell can still have a total stake of zero.
            _occupiedCellsInZone[PositionUtils.getZone(cellID)].push(cellID);
        }

        if (_stakeOnCellBy[cellID][player] == 0) {
            cell.numClaimants += 1;
        }
        _stakeOnCellBy[cellID][player] += PLACEMENT_COST;
        cell.totalStake += PLACEMENT_COST;

        emit Placed(player, cellID, PLACEMENT_COST);
    }

    /// @notice Settle a player who committed and never revealed.
    /// @dev The trigger, not the penalty. WHAT is lost is {_forfeit}, which a
    ///      game overrides; this decides only that the moment has come and that
    ///      the commitment stops blocking the next one.
    function _acknowledgeMissedReveal(uint256 player) internal {
        Commitment storage commitment = _commitments[player];

        if (commitment.epoch == 0) {
            revert NothingToReveal();
        }

        (uint64 epoch, ) = _epoch();

        if (commitment.epoch == epoch) {
            revert CanStillReveal(epoch);
        }

        uint256 forfeited = _forfeit(player, commitment.bond);

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
    // THE TWO SEAMS A GAME'S IDENTITY MODEL VARIES AT
    //-------------------------------------------------------------------------

    /// @notice WHO THE CALLER IS ACTING FOR, having checked that they may.
    /// @param sender The account or key that sent the transaction.
    /// @param id The identity, as the client named it.
    /// @return player The identity this round is filed under, which is what
    ///         every mapping in {UsingGameStore} is keyed by.
    /// @dev THE SEAM. `virtual` and nothing else in this contract is, which is
    ///      deliberate: a game that keys by a token overrides this ONE function
    ///      and touches no store, no route and no other internal. The precedent
    ///      is bomber-world's `_epoch()`, and the rule is N4 of Decision 3 in
    ///      the plan on the `work` branch.
    ///
    ///      THIS GAME IS AN ADDRESS GAME, so the identity is the account and
    ///      the only question is authority: may `sender` act for it? A token
    ///      game answers a second question here as well - is this token in a
    ///      state where it can be played at all - because there the identity is
    ///      a thing that can be absent, and nothing else on the path knows that.
    ///
    ///      RESOLUTION AND AUTHORITY ARE ONE FUNCTION ON PURPOSE. Splitting
    ///      them would let a caller reach a resolved identity without having
    ///      passed the check, which is exactly the failure the check exists
    ///      for. {_reveal} needs neither and takes the id directly, because a
    ///      reveal is validated by the commitment hash and anyone may submit
    ///      one - that is what stops an offline player forfeiting.
    ///
    ///      The delegation LIBRARY rather than inheriting {UsingDelegation},
    ///      which would bring six external functions along; a router maps one
    ///      selector to one route and they belong to {GameDelegation}, so a
    ///      second copy would collide at deploy time. The library reads no
    ///      `msg.sender` of its own, which is what makes it usable this way.
    ///      Reverts with `NotDelegate` when the caller is not authorised, which
    ///      is a better failure than the alternative: without the check a
    ///      stranger could bond someone else's reserve to a commitment only
    ///      they can reveal, and the reserve owner would lose it.
    function _playerOf(
        address sender,
        uint256 id
    ) internal view virtual returns (uint256 player) {
        // An identity that is not an address CANNOT BE ONE HERE, and saying so
        // is not pedantry: two ids that differ above the 160th bit would
        // otherwise be the same player, sharing one reserve and one commitment,
        // with nothing raised anywhere. The check costs one comparison on a
        // path that already does an external call.
        if (id > type(uint160).max) {
            revert InvalidPlayer(id);
        }
        // Zero means "whoever is calling", which the library resolves.
        return
            uint256(
                uint160(
                    Delegation.requireAccountFor(sender, address(uint160(id)))
                )
            );
    }

    /// @notice WHAT NOT REVEALING COSTS.
    /// @return forfeited How much of the bond was taken, for the event.
    /// @dev The second seam, and the framework's only requirement is that
    ///      SOMETHING is lost: a player who dislikes what they committed to can
    ///      always go quiet, and this is what makes that expensive. This game
    ///      takes the bond, which is what its reserve exists for. A game whose
    ///      stake is custody of a token seizes the token here instead and
    ///      returns zero, because it has no bond to settle in.
    function _forfeit(
        uint256 player,
        uint256 bond
    ) internal virtual returns (uint256 forfeited) {
        forfeited = bond;
        if (forfeited > _reserve[player]) {
            forfeited = _reserve[player];
        }
        _reserve[player] -= forfeited;
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
