// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import "./UsingGameStore.sol";
import "../interfaces/UsingGameEvents.sol";
import "../interfaces/UsingGameErrors.sol";
import "../../utils/PositionUtils.sol";
import "../../utils/StringUtils.sol";

abstract contract UsingGameInternal is
    UsingGameStore,
    UsingGameEvents,
    UsingGameErrors
{
    constructor(Config memory config) UsingGameStore(config) {}

    //-------------------------------------------------------------------------
    // ENTRY POINTS
    //-------------------------------------------------------------------------
    function _deposit(
        uint256 avatarID,
        address owner,
        address controller
    ) internal {
        _players[avatarID] = Player({owner: owner, controller: controller});

        emit AvatarDeposited(avatarID, owner, controller);
    }

    function _makeCommitment(
        address controller,
        uint256 avatarID,
        bytes24 commitmentHash
    ) internal {
        if (_players[avatarID].controller != controller) {
            revert UsingGameErrors.NotAuthorizedController(controller);
        }

        (uint64 epoch, bool commiting) = _epoch();

        if (!commiting) {
            revert InRevealPhase(epoch);
        }

        Commitment storage commitment = _commitments[avatarID];

        if (commitment.epoch != 0 && commitment.epoch != epoch) {
            // TODO reenable
            // revert PreviousCommitmentNotRevealed();
            // TODO delete
            emit PreviousCommitmentNotRevealedEvent(
                avatarID,
                commitment.epoch,
                commitmentHash
            );
        }

        commitment.hash = commitmentHash;
        commitment.epoch = epoch;

        emit CommitmentMade(avatarID, epoch, commitmentHash);
    }

    function _cancelCommitment(address controller, uint256 avatarID) internal {
        if (_players[avatarID].controller != controller) {
            revert UsingGameErrors.NotAuthorizedController(controller);
        }

        (uint64 epoch, bool commiting) = _epoch();
        if (!commiting) {
            revert InRevealPhase(epoch);
        }

        Commitment storage commitment = _commitments[avatarID];
        if (commitment.epoch == 0) {
            revert NoCommitmentToCancel();
        }

        if (commitment.epoch != epoch) {
            revert PreviousCommitmentNotRevealed();
        }

        // Note that we do not reset the hash
        // This ensure the slot do not get reset and keep the gas cost consistent across execution
        commitment.epoch = 0;

        emit CommitmentCancelled(avatarID, epoch);
    }

    function _reveal(
        uint256 avatarID,
        bytes calldata actions,
        bytes32 secret
    ) internal {
        (uint64 epoch, bool commiting) = _epoch();

        if (commiting) {
            revert InCommitmentPhase(epoch);
        }
        Commitment storage commitment = _commitments[avatarID];

        if (commitment.epoch == 0) {
            revert NothingToReveal();
        }

        if (commitment.epoch != epoch) {
            revert InvalidEpoch(epoch, commitment.epoch);
        }

        bytes24 hashRevealed = commitment.hash;
        _checkHash(hashRevealed, actions, secret);

        emit CommitmentRevealed(avatarID, epoch, hashRevealed, actions);

        commitment.epoch = 0; // used
    }

    function _getManualEpoch() internal view returns (ManualEpoch memory) {
        if (_manualEpoch.epoch == 0) {
            // we start at 2 like the automatic epoch to make the hypothetical previous epoch be 1
            return ManualEpoch({epoch: 2, commiting: !SKIP_COMMIT});
        }
        return _manualEpoch;
    }

    function _moveToNextEpoch() internal returns (ManualEpoch memory) {
        // TODO add posibility to skip epoch even if turn are timed
        // TODO add logic to present moving to next epoch if not all player who already in the game has done so
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

        // TODO add posibility to skip epoch even if turn are timed
        // TODO add logic to present moving to next epoch if not all player who already in the game has done so
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

    function _acknowledgeMissedReveal(uint256 avatarID) internal {
        // TODO burn / stake ....
        Commitment storage commitment = _commitments[avatarID];

        if (commitment.epoch == 0) {
            revert NothingToReveal();
        }

        (uint64 epoch, ) = _epoch();

        if (commitment.epoch == epoch) {
            revert CanStillReveal(epoch);
        }

        commitment.epoch = 0;

        // TODO block nft control

        // here we cannot know whether there were further move or even any moves
        // we just burn all tokens in reserve
        emit CommitmentVoid(avatarID, epoch);
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
        bytes memory actions,
        bytes32 secret
    ) internal pure {
        // TODO remove
        if (commitmentHash == bytes24(0)) {
            return;
        }
        bytes24 computedHash = bytes24(keccak256(abi.encode(secret, actions)));
        if (commitmentHash != computedHash) {
            revert CommitmentHashNotMatching();
        }
    }

    //-------------------------------------------------------------------------
}
