// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import "./UsingGameStore.sol";
import "../interfaces/UsingGameEvents.sol";
import "../interfaces/UsingGameErrors.sol";
import "../../utils/PositionUtils.sol";
import "../../utils/StringUtils.sol";
import "./GameUtils.sol";
import {Delegation} from "@etherplay/delegation/contracts/Delegation.sol";

abstract contract UsingGameInternal is
    UsingGameStore,
    UsingGameEvents,
    UsingGameErrors
{
    constructor(Config memory config) UsingGameStore(config) {}

    //-------------------------------------------------------------------------
    // ENTRY POINTS
    //-------------------------------------------------------------------------
    function _deposit(uint256 avatarID, address owner) internal {
        _players[avatarID] = Player({owner: owner});

        uint256 length = _ownedAvatars[owner].length;
        _ownedAvatars[owner].push(avatarID);
        _ownedAvatarsIndex[avatarID] = length;

        emit AvatarDeposited(avatarID, owner);
    }

    /// @notice The account whose avatar this is, having checked `sender` may
    ///         act for it.
    /// @dev The delegation LIBRARY rather than inheriting {UsingDelegation}: a
    ///      router maps one selector to one route, and that contract carries
    ///      six external functions which belong to {GameDelegation}. Having
    ///      them on a second route would collide at deploy time. The library
    ///      reads no `msg.sender` of its own, which is what makes it usable
    ///      here.
    ///
    ///      Authority is ACCOUNT-WIDE: a delegate authorised by the owner may
    ///      do anything at this game that the owner could, for every avatar
    ///      that owner holds. It is bound to this contract and this chain, so
    ///      it is worthless at any other game. Withdrawal is deliberately NOT
    ///      routed through here (see {_withdraw}): a local signer may play with
    ///      the stake, never take it.
    function _requireAccountForAvatar(
        address sender,
        uint256 avatarID
    ) internal view returns (address owner) {
        owner = _players[avatarID].owner;
        Delegation.requireAccountFor(sender, owner);
    }

    function _withdraw(address owner, uint256 avatarID, address to) internal {
        if (_players[avatarID].owner != owner) {
            revert UsingGameErrors.NotAuthorizedOwner(owner);
        }

        if (_avatars[avatarID].inGame) {
            revert UsingGameErrors.AvatarStillInGame(avatarID);
        }

        // --------------------------------------------------------------------
        // REMOVING FROM LIST
        // --------------------------------------------------------------------
        uint256[] storage _ownedAvatarsByOwner = _ownedAvatars[owner];
        uint256 lastAvatarIndex = _ownedAvatarsByOwner.length - 1;
        uint256 avatarIndex = _ownedAvatarsIndex[avatarID];
        if (avatarIndex != lastAvatarIndex) {
            uint256 lastAvatarId = _ownedAvatarsByOwner[lastAvatarIndex];

            _ownedAvatarsByOwner[avatarIndex] = lastAvatarId;
            _ownedAvatarsIndex[lastAvatarId] = avatarIndex;
        }
        delete _ownedAvatarsIndex[avatarID];
        _ownedAvatarsByOwner.pop();
        // --------------------------------------------------------------------

        AVATARS.safeTransferFrom(address(this), to, avatarID);
    }

    function _makeCommitment(
        address sender,
        uint256 avatarID,
        bytes24 commitmentHash
    ) internal {
        _requireAccountForAvatar(sender, avatarID);

        (uint64 epoch, bool commiting) = _epoch();

        if (!commiting) {
            revert InRevealPhase(epoch);
        }

        Commitment storage commitment = _commitments[avatarID];

        // A player who dislikes what they committed to must not be able to walk
        // away by going quiet and simply committing again next epoch. Leaving an
        // unrevealed commitment behind has to cost something, so it must be
        // acknowledged first (`acknowledgeMissedReveal`, GameReveal.sol), which
        // clears the slot and voids the commitment.
        if (commitment.epoch != 0 && commitment.epoch != epoch) {
            revert PreviousCommitmentNotRevealed();
        }

        AvatarResolved memory avatar = _getResolvedAvatar(avatarID, epoch);
        if (avatar.life == 0) {
            revert AvatarIsDead(avatarID);
        }

        commitment.hash = commitmentHash;
        commitment.epoch = epoch;

        emit CommitmentMade(avatarID, epoch, commitmentHash);
    }

    function _cancelCommitment(address sender, uint256 avatarID) internal {
        _requireAccountForAvatar(sender, avatarID);

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
        Action[] calldata actions,
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

        (uint64 newPosition, uint256 numActionsResolved) = _resolveActions(
            avatarID,
            epoch,
            actions
        );

        emit CommitmentRevealed(
            avatarID,
            epoch,
            PositionUtils.getZone(newPosition),
            hashRevealed,
            actions[0:numActionsResolved]
        );

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

    struct ActionResolution {
        uint256 avatarID;
        uint64 epoch;
        bool stopProcessing;
        int32 startX;
        int32 startY;
        uint64 startZone;
        int32 currentX;
        int32 currentY;
        uint64 currentZone;
        bool left;
        bool entering;
        /// @notice Whether the avatar was in the world when the reveal began.
        /// @dev Read once, at the start: an Enter sets `stopProcessing`, so no
        ///  action can follow one and nothing here can change it mid-reveal.
        bool inGame;
        uint256 numActionsResolved;
    }

    //-------------------------------------------------------------------------
    // INTERNALS
    //-------------------------------------------------------------------------
    function _resolveActions(
        uint256 avatarID,
        uint64 epoch,
        Action[] memory actions
    ) internal returns (uint64 newPosition, uint256 numActionsResolved) {
        Avatar memory avatar = _avatars[avatarID];
        (int32 startX, int32 startY) = PositionUtils.toXY(avatar.position);
        uint64 startZone = PositionUtils.getZone(startX, startY);

        ActionResolution memory resolution = ActionResolution({
            avatarID: avatarID,
            epoch: epoch,
            stopProcessing: false,
            startX: startX,
            startY: startY,
            startZone: startZone,
            currentX: startX,
            currentY: startY,
            currentZone: startZone,
            left: false,
            entering: false,
            inGame: avatar.inGame,
            numActionsResolved: 0
        });

        _forEachActions(resolution, actions);

        newPosition = PositionUtils.fromXY(
            resolution.currentX,
            resolution.currentY
        );
        numActionsResolved = resolution.numActionsResolved;

        if (resolution.left) {
            // Note if we can die, does exiting should still be conditional to not dying
            //  extra data needed ?
            _avatars[avatarID].inGame = false;
            _avatars[avatarID].position = 0;
            _removeFromZone(resolution.startZone, avatarID);
            emit LeftTheGame(
                avatarID,
                epoch,
                resolution.currentZone,
                newPosition
            );
        } else if (resolution.entering) {
            _avatars[avatarID].inGame = true;
            _avatars[avatarID].startEpoch = epoch;
            _avatars[avatarID].position = newPosition;
            _avatars[avatarID].life = 1;
            uint64 zone = PositionUtils.getZone(newPosition);
            _addToZone(zone, avatarID);
            emit EnteredTheGame(avatarID, epoch, zone, newPosition);
        } else {
            if (resolution.startZone != resolution.currentZone) {
                _removeFromZone(resolution.startZone, avatarID);
                _addToZone(resolution.currentZone, avatarID);
            }
            _avatars[avatarID].position = newPosition;
        }

        _avatars[avatarID].lastEpoch = epoch;
    }

    function _forEachActions(
        ActionResolution memory resolution,
        Action[] memory actions
    ) internal {
        uint256 move_count = 0;
        for (uint256 i = 0; i < actions.length; i++) {
            Action memory action = actions[i];

            // NWSE (North, West, South, East)
            if (action.actionType == ActionType.Enter) {
                _enter(resolution, action.data);
            } else if (action.actionType == ActionType.Move) {
                if (move_count >= MAX_MOVES) {
                    break;
                }
                _move(resolution, action.data);
                move_count++;
            } else if (action.actionType == ActionType.Exit) {
                _exit(resolution, action.data);
            }

            if (resolution.stopProcessing) {
                break;
            }
        }
    }

    function _enter(
        ActionResolution memory resolution,
        uint128 actionData
    ) internal pure {
        uint64 entryPosition = uint64(actionData);
        (int32 moveToX, int32 moveToY) = PositionUtils.toXY(entryPosition);
        // TODO check valid entry
        resolution.currentX = moveToX;
        resolution.currentY = moveToY;
        resolution.currentZone = PositionUtils.getZone(moveToX, moveToY);
        resolution.entering = true;
        resolution.numActionsResolved++;
        resolution.stopProcessing = true;
    }

    function _move(
        ActionResolution memory resolution,
        uint128 actionData
    ) internal view {
        uint64 movePosition = uint64(actionData);
        (int32 moveToX, int32 moveToY) = PositionUtils.toXY(movePosition);

        if (
            _isValidMove(
                resolution.currentX,
                resolution.currentY,
                moveToX,
                moveToY,
                resolution.epoch
            )
        ) {
            resolution.currentX = moveToX;
            resolution.currentY = moveToY;
            resolution.currentZone = PositionUtils.getZone(moveToX, moveToY);
            resolution.numActionsResolved++;
        } else {
            resolution.stopProcessing = true;
        }
    }

    /// @notice Leave the world, which is only possible from an exit tile.
    /// @dev THE ACTION DATA IS IGNORED, and the parameter is unnamed to say so.
    ///  Leaving happens where the avatar STANDS once the moves ahead of it have
    ///  resolved, so a position carried in the action would be a second, older
    ///  claim about the same thing: a client that computed it before a refused
    ///  move would name a cell the avatar never reached. The web client fills it
    ///  in for DISPLAY only, and this is why that is safe.
    ///
    ///  A REFUSED EXIT DROPS THE ACTION, it does not revert, which is the same
    ///  treatment `_move` gives a step it will not make. Reverting would be
    ///  worse than the mistake: the reveal is a transaction against a commitment
    ///  that is already made, so a revert costs the player every action in the
    ///  turn AND blocks the next epoch until `acknowledgeMissedReveal` is
    ///  called.
    ///  `UnableToExitFromThisPosition` stays declared in UsingGameErrors.sol
    ///  with the rest of the rules that are stated there and enforced elsewhere.
    function _exit(
        ActionResolution memory resolution,
        uint128
    ) internal pure {
        // NOT IN THE WORLD, so there is nothing to leave - and this was not
        // merely pointless. `left` used to be set unconditionally, and
        // `_resolveActions` then called `_removeFromZone` with the start zone of
        // an avatar that is not in that zone's list, which pops whoever IS last
        // in it: committing an exit for an avatar outside the world evicted
        // another player from the board.
        if (!resolution.inGame) {
            resolution.stopProcessing = true;
            return;
        }

        UsingGameTypes.Area memory area = GameUtils.areaAt(
            resolution.currentX,
            resolution.currentY
        );
        if (!GameUtils.exitAt(area, resolution.currentX, resolution.currentY)) {
            resolution.stopProcessing = true;
            return;
        }

        resolution.numActionsResolved++;
        resolution.left = true;
        resolution.stopProcessing = true;
    }

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
            uint256 epochDuration = COMMIT_PHASE_DURATION +
                REVEAL_PHASE_DURATION;
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

    function _getResolvedAvatar(
        uint256 avatarID,
        uint64 epoch
    ) internal view returns (AvatarResolved memory) {
        Avatar memory avatar = _avatars[avatarID];

        uint64 lastEpoch = avatar.lastEpoch;
        uint8 life = avatar.life;
        if (!avatar.inGame) {
            life = 1;
        } else if (life > 0) {
            (int32 x, int32 y) = PositionUtils.toXY(avatar.position);

            // we force character to continuously commit+reveal
            uint64 numMissesAllowed = 3;
            if (epoch > lastEpoch + 1 + numMissesAllowed) {
                life = 0;
                lastEpoch = lastEpoch + 1 + numMissesAllowed; // we fake lastEpoch so we can know when the character died
            }
        }

        return
            AvatarResolved({
                position: avatar.position,
                inGame: avatar.inGame,
                lastEpoch: lastEpoch,
                avatarID: avatarID,
                life: life
            });
    }

    function _getPublicAvatar(
        uint256 avatarID,
        uint64 epoch
    ) internal view returns (PublicAvatar memory) {
        AvatarResolved memory avatar = _getResolvedAvatar(avatarID, epoch);
        Player memory player = _players[avatarID];

        return
            PublicAvatar({
                owner: player.owner,
                position: avatar.position,
                inGame: avatar.inGame,
                lastEpoch: avatar.lastEpoch,
                avatarID: avatarID,
                life: avatar.life
            });
    }

    function _getAvatarsInZone(
        uint64 zone,
        uint64 fromIndex,
        uint64 limit
    )
        internal
        view
        returns (PublicAvatar[] memory avatars, bool more, uint64 epoch)
    {
        (epoch, ) = _epoch();
        uint256 numAvatarsInZone = _zones[zone].avatars.length;
        if (fromIndex < numAvatarsInZone) {
            if (fromIndex + limit > numAvatarsInZone) {
                limit = uint64(numAvatarsInZone - fromIndex);
                more = false;
            } else {
                more = true;
            }
            avatars = new PublicAvatar[](limit);
            for (uint256 i = 0; i < limit; i++) {
                avatars[i] = _getPublicAvatar(
                    _zones[zone].avatars[fromIndex + i],
                    epoch
                );
            }
        }
    }

    function _getAvatarsInMultipleZones(
        uint64[] calldata zones,
        uint64 fromIndex,
        uint64 limit
    )
        internal
        view
        returns (PublicAvatar[] memory avatars, bool more, uint64 epoch)
    {
        (epoch, ) = _epoch();
        // Create a struct to hold our working variables
        AvatarFetchState memory state = _initAvatarFetchState(zones, fromIndex);

        // If we have avatars to return
        if (fromIndex < state.totalAvatars) {
            // Adjust limit if needed
            if (fromIndex + limit > state.totalAvatars) {
                limit = uint64(state.totalAvatars - fromIndex);
                more = false;
            } else {
                more = true;
            }

            avatars = new PublicAvatar[](limit);

            // Fill the result array by traversing zones
            _fillAvatarResults(zones, fromIndex, limit, state, avatars, epoch);
        } else {
            // No avatars to return
            avatars = new PublicAvatar[](0);
            more = false;
        }

        return (avatars, more, epoch);
    }

    // Helper struct to reduce stack variables
    struct AvatarFetchState {
        uint256 totalAvatars;
        uint64[] zoneEndIndices;
        uint256 currentZone;
        uint64 zoneOffset;
    }

    function _initAvatarFetchState(
        uint64[] calldata zones,
        uint64 fromIndex
    ) private view returns (AvatarFetchState memory state) {
        state.zoneEndIndices = new uint64[](zones.length);
        uint256 runningTotal = 0;

        // Calculate total avatars and track zone boundaries
        for (uint256 i = 0; i < zones.length; i++) {
            uint256 numAvatars = _zones[zones[i]].avatars.length;
            runningTotal += numAvatars;
            state.zoneEndIndices[i] = uint64(runningTotal);

            // Determine which zone contains our fromIndex
            if (
                fromIndex < runningTotal &&
                (i == 0 || fromIndex >= state.zoneEndIndices[i - 1])
            ) {
                state.currentZone = i;
                state.zoneOffset = i > 0 ? state.zoneEndIndices[i - 1] : 0;
            }
        }

        state.totalAvatars = runningTotal;
        return state;
    }

    function _fillAvatarResults(
        uint64[] calldata zones,
        uint64 fromIndex,
        uint64 limit,
        AvatarFetchState memory state,
        PublicAvatar[] memory avatars,
        uint64 epoch
    ) private view {
        uint64 avatarsReturned = 0;
        uint64 currentFromIndex = fromIndex;
        uint256 currentZone = state.currentZone;
        uint64 zoneOffset = state.zoneOffset;

        while (avatarsReturned < limit && currentZone < zones.length) {
            uint64 inZoneIndex = currentFromIndex - zoneOffset;
            uint64 zonesAvatarCount = uint64(
                _zones[zones[currentZone]].avatars.length
            );

            // Calculate how many avatars we can take from current zone
            uint64 toTake = limit - avatarsReturned;
            if (inZoneIndex + toTake > zonesAvatarCount) {
                toTake = zonesAvatarCount - inZoneIndex;
            }

            // Add avatars from current zone
            for (uint64 i = 0; i < toTake; i++) {
                uint64 zoneId = zones[currentZone];
                uint256 avatarId = _zones[zoneId].avatars[inZoneIndex + i];
                avatars[avatarsReturned + i] = _getPublicAvatar(
                    avatarId,
                    epoch
                );
            }

            avatarsReturned += toTake;
            currentFromIndex += toTake;

            // Move to next zone
            if (avatarsReturned < limit) {
                currentZone++;
                if (currentZone < zones.length) {
                    zoneOffset = state.zoneEndIndices[currentZone - 1];
                }
            }
        }
    }

    function _checkHash(
        bytes24 commitmentHash,
        Action[] memory actions,
        bytes32 secret
    ) internal pure {
        bytes24 computedHash = bytes24(keccak256(abi.encode(secret, actions)));
        if (commitmentHash != computedHash) {
            revert CommitmentHashNotMatching();
        }
    }

    function _removeFromZone(uint64 zone, uint256 avatarID) internal {
        uint256 numAvatarsInZone = _zones[zone].avatars.length;
        if (numAvatarsInZone == 1) {
            _zones[zone].avatars.pop();
        } else {
            uint64 index = _avatars[avatarID].zoneIndex;
            if (index == numAvatarsInZone - 1) {
                _zones[zone].avatars.pop();
            } else {
                uint256 lastAvatarID = _zones[zone].avatars[
                    numAvatarsInZone - 1
                ];
                _avatars[lastAvatarID].zoneIndex = index;
                _zones[zone].avatars[index] = lastAvatarID;
                _zones[zone].avatars.pop();
            }
        }
    }

    function _addToZone(uint64 zone, uint256 avatarID) internal {
        _avatars[avatarID].zoneIndex = uint64(_zones[zone].avatars.length);
        _zones[zone].avatars.push(avatarID);
    }

    function _isValidMove(
        int32 x1,
        int32 y1,
        int32 x2,
        int32 y2,
        uint64 epoch
    ) internal view returns (bool valid) {
        // TODO cache area, detect area change and update accordingly
        UsingGameTypes.Area memory area = GameUtils.areaAt(x2, y2);
        bool isWall = GameUtils.obstacleAt(area, x2, y2);

        if (isWall) {
            return false;
        }

        // Check if the move is adjacent (one tile in any direction)
        if (x1 == x2 && y1 == y2 + 1) {
            return true;
        }
        if (x1 == x2 && y1 == y2 - 1) {
            return true;
        }
        if (x1 == x2 + 1 && y1 == y2) {
            return true;
        }
        if (x1 == x2 - 1 && y1 == y2) {
            return true;
        }
        return false;
    }
    //-------------------------------------------------------------------------
}
