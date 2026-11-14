// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import "./UsingGameStore.sol";
import "../interfaces/UsingGameEvents.sol";
import "../interfaces/UsingGameErrors.sol";
import "../../utils/PositionUtils.sol";
import "../../utils/StringUtils.sol";
import "./GameUtils.sol";
import {Delegation} from "@etherplay/delegation/contracts/Delegation.sol";
import {CommitReveal} from "../../commit-reveal/CommitReveal.sol";

/// @dev What the game reads and calls of the avatars beyond ERC721 (step
///  R1a): the stake each carries, released by burning it.
interface IAvatarsWithStake {
    function stakeOf(uint256 tokenID) external view returns (uint256);

    function burn(uint256 tokenID, bytes calldata data) external;
}

/// @dev How a burned body's stake arrives at the game (`GameLoot.receiveStake`,
///  the same selector as `IGameLoot.receiveStake`).
interface IStakeReceiver {
    function receiveStake() external payable;
}

/// @dev THIS GAME, ON THE COMMIT-REVEAL BASE. Everything that is mechanism -
///  the commitment, the chunk, the cycle policies and the advance, who the
///  cycle waits for, delegation and both settlements of a missed reveal - is
///  {UsingCommitReveal}'s (`src/commit-reveal/`), which this game keeps rather
///  than writes. What is left is what an avatar is: custody, its actions, its
///  life, and the hash its turn is committed under.
///
///  TWO OF THE BASE'S THREE SEAMS ARE OVERRIDDEN HERE, and the third ({_cycle})
///  is left alone: {_playerOf} resolves an avatar through custody, and
///  {_forfeit} says what a missed reveal costs.
///
///  SEVEN INTERNALS ARE `virtual` FOR THE TABLES, and only for them
///  ({_deposit}, {_withdraw}, {_commitTurn}, {_exit}, {_getResolvedAvatar},
///  {_releaseBody}, {_getBody}): a table's routes (`src/game/table/`, stratagems'
///  plan, step R1b) override them at compile time, and the world's routes,
///  which override none, compile to the same code as before.
abstract contract UsingGameInternal is
    UsingGameStore,
    UsingGameEvents,
    UsingGameErrors
{
    constructor(Config memory config) UsingGameStore(config) {}

    //-------------------------------------------------------------------------
    // ENTRY POINTS
    //-------------------------------------------------------------------------
    function _deposit(uint256 avatarID, address owner) internal virtual {
        _players[avatarID] = Player({owner: owner, inCustody: true});

        uint256 length = _ownedAvatars[owner].length;
        _ownedAvatars[owner].push(avatarID);
        _ownedAvatarsIndex[avatarID] = length;

        emit AvatarDeposited(avatarID, owner);

        // CUSTODY IS MEMBERSHIP, under every policy: on the base only a member
        // may commit, so an avatar in custody is one the cycle waits for. Under
        // a closed roster (a table, later) it is a seat, refused once the table
        // has started. Before the port this game enrolled only under the manual
        // policy; a timed cycle never reads the count, so it costs one word.
        _takeSeat(avatarID);
    }

    /// @inheritdoc UsingCommitReveal
    /// @dev THE IDENTITY IS THE AVATAR, resolved through custody: the account
    ///      that deposited it, and `sender` must be that account or a delegate
    ///      of it. An avatar the game has never held resolves to nobody and is
    ///      refused, rather than read as "the caller" the way a zero account is
    ///      by the delegation library.
    ///
    ///      Authority is ACCOUNT-WIDE: a delegate authorised by the owner may
    ///      do anything at this game that the owner could, for every avatar
    ///      that owner holds. It is bound to this contract and this chain, so
    ///      it is worthless at any other game. Withdrawal is deliberately NOT
    ///      routed through here (see {_withdraw}): a local signer may play with
    ///      the stake, never take it.
    ///
    ///      The delegation LIBRARY rather than inheriting {UsingDelegation}: a
    ///      router maps one selector to one route, and that contract carries
    ///      six external functions which belong to {GameDelegation}.
    function _playerOf(
        address sender,
        uint256 avatarID
    ) internal view override returns (uint256 player) {
        address owner = _players[avatarID].owner;
        if (owner == address(0)) {
            revert InvalidPlayer(avatarID);
        }
        Delegation.requireAccountFor(sender, owner);
        return avatarID;
    }

    /// @inheritdoc UsingCommitReveal
    /// @dev WHAT A MISSED REVEAL COSTS HERE IS THE MISS, and the miss is already
    ///      counted: `lastCycleNumber` moves only on a reveal, and
    ///      {_getResolvedAvatar} kills an avatar that has fallen more than
    ///      `numMissesAllowed` cycles behind it. So the settlement takes
    ///      nothing more, on either route, and only clears the slot so the
    ///      avatar can commit again. Nothing is bonded (the stake is the
    ///      avatar), so `amount` is always zero.
    ///
    ///      KILLING ON A MISSED REVEAL IS THIS FUNCTION, when it is wanted (the
    ///      maintainer, 2026-11-04: not until the front end is well tested).
    ///      It would run outside any reveal, in a later cycle, so it cannot
    ///      make one reveal's outcome depend on another's.
    function _forfeit(
        uint256,
        uint256
    ) internal pure override returns (uint256 forfeited) {
        return 0;
    }

    function _withdraw(
        address owner,
        uint256 avatarID,
        address to
    ) internal virtual {
        if (_players[avatarID].owner != owner) {
            revert UsingGameErrors.NotAuthorizedOwner(owner);
        }

        // ONLY AN AVATAR OUT OF THE WORLD COMES HOME: one that left by the exit
        // alive, or one that never entered. One in the world is refused, and a
        // DEAD one is refused for good, which is the stake this game is named
        // for: the avatar is lost, the token with it.
        //
        // That reverses 9aaf42cd (2026-09-03), which let a dead avatar be
        // collected on the grounds that losing the token as well was a second
        // penalty nobody chose. The maintainer chose it (2026-11-05), and the
        // collection had a hole: out of the world an avatar reads as alive, so
        // withdraw, deposit and enter brought a dead one back. Kept in the
        // world, a dead avatar stays dead with no flag to maintain, because
        // death is computed from a clock that only moves forward
        // (`_getResolvedAvatar`), and the body stays where it fell.
        // AND NOT WITH A COMMITMENT OPEN, in any cycle. One in the current cycle
        // is counted in the base's tally the moment it is made, so leaving with
        // it would leave a commit counted for a member who is no longer one,
        // and a SUBSET could then reach unanimity. One from a past cycle is a
        // missed reveal nobody has settled.
        Commitment memory commitment = _commitmentOf(avatarID);
        if (commitment.cycleNumber != 0) {
            revert CommitmentStillOpen(commitment.cycleNumber);
        }

        if (_avatars[avatarID].inGame) {
            (uint64 cycleNumber, ) = _cycleNumber();
            if (_getResolvedAvatar(avatarID, cycleNumber).life == 0) {
                revert UsingGameErrors.AvatarIsDead(avatarID);
            }
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

        _leaveSeat(avatarID);
        // --------------------------------------------------------------------

        _players[avatarID].inCustody = false;
        uint256 carried = _carried[avatarID];
        delete _carried[avatarID];

        AVATARS.safeTransferFrom(address(this), to, avatarID);

        // WHAT IT COLLECTED goes with it, in ETH (step R1a), and the avatar
        // leaves with exactly the stake it came with. A claim still open is
        // paid to its owner when it is settled ({_settleClaim}).
        if (carried != 0) {
            emit CarriedPaid(avatarID, to, carried);
            _pay(to, carried);
        }
    }

    /// @notice Commit a turn for an avatar, if it is alive.
    /// @dev The base checks the phase, membership, and that no earlier
    ///      commitment is left unsettled (`PreviousCommitmentNotRevealed`: a
    ///      player who dislikes what they committed to must not walk away by
    ///      going quiet and committing again). What only this game can check is
    ///      that the avatar is alive, and it is checked FIRST, so a dead avatar
    ///      is told it is dead rather than whatever else is wrong with it.
    ///
    ///      Nothing is bonded: the stake is the avatar, already in custody.
    function _commitTurn(
        address sender,
        uint256 avatarID,
        bytes24 commitmentHash
    ) internal virtual {
        uint256 player = _playerOf(sender, avatarID);
        (uint64 cycleNumber, ) = _cycleNumber();
        if (_getResolvedAvatar(player, cycleNumber).life == 0) {
            revert AvatarIsDead(player);
        }
        _makeCommitment(player, commitmentHash, 0);
    }

    function _cancelTurn(address sender, uint256 avatarID) internal {
        _cancelCommitment(_playerOf(sender, avatarID));
    }

    /// @notice Open a turn and resolve it.
    /// @dev ONE CHUNK PER TURN (the maintainer, 2026-11-04): the commitment is
    ///      the head of a chain one link long, hashed with `furtherActions`
    ///      zero in the base's one encoding, and `ACTIONS_PER_REVEAL` holds the
    ///      longest turn that can resolve. There is no `furtherActions` to pass
    ///      because the move budget is counted per call: a chained turn would
    ///      get `numMoves` moves per link. Chunking needs those counters kept
    ///      per turn first.
    ///
    ///      ANYONE MAY REVEAL: the hash is the check, and accepting it from
    ///      anyone is what lets a player's reveal be sent for them.
    ///
    ///      ORDER INDEPENDENCE. The base writes only this avatar's commitment
    ///      and adds one to the cycle's tally of reveals; the resolution moves
    ///      only this avatar and never reads another's position. See
    ///      `AGENTS.md`, "Commit-reveal rules", and the test replaying a cycle
    ///      in two orders.
    function _reveal(
        uint256 avatarID,
        Action[] calldata actions,
        bytes32 secret
    ) internal {
        CommitReveal.Chunk memory chunk = _openChunk(
            avatarID,
            _digest(actions, secret),
            actions.length,
            bytes24(0)
        );

        (uint64 newPosition, uint256 numActionsResolved) = _resolveActions(
            avatarID,
            chunk.cycleNumber,
            actions
        );

        emit ActionsResolved(
            avatarID,
            chunk.cycleNumber,
            PositionUtils.getZone(newPosition),
            actions[0:numActionsResolved]
        );

        _closeChunk(chunk, 0);
    }

    /// @notice Settle a missed reveal by being shown what it committed.
    /// @dev ANYONE MAY, because nothing in it can cost the player more than
    ///      their silence did ({_forfeit}). The actions are CHECKED AND NOT
    ///      RESOLVED: the settlement runs in a later cycle, and resolving there
    ///      would write the board after the cycle it belonged to had closed.
    ///      The other route, without the actions, is the base's
    ///      {_forfeitMissedReveal}, for the owner or a delegate.
    function _acknowledgeMissedReveal(
        uint256 avatarID,
        Action[] calldata actions,
        bytes32 secret
    ) internal {
        CommitReveal.Chunk memory chunk = _openMissedChunk(
            avatarID,
            _digest(actions, secret),
            actions.length,
            bytes24(0)
        );
        _closeChunk(chunk, 0);
    }

    /// @notice Stop the cycle waiting for a dead avatar.
    /// @dev DEATH IS LAZY: {_getResolvedAvatar} computes it when asked, so
    ///      nothing happens on chain when an avatar dies, and the base's tally
    ///      (an O(1) count, by design) goes on waiting for it. Under a policy
    ///      that advances on unanimity, a dead member would block every cycle
    ///      after. So anyone may release one, and the route checks rather than
    ///      trusts: it must be in the world (an avatar out of it cannot die)
    ///      and dead now.
    ///
    ///      IT CAN NEVER LEAVE A COUNTED COMMIT BEHIND. An avatar's life is
    ///      fixed within a cycle until its own reveal: death by misses depends
    ///      on the cycle number alone, and anything else that kills is written
    ///      before the cycle starts. So an avatar dead now could not commit in
    ///      this cycle (`AvatarIsDead`), and the tally holds no commit of its.
    ///
    ///      The seat is KEPT (`_stopWaitingFor`, not `_leaveSeat`): the avatar
    ///      stays in custody for good, as a body in the world.
    function _releaseDeadAvatar(uint256 avatarID) internal {
        if (!_isWaitedFor(avatarID)) {
            revert NotInGame(avatarID);
        }
        (uint64 cycleNumber, ) = _cycleNumber();
        if (
            !_avatars[avatarID].inGame ||
            _getResolvedAvatar(avatarID, cycleNumber).life != 0
        ) {
            revert AvatarNotDead(avatarID);
        }
        _stopWaitingFor(avatarID);
    }

    //-------------------------------------------------------------------------

    struct ActionResolution {
        uint256 avatarID;
        uint64 cycleNumber;
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
        /// @notice the bodies this turn collected, recorded once it resolved
        uint256[MAX_COLLECTS] collected;
        uint256 numCollected;
    }

    //-------------------------------------------------------------------------
    // INTERNALS
    //-------------------------------------------------------------------------
    function _resolveActions(
        uint256 avatarID,
        uint64 cycleNumber,
        Action[] memory actions
    ) internal returns (uint64 newPosition, uint256 numActionsResolved) {
        Avatar memory avatar = _avatars[avatarID];
        (int32 startX, int32 startY) = PositionUtils.toXY(avatar.position);
        uint64 startZone = PositionUtils.getZone(startX, startY);

        uint256[MAX_COLLECTS] memory none;
        ActionResolution memory resolution = ActionResolution({
            avatarID: avatarID,
            cycleNumber: cycleNumber,
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
            numActionsResolved: 0,
            collected: none,
            numCollected: 0
        });

        _forEachActions(resolution, actions);
        _recordCollected(resolution);

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
                cycleNumber,
                resolution.currentZone,
                newPosition
            );
        } else if (resolution.entering) {
            _avatars[avatarID].inGame = true;
            _avatars[avatarID].startCycleNumber = cycleNumber;
            _avatars[avatarID].position = newPosition;
            _avatars[avatarID].life = 1;
            uint64 zone = PositionUtils.getZone(newPosition);
            _addToZone(zone, avatarID);
            emit EnteredTheGame(avatarID, cycleNumber, zone, newPosition);
        } else {
            if (resolution.startZone != resolution.currentZone) {
                _removeFromZone(resolution.startZone, avatarID);
                _addToZone(resolution.currentZone, avatarID);
            }
            _avatars[avatarID].position = newPosition;
        }

        _avatars[avatarID].lastCycleNumber = cycleNumber;
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
            } else if (action.actionType == ActionType.Collect) {
                _collect(resolution, action.data);
            }

            if (resolution.stopProcessing) {
                break;
            }
        }
    }

    function _enter(
        ActionResolution memory resolution,
        uint256 actionData
    ) internal pure {
        // ONLY FROM OUTSIDE THE WORLD. Nothing checked this, so an avatar
        // already standing somewhere could commit an Enter and be put wherever
        // it named: a teleport past every wall, which also left its old entry
        // in the zone listing (the entering branch of `_resolveActions` adds to
        // the new zone and removes from none). Dropped, not reverted, like any
        // other action the rules refuse: the commitment is already fixed.
        //
        // A DEAD avatar never gets here: it is still in the world (it cannot
        // leave, see `_withdraw`), and `_makeCommitment` refuses it anyway.
        if (resolution.inGame) {
            resolution.stopProcessing = true;
            return;
        }
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
        uint256 actionData
    ) internal view {
        uint64 movePosition = uint64(actionData);
        (int32 moveToX, int32 moveToY) = PositionUtils.toXY(movePosition);

        if (
            _isValidMove(
                resolution.currentX,
                resolution.currentY,
                moveToX,
                moveToY,
                resolution.cycleNumber
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
    ///  turn AND blocks the next cycle until `acknowledgeMissedReveal` is
    ///  called.
    ///  `UnableToExitFromThisPosition` stays declared in UsingGameErrors.sol
    ///  with the rest of the rules that are stated there and enforced elsewhere.
    function _exit(
        ActionResolution memory resolution,
        uint256
    ) internal pure virtual {
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

    function _getResolvedAvatar(
        uint256 avatarID,
        uint64 cycleNumber
    ) internal view virtual returns (AvatarResolved memory) {
        Avatar memory avatar = _avatars[avatarID];

        uint64 lastCycleNumber = avatar.lastCycleNumber;
        uint8 life = avatar.life;
        if (!avatar.inGame) {
            life = 1;
        } else if (life > 0) {
            (int32 x, int32 y) = PositionUtils.toXY(avatar.position);

            // we force character to continuously commit+reveal
            uint64 numMissesAllowed = uint64(NUM_MISSES_ALLOWED);
            if (cycleNumber > lastCycleNumber + 1 + numMissesAllowed) {
                life = 0;
                lastCycleNumber = lastCycleNumber + 1 + numMissesAllowed; // we fake lastCycleNumber so we can know when the character died
            }
        }

        return
            AvatarResolved({
                position: avatar.position,
                inGame: avatar.inGame,
                lastCycleNumber: lastCycleNumber,
                avatarID: avatarID,
                life: life
            });
    }

    function _getPublicAvatar(
        uint256 avatarID,
        uint64 cycleNumber
    ) internal view returns (PublicAvatar memory) {
        AvatarResolved memory avatar = _getResolvedAvatar(avatarID, cycleNumber);
        Player memory player = _players[avatarID];

        return
            PublicAvatar({
                owner: player.owner,
                position: avatar.position,
                inGame: avatar.inGame,
                lastCycleNumber: avatar.lastCycleNumber,
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
        returns (PublicAvatar[] memory avatars, bool more, uint64 cycleNumber)
    {
        (cycleNumber, ) = _cycleNumber();
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
                    cycleNumber
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
        returns (PublicAvatar[] memory avatars, bool more, uint64 cycleNumber)
    {
        (cycleNumber, ) = _cycleNumber();
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
            _fillAvatarResults(zones, fromIndex, limit, state, avatars, cycleNumber);
        } else {
            // No avatars to return
            avatars = new PublicAvatar[](0);
            more = false;
        }

        return (avatars, more, cycleNumber);
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
        uint64 cycleNumber
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
                    cycleNumber
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

    //-------------------------------------------------------------------------
    // THE BODIES (step R1a of stratagems' plan; reveal-or-die `work`:
    // `stake-in-the-avatar`). Nothing here loops further than MAX_COLLECTS.
    //-------------------------------------------------------------------------

    /// @notice Name a body on the avatar's cell, to share it.
    /// @dev CHECKED, NOT WRITTEN: the turn is still resolving, and what it
    ///  collected is recorded once it has ({_recordCollected}). A Collect the
    ///  rules refuse ends the turn, as a refused move does, so what resolved
    ///  stays a prefix of what was committed.
    ///
    ///  ORDER INDEPENDENCE. What decides a Collect is fixed for the whole
    ///  cycle whatever order the reveals arrive in: death by misses is a
    ///  function of the cycle number, a body never moves, a body cannot be
    ///  released in a cycle it can be collected in (only after its first
    ///  claimed cycle, {_settleClaim}), and the one value another reveal of
    ///  this cycle may have written, the body's first claimed cycle, reads as
    ///  either zero or this cycle, both of which accept. So the set of bodies
    ///  each avatar collects, and each body's count, come out the same in any
    ///  order; only which reveal wrote `firstClaimCycle` differs, and it wrote
    ///  the same number. `test/js/Loot.test.ts` replays it in two orders.
    function _collect(
        ActionResolution memory resolution,
        uint256 body
    ) internal view {
        if (!_collectable(resolution, body)) {
            resolution.stopProcessing = true;
            return;
        }
        resolution.collected[resolution.numCollected++] = body;
        resolution.numActionsResolved++;
    }

    function _collectable(
        ActionResolution memory resolution,
        uint256 body
    ) internal view returns (bool) {
        if (
            !resolution.inGame ||
            resolution.numCollected >= MAX_COLLECTS ||
            body == resolution.avatarID
        ) {
            return false;
        }
        for (uint256 i = 0; i < resolution.numCollected; i++) {
            if (resolution.collected[i] == body) {
                return false;
            }
        }
        Avatar memory lying = _avatars[body];
        if (
            !lying.inGame ||
            lying.position !=
            PositionUtils.fromXY(resolution.currentX, resolution.currentY)
        ) {
            return false;
        }
        Body memory state = _bodies[body];
        if (
            state.released ||
            (state.firstClaimCycle != 0 &&
                state.firstClaimCycle != resolution.cycleNumber)
        ) {
            return false;
        }
        return _getResolvedAvatar(body, resolution.cycleNumber).life == 0;
    }

    function _recordCollected(ActionResolution memory resolution) internal {
        for (uint256 i = 0; i < resolution.numCollected; i++) {
            uint256 body = resolution.collected[i];
            Body storage state = _bodies[body];
            if (state.firstClaimCycle == 0) {
                state.firstClaimCycle = resolution.cycleNumber;
            }
            state.claimants++;
            _claims[resolution.avatarID][body] = resolution.cycleNumber;
            _openClaims[resolution.avatarID].push(body);
            _openClaimIndex[resolution.avatarID][body] = _openClaims[
                resolution.avatarID
            ].length;
            emit BodyCollected(
                body,
                resolution.avatarID,
                resolution.cycleNumber
            );
        }
    }

    /// @notice Settle one collector's share of one body, pulled by anyone.
    /// @dev The first settlement of a body releases it ({_releaseBody}); each
    ///  share is `pot / claimants`, and the rounding remainder (fewer wei than
    ///  claimants) stays in the game. The share is added to what the collector
    ///  carries while the game holds it, and paid to its owner otherwise.
    function _settleClaim(uint256 collector, uint256 body) internal {
        uint64 claimedIn = _claims[collector][body];
        if (claimedIn == 0) {
            revert NoClaim(collector, body);
        }
        (uint64 cycleNumber, ) = _cycleNumber();
        if (claimedIn >= cycleNumber) {
            revert ClaimNotFinal(body, claimedIn);
        }
        Body storage state = _bodies[body];
        if (!state.released) {
            _releaseBody(body, state);
        }
        uint256 share = state.pot / state.claimants;

        delete _claims[collector][body];
        _removeOpenClaim(collector, body);

        Player memory player = _players[collector];
        if (player.inCustody) {
            _carried[collector] += share;
            emit ClaimSettled(collector, body, share, address(0));
        } else {
            emit ClaimSettled(collector, body, share, player.owner);
            _pay(player.owner, share);
        }
    }

    /// @notice Burn a body the game holds, which pays the game its stake, and
    ///  fix what its collectors share.
    /// @dev NOT WHILE IT HAS CLAIMS OF ITS OWN OPEN: what it carries is part
    ///  of the pot, and is final only once they are settled. Claims go from a
    ///  later death to an earlier one (a collector is alive when it collects),
    ///  so settling from the bottom up always ends.
    function _releaseBody(uint256 body, Body storage state) internal virtual {
        uint256 open = _openClaims[body].length;
        if (open != 0) {
            revert BodyHasOpenClaims(body, open);
        }
        uint256 before = address(this).balance;
        IAvatarsWithStake(address(AVATARS)).burn(
            body,
            abi.encodeCall(IStakeReceiver.receiveStake, ())
        );
        uint256 pot = address(this).balance - before + _carried[body];
        delete _carried[body];
        state.released = true;
        state.pot = pot;

        _removeFromZone(PositionUtils.getZone(_avatars[body].position), body);
        emit BodyReleased(body, pot);
    }

    function _getBody(
        uint256 body
    ) internal view virtual returns (PublicBody memory) {
        Body memory state = _bodies[body];
        uint256 value = state.released
            ? state.pot
            : IAvatarsWithStake(address(AVATARS)).stakeOf(body) +
                _carried[body];
        return
            PublicBody({
                firstClaimCycle: state.firstClaimCycle,
                claimants: state.claimants,
                released: state.released,
                pot: state.pot,
                value: value,
                openClaims: _openClaims[body].length
            });
    }

    /// @dev Swap-and-pop, O(1): the list has no order.
    function _removeOpenClaim(uint256 collector, uint256 body) internal {
        uint256[] storage list = _openClaims[collector];
        uint256 index = _openClaimIndex[collector][body] - 1;
        uint256 last = list.length - 1;
        if (index != last) {
            uint256 moved = list[last];
            list[index] = moved;
            _openClaimIndex[collector][moved] = index + 1;
        }
        list.pop();
        delete _openClaimIndex[collector][body];
    }

    function _pay(address to, uint256 amount) internal {
        (bool success, ) = payable(to).call{value: amount}("");
        if (!success) {
            revert PaymentFailed(to, amount);
        }
    }

    /// @notice The commitment hash of a turn, in the base's one encoding:
    ///  `bytes24(keccak256(abi.encode(secret, actions, furtherActions)))`, with
    ///  `furtherActions` zero because a turn is one chunk. `js/commitment.ts`
    ///  is the client's copy, pinned against this by the contract tests.
    function _digest(
        Action[] calldata actions,
        bytes32 secret
    ) internal pure returns (bytes24) {
        return bytes24(keccak256(abi.encode(secret, actions, bytes24(0))));
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
        uint64 cycleNumber
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
