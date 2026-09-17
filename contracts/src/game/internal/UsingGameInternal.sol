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
    constructor(Config memory config) UsingGameStore(config) {
        // THE ARITHMETIC THE WHOLE CYCLE RESTS ON, checked once here rather
        // than trusted forever. A cycle is a commit phase followed by a reveal
        // phase and nothing else, with no trailing segment, so a commitment
        // made in the CURRENT cycle is always still openable: you are either in
        // the phase that takes it or in the phase that opens it. A zero phase
        // punches a hole straight through that - a zero reveal phase makes
        // every commitment unopenable and a zero commit phase makes every
        // commitment impossible - and the hole is silent, because it costs the
        // first player their stake rather than reverting anything.
        //
        // A manual game has no clock, so durations there would describe a
        // schedule that does not exist, and a client reads them back to draw a
        // countdown with. Refused too, for the same reason: it is a deployment
        // mistake either way, and this is the cheapest place it can be caught.
        if (config.cyclePolicy == CyclePolicy.Manual) {
            if (
                config.commitPhaseDuration != 0 ||
                config.revealPhaseDuration != 0
            ) {
                revert InvalidCycleConfiguration();
            }
        } else if (
            config.commitPhaseDuration == 0 || config.revealPhaseDuration == 0
        ) {
            revert InvalidCycleConfiguration();
        }

        // THE SAME CLASS OF HOLE, one level down. A chunk of zero actions makes
        // every reveal revert, so every turn is committed and none can ever be
        // opened: the commitment stands, the reveal never comes, and the bond is
        // taken by _acknowledgeMissedReveal. Nothing about that looks like a
        // misconfiguration from the outside, which is why it is refused here
        // rather than discovered by the first player to lose a stake to it.
        if (config.actionsPerReveal == 0) {
            revert InvalidActionsPerReveal();
        }
    }

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

        // WHAT MAKES SOMEONE A MEMBER IS THE GAME'S ANSWER, and this game's is
        // a funded reserve: holding one is exactly what lets an account play
        // here, so it is what the cycle waits for. A game whose entry is
        // custody of a token calls the same pair from wherever custody is
        // taken and given back.
        if (newAmount != 0) {
            _startWaitingFor(player);
        }
    }

    function _withdrawFromReserve(uint256 player, uint256 amount) internal {
        uint256 current = _reserve[player];

        // What is bonded to an open commitment cannot be withdrawn, or a player
        // could commit, see the cycle turn against them, and pull their stake
        // out instead of revealing.
        Commitment storage commitment = _commitments[player];
        uint256 locked = commitment.cycleNumber == 0 ? 0 : commitment.bond;

        if (amount + locked > current) {
            revert ReserveTooLow(current, amount + locked);
        }

        // AND YOU CANNOT LEAVE WITH A TURN STILL OPEN, which is the same rule
        // as the line above applied to the thing that is really at stake. The
        // bond is not the only thing an open commitment holds: being a member
        // is, because the cycle is WAITING for this player. A turn bonding
        // ZERO locks nothing, so without this a player could commit, empty
        // their reserve, cease to be waited for, and leave the cycle counting
        // their commitment while no longer counting them - at which point a
        // SUBSET satisfies unanimity and closes the phase on somebody who has
        // not acted. That is not a corner case: an idle player's automatic
        // empty turn bonds exactly zero.
        if (amount == current && commitment.cycleNumber != 0) {
            revert CommitmentStillOpen(commitment.cycleNumber);
        }

        uint256 newAmount = current - amount;
        _reserve[player] = newAmount;
        emit ReserveWithdrawn(player, amount, newAmount);

        // Taking everything back out is leaving, so the cycle stops waiting.
        // Note what this does NOT do: it settles nothing and it costs nothing
        // beyond the departure itself. Leaving the set the cycle waits for and
        // being punished for going silent are different questions, and only
        // the first one is the cycle's.
        if (newAmount == 0) {
            _stopWaitingFor(player);
        }
    }

    //-------------------------------------------------------------------------
    // COMMIT / REVEAL
    //-------------------------------------------------------------------------

    function _makeCommitment(
        uint256 player,
        bytes24 commitmentHash,
        uint256 bond
    ) internal {
        (uint64 cycleNumber, bool commiting) = _cycleNumber();

        if (!commiting) {
            revert InRevealPhase(cycleNumber);
        }

        // ONLY A MEMBER MAY TAKE A TURN, and the reason is arithmetic rather
        // than etiquette: unanimity compares how many have committed against
        // how many the cycle waits for, and those two have to count the SAME
        // SET or the comparison means nothing. Without this, any address at
        // all could commit - a bond of zero against a reserve of zero passes
        // every other check here - and enough throwaway addresses could push
        // the count past the membership, close the commit phase before a real
        // player had acted, and do it again every block.
        //
        // It costs an honest player nothing: entering is what gives them
        // something to bond in the first place.
        if (!_isWaitedFor[player]) {
            revert NotInGame(player);
        }

        if (bond > _reserve[player]) {
            revert ReserveTooLow(_reserve[player], bond);
        }

        Commitment storage commitment = _commitments[player];

        if (
            commitment.cycleNumber != 0 && commitment.cycleNumber != cycleNumber
        ) {
            revert PreviousCommitmentNotRevealed();
        }

        // Counted once per player per cycle, not once per call: replacing a
        // commitment you already made this cycle is allowed, and counting it
        // again would let one player alone satisfy unanimity for the whole
        // set. Every commitment reaching here is a member's, per the check
        // above, which is what makes this count comparable to {_waitedFor}.
        if (commitment.cycleNumber != cycleNumber) {
            _recordCommitment(cycleNumber);
        }

        commitment.hash = commitmentHash;
        commitment.cycleNumber = cycleNumber;
        commitment.bond = bond;

        emit CommitmentMade(player, cycleNumber, commitmentHash, bond);
    }

    function _cancelCommitment(uint256 player) internal {
        (uint64 cycleNumber, bool commiting) = _cycleNumber();
        if (!commiting) {
            revert InRevealPhase(cycleNumber);
        }

        Commitment storage commitment = _commitments[player];
        if (commitment.cycleNumber == 0) {
            revert NoCommitmentToCancel();
        }

        if (commitment.cycleNumber != cycleNumber) {
            revert PreviousCommitmentNotRevealed();
        }

        // Note that we do not reset the hash
        // This ensure the slot do not get reset and keep the gas cost consistent across execution
        commitment.cycleNumber = 0;
        _recordCancellation(cycleNumber);

        emit CommitmentCancelled(player, cycleNumber);
    }

    /// @notice Apply one chunk of a player's revealed placements to the board.
    /// @param furtherActions The hash of the next chunk, or zero if this is the
    ///        last. A commitment is the HEAD OF A HASH CHAIN: each reveal opens
    ///        one chunk and rewrites the head to the next, and the commitment
    ///        stays open until a chunk arrives declaring none.
    /// @dev WHY A TURN IS NOT A TRANSACTION. Every chain has a gas ceiling, so a
    ///      turn longer than that ceiling has to arrive in pieces. That is a
    ///      mechanism rather than a rule, and every game on this template needs
    ///      it, which is why the framework owns it and why the piece size is a
    ///      deployment parameter ({UsingGameTypes-Config-actionsPerReveal})
    ///      rather than a constant.
    ///
    ///      TWO LENGTH RULES, AND NEITHER IS TIDINESS. A chunk may never carry
    ///      more than the configured number, or the bound the whole design
    ///      exists for would hold for every reveal except the last of each turn.
    ///      And a chunk that promises a successor must be exactly FULL, or a
    ///      player dribbles one action per transaction and spreads a turn across
    ///      unbounded reveals.
    ///
    ///      THE CYCLE'S TALLY COUNTS TURNS, NOT TRANSACTIONS, which is the part
    ///      with a stake in it. {_recordReveal} fires only on the chunk that
    ///      closes the chain: counting a partial reveal would let unanimity
    ///      close the cycle while a player still had chunks owed, and those
    ///      chunks would then be unrevealable - half a turn applied, the rest
    ///      lost, by somebody else's advance.
    ///
    /// @dev ORDER INDEPENDENCE. Everything this does to a cell must commute
    ///      with what any other player's reveal does to it in the same cycle,
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
        bytes32 secret,
        bytes24 furtherActions
    ) internal {
        (uint64 cycleNumber, bool commiting) = _cycleNumber();

        if (commiting) {
            revert InCommitmentPhase(cycleNumber);
        }
        Commitment storage commitment = _commitments[player];

        if (commitment.cycleNumber == 0) {
            revert NothingToReveal();
        }

        if (commitment.cycleNumber != cycleNumber) {
            revert InvalidCycle(cycleNumber, commitment.cycleNumber);
        }

        uint256 numActions = placements.length;
        if (numActions > ACTIONS_PER_REVEAL) {
            revert TooManyActions(numActions, ACTIONS_PER_REVEAL);
        }
        if (furtherActions != bytes24(0) && numActions != ACTIONS_PER_REVEAL) {
            revert InvalidFurtherActions(numActions, ACTIONS_PER_REVEAL);
        }

        bytes24 hashRevealed = commitment.hash;
        _checkHash(hashRevealed, placements, secret, furtherActions);

        uint256 cost = numActions * PLACEMENT_COST;
        if (cost > commitment.bond) {
            revert BondTooLow(commitment.bond, cost);
        }

        for (uint256 i = 0; i < numActions; i++) {
            _place(player, placements[i].cellID);
        }

        _reserve[player] -= cost;
        // WHAT IS LEFT EARMARKED IS WHAT IS STILL OWED. Taking each chunk's cost
        // out of the bond as it lands is what keeps the two halves of a
        // half-revealed turn accounted for separately: what was opened has been
        // paid for, and what was not is still at stake.
        commitment.bond -= cost;

        if (furtherActions != bytes24(0)) {
            // The chain advances. The commitment stays open, so the player
            // remains someone the cycle is waiting on, and the reserve stays
            // locked to the rest of the turn.
            commitment.hash = furtherActions;
        } else {
            commitment.cycleNumber = 0; // used
            // The surplus goes back to being ordinary reserve: a player may bond
            // more than their turn ends up costing, and nothing should hold it
            // once the turn is closed.
            commitment.bond = 0;
            _recordReveal(cycleNumber);
        }

        emit CommitmentRevealed(
            player,
            cycleNumber,
            hashRevealed,
            placements,
            furtherActions,
            cost
        );
    }

    /// @dev Pure accumulation. No player's outcome depends on what another
    ///      player's reveal did this cycle, so it commutes. See _reveal.
    function _place(uint256 player, uint64 cellID) internal {
        Cell storage cell = _cells[cellID];

        if (cell.numClaimants == 0) {
            // First claim this cell has ever had: index it under its zone, so
            // reading a viewport costs what the board holds (see
            // _cellsInZones) instead of walking 256 slots per zone.
            //
            // This branch READS SHARED STATE - another player's reveal in this
            // same cycle may have claimed the cell first - which the
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

    /// @notice Settle a player who committed and never finished revealing.
    /// @dev The trigger, not the penalty. WHAT is lost is {_forfeit}, which a
    ///      game overrides; this decides only that the moment has come and that
    ///      the commitment stops blocking the next one.
    ///
    ///      IT SETTLES A HALF-REVEALED TURN IN ONE CALL, and takes no chunk, no
    ///      secret and no `furtherActions`. That is a deliberate departure from
    ///      the design this chaining is ported from, where the settlement walks
    ///      the chain exactly as the reveal does, and the reason the departure
    ///      is safe is worth stating because the general warning attached to it
    ///      is real: a settlement that CANNOT close a partially revealed
    ///      commitment leaves the player blocked forever, since the head points
    ///      at a chunk nobody will ever submit.
    ///
    ///      Here the penalty is the bond, which was fixed when the commitment
    ///      was made and is decremented by each chunk as it lands, so the
    ///      contract already knows what is outstanding and needs nothing from
    ///      the caller to close it. Walking the chain here would instead require
    ///      the SECRET, which is exactly what a player who has gone silent will
    ///      not supply, and would make settlement depend on the very thing that
    ///      failed.
    ///
    ///      TWO THINGS MAKE A GAME NEED THE CHUNKS HERE, and they are
    ///      independent. Stratagems has BOTH, which is why it is the worked
    ///      example either way.
    ///
    ///      1. A PENALTY COMPUTED FROM THE ACTIONS. Stratagems burns reserve per
    ///         move revealed, so it cannot know what to take without being shown
    ///         them.
    ///      2. A BOND DELIBERATELY LARGER THAN WHAT THE TURN WILL COST, which is
    ///         the subtler one and is a HIDING requirement rather than an
    ///         accounting one. The bond is PUBLIC - it is in
    ///         {UsingGameEvents-CommitmentMade} and in what
    ///         {IGameGetters-getCommitment} returns - so a bond equal to the
    ///         exact cost tells every observer how many actions the commitment
    ///         hides. A game that cares posts more than it needs, and then this
    ///         function cannot tell the surplus from the stake: forfeiting all
    ///         of it punishes the HIDING rather than the silence, and punishes
    ///         it hardest on the player who hid best. Such a game has to accept
    ///         the chunks so that what was actually committed can be
    ///         established and the surplus returned.
    ///
    ///      THIS GAME HAS NEITHER, and the second one is a choice rather than a
    ///      property: its client bonds the exact cost of what was planned (see
    ///      `placement/commit-reveal.ts`), so its bond leaks the length of the
    ///      turn, and that is a real hiding weakness rather than a reason the
    ///      settlement is simple. Fixing it - bonding a rounded or a fixed
    ///      amount - would move this game into case 2 and would need this
    ///      function to change with it. Do not read "one call is enough" as a
    ///      property of chaining; it is a property of a bond that is exactly
    ///      what it will spend.
    ///
    ///      The test that pins today's behaviour is the one to read first:
    ///      "settles a half-revealed turn in ONE call, and frees the next
    ///      cycle".
    function _acknowledgeMissedReveal(uint256 player) internal {
        Commitment storage commitment = _commitments[player];

        if (commitment.cycleNumber == 0) {
            revert NothingToReveal();
        }

        (uint64 cycleNumber, ) = _cycleNumber();

        if (commitment.cycleNumber == cycleNumber) {
            revert CanStillReveal(cycleNumber);
        }

        uint256 forfeited = _forfeit(player, commitment.bond);

        commitment.cycleNumber = 0;
        commitment.bond = 0;

        emit CommitmentVoid(player, cycleNumber, forfeited);
    }

    //-------------------------------------------------------------------------
    // WHO THE CYCLE WAITS FOR
    //-------------------------------------------------------------------------

    /// @notice Start blocking the cycle on this player.
    /// @dev Idempotent on purpose: the caller is a game rule ("a funded
    ///      reserve means you are in") and rules fire more than once. A count
    ///      that could be incremented twice for one member would make
    ///      unanimity unreachable, which is a deadlock rather than an error
    ///      message.
    function _startWaitingFor(uint256 player) internal {
        if (_isWaitedFor[player]) {
            return;
        }
        _isWaitedFor[player] = true;
        uint64 count = _waitedFor + 1;
        _waitedFor = count;
        emit WaitedForChanged(player, true, count);
    }

    /// @notice Stop blocking the cycle on this player.
    /// @dev The whole of what leaving means. It settles nothing, returns
    ///      nothing and burns nothing, because those are the GAME's questions
    ///      and answering them here would make "stop waiting for me" into a
    ///      costless exit from a commitment - which is the one thing this
    ///      template may never offer.
    ///
    ///      It takes effect from the current cycle forward and is never
    ///      retroactive: a cycle that has already advanced cannot be
    ///      re-decided, or the outcome would depend on when the removal landed
    ///      relative to other reveals, which is the order-independence rule one
    ///      level up.
    ///
    ///      ITS GUARD IS NOT REACHABLE FROM OUTSIDE TODAY, and is here for the
    ///      second caller rather than for this one: `withdrawFromReserve`
    ///      refuses a zero amount and an empty reserve, so nobody can leave
    ///      twice. Removing it passes the whole suite, which is recorded here
    ///      rather than pinned by a test that would have to reach through a
    ///      route that does not exist. A game that also drops a member on
    ///      forfeit has two callers and needs it: without it the count would
    ///      fall below the number of members who can actually answer, and a
    ///      subset would then satisfy "unanimity".
    function _stopWaitingFor(uint256 player) internal {
        if (!_isWaitedFor[player]) {
            return;
        }
        _isWaitedFor[player] = false;
        uint64 count = _waitedFor - 1;
        _waitedFor = count;
        emit WaitedForChanged(player, false, count);
    }

    /// @notice The denominator, and how much of it has acted this cycle.
    function _attendance(
        uint64 cycleNumber
    ) internal view returns (Attendance memory attendance) {
        attendance.waitedFor = _waitedFor;
        if (_tally.cycleNumber == cycleNumber) {
            attendance.committed = _tally.committed;
            attendance.revealed = _tally.revealed;
        }
    }

    function _recordCommitment(uint64 cycleNumber) internal {
        if (_tally.cycleNumber != cycleNumber) {
            _tally = CycleTally({
                cycleNumber: cycleNumber,
                committed: 1,
                revealed: 0
            });
        } else {
            _tally.committed += 1;
        }
    }

    function _recordCancellation(uint64 cycleNumber) internal {
        if (_tally.cycleNumber == cycleNumber && _tally.committed != 0) {
            _tally.committed -= 1;
        }
    }

    function _recordReveal(uint64 cycleNumber) internal {
        if (_tally.cycleNumber == cycleNumber) {
            _tally.revealed += 1;
        }
    }

    //-------------------------------------------------------------------------
    // ADVANCING THE CYCLE
    //-------------------------------------------------------------------------

    /// @notice Move the cycle on, if the rules already permit it.
    /// @return cycleNumber The cycle after the move.
    /// @return commiting Which phase it is now in.
    /// @dev ITS OWN TRANSACTION, NEVER A RIDER ON THE LAST REVEAL, and the
    ///      three reasons are worth keeping next to the code. Advancing inside
    ///      `reveal` would make that call mean something different depending on
    ///      whether you happened to be last, so the policy would leak into the
    ///      one call every policy shares. It would make that reveal's gas
    ///      depend on winning a race, which is the worst possible input to the
    ///      out-of-gas remedy this app already has. And it would not be
    ///      retriable: an advance stranded by an unrelated revert would leave
    ///      the cycle stuck, where a separate call can simply be made again, by
    ///      anyone.
    ///
    ///      PERMISSIONLESS BUT STRICTLY CONDITIONAL. Anyone may call it and it
    ///      may only do what the rules already permit, so allowing anyone to
    ///      call it grants nothing. The liveness it assumes is bounded, because
    ///      it only exists in the policies where somebody is present anyway.
    ///
    ///      UNANIMITY, NEVER A MAJORITY OR A QUORUM. If a subset could close a
    ///      phase, fast players would time out slow ones and the cycle would
    ///      become a race - the order-independence failure one level up, where
    ///      whoever is quickest decides the outcome and committing bought
    ///      nothing.
    ///
    ///      IT ONLY EVER WIDENS A WINDOW. Opening the reveal phase early does
    ///      not move the cycle's deadline (see {_cycle}), so a reveal scheduled
    ///      against the nominal time still lands inside the window, and a
    ///      player who has not acted still has their full clock. Closing the
    ///      cycle early is only permitted once every commitment in it has been
    ///      revealed, so there is no window left to shorten - which is also why
    ///      a scheduled reveal that fires afterwards can only ever be a
    ///      duplicate, costing one reverted transaction, and never a missed
    ///      one, costing the stake.
    ///
    ///      The one thing it does take away is the chance to CANCEL a
    ///      commitment you have already made, since cancelling is a commit
    ///      phase action. That is not a window being shortened; it is what
    ///      committing means.
    function _advanceCycle()
        internal
        returns (uint64 cycleNumber, bool commiting)
    {
        if (CYCLE_POLICY == CyclePolicy.Timed) {
            // The cycle simply IS what the clock says, so there is nothing
            // here for anyone to do.
            revert NextPhaseNotAllowed();
        }

        Cycle memory cycle = _cycle();
        Attendance memory attendance = _attendance(cycle.cycleNumber);

        // C1: no closed set, no denominator. Without this, one caller could
        // push an empty game forward as fast as they liked.
        if (attendance.waitedFor == 0) {
            revert NoOneToWaitFor();
        }

        if (cycle.commiting) {
            if (attendance.committed < attendance.waitedFor) {
                revert StillWaitingToCommit(
                    attendance.committed,
                    attendance.waitedFor
                );
            }
            cycleNumber = cycle.cycleNumber;
            commiting = false;

            if (CYCLE_POLICY == CyclePolicy.Manual) {
                _cycleState.anchorCycleNumber = cycleNumber;
                _cycleState.commiting = false;
            } else {
                // The reveal window opens NOW and closes when it always would
                // have. Recording only that it opened early is what keeps the
                // deadline where it was.
                _cycleState.earlyRevealCycleNumber = cycleNumber;
                _cycleState.earlyRevealAt = uint64(_timestamp());
            }
        } else {
            // Everything committed in this cycle has been opened, so nothing
            // is left that the cycle could still be holding open for anyone.
            // Evaluated at execution time, which is what makes it airtight: a
            // reveal still in the mempool has not been counted, so an advance
            // mined before it reverts rather than stranding it.
            if (attendance.revealed < attendance.committed) {
                revert StillWaitingToReveal(
                    attendance.revealed,
                    attendance.committed
                );
            }
            cycleNumber = cycle.cycleNumber + 1;
            commiting = true;

            _cycleState.anchorCycleNumber = cycleNumber;
            if (CYCLE_POLICY == CyclePolicy.Manual) {
                _cycleState.commiting = true;
            } else {
                // The new cycle runs its full length from here, which is the
                // only way early advance makes a game with a clock finish a
                // cycle sooner than the clock would.
                _cycleState.anchoredAt = uint64(_timestamp());
            }
        }

        emit CycleAdvanced(cycleNumber, commiting, msg.sender);
    }

    //-------------------------------------------------------------------------
    // THE TWO SEAMS A GAME'S IDENTITY MODEL VARIES AT
    //-------------------------------------------------------------------------

    /// @notice WHO THE CALLER IS ACTING FOR, having checked that they may.
    /// @param sender The account or key that sent the transaction.
    /// @param id The identity, as the client named it.
    /// @return player The identity this submission is filed under, which is
    ///         what every mapping in {UsingGameStore} is keyed by.
    /// @dev THE SEAM. `virtual` and nothing else in this contract is, which is
    ///      deliberate: a game that keys by a token overrides this ONE function
    ///      and touches no store, no route and no other internal. The precedent
    ///      is bomber-world's `_epoch()` - THAT REPO'S OWN NAME, since it has
    ///      not been ported to this vocabulary - and the rule is N4 of Decision
    ///      3 in the plan on the `work` branch.
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

    /// @notice WHERE THE CYCLE IS. The seam the cycle policy varies at.
    /// @dev `virtual`, and it is the ONLY thing about the clock that is: a game
    ///      with a fourth policy overrides this one function and touches no
    ///      store, no route and no other internal. It replaced a virtual
    ///      `_cycleNumber()` returning only the pair, because a client has to
    ///      know when the phase ENDS in order to draw a countdown, and two
    ///      overridable views of one fact are two things to keep in step.
    ///      {_cycleNumber} is now derived from this rather than the other way
    ///      round.
    ///
    ///      ONE PIECE OF ARITHMETIC SERVES ALL THREE TIMED READINGS, because
    ///      they differ only in where the anchor is. The anchor is the start of
    ///      a cycle's COMMIT phase: for `Timed` it never moves from (cycle 2,
    ///      START_TIME), which is exactly the formula this template and four
    ///      other games have always used; for `TimedWithEarlyAdvance` an early
    ///      cycle advance moves it to the moment of the advance, and the clock
    ///      carries on from there. `Manual` has no clock at all, so the stored
    ///      state IS the answer.
    ///
    ///      Cycles start at 2 so that the hypothetical reveal phase before the
    ///      first commit phase can be cycle 1, which is also why zero can mean
    ///      "no commitment" in {Commitment}.
    function _cycle() internal view virtual returns (Cycle memory cycle) {
        CycleState memory state = _cycleState;
        bool anchored = state.anchorCycleNumber != 0;
        uint64 anchorCycleNumber = anchored ? state.anchorCycleNumber : 2;

        if (CYCLE_POLICY == CyclePolicy.Manual) {
            // No clock, so no phase bounds: zero here means "there is nothing
            // to count down to", which is a different statement from a
            // deadline that happens to be zero.
            return
                Cycle({
                    cycleNumber: anchorCycleNumber,
                    commiting: anchored ? state.commiting : true,
                    phaseStart: 0,
                    phaseEnd: 0
                });
        }

        uint256 anchoredAt = anchored ? state.anchoredAt : START_TIME;
        uint256 time = _timestamp();
        if (time < anchoredAt) {
            revert GameNotStarted();
        }

        uint256 cycleDuration = COMMIT_PHASE_DURATION + REVEAL_PHASE_DURATION;
        uint256 elapsed = time - anchoredAt;
        cycle.cycleNumber = anchorCycleNumber + uint64(elapsed / cycleDuration);
        cycle.commiting = (elapsed % cycleDuration) < COMMIT_PHASE_DURATION;

        uint256 cycleStart =
            anchoredAt +
                uint256(cycle.cycleNumber - anchorCycleNumber) * cycleDuration;

        // AN EARLY OPEN MOVES THE START AND NOT THE DEADLINE. The reveal window
        // becomes "as soon as everyone has committed, until the nominal end",
        // which is strictly wider than the window the clock alone would have
        // given: a reveal scheduled against the nominal time still lands inside
        // it. Shifting the deadline forward instead would lose exactly those
        // reveals, and lose them silently, at the cost of the stake.
        bool openedEarly =
            CYCLE_POLICY == CyclePolicy.TimedWithEarlyAdvance &&
                state.earlyRevealCycleNumber == cycle.cycleNumber;
        if (openedEarly) {
            cycle.commiting = false;
        }

        if (cycle.commiting) {
            cycle.phaseStart = uint64(cycleStart);
            cycle.phaseEnd = uint64(cycleStart + COMMIT_PHASE_DURATION);
        } else {
            cycle.phaseStart =
                openedEarly
                    ? state.earlyRevealAt
                    : uint64(cycleStart + COMMIT_PHASE_DURATION);
            cycle.phaseEnd = uint64(cycleStart + cycleDuration);
        }
    }

    /// @notice The cycle as everything inside this contract asks about it.
    /// @dev Deliberately NOT virtual: {_cycle} is the seam, and a second
    ///      overridable answer to the same question is a second thing to keep
    ///      in step with the first.
    function _cycleNumber()
        internal
        view
        returns (uint64 cycleNumber, bool commiting)
    {
        Cycle memory cycle = _cycle();
        return (cycle.cycleNumber, cycle.commiting);
    }

    /// @notice Check a chunk against the head of the chain it must open.
    /// @dev ONE ENCODING, ALWAYS, including for the last chunk of a turn, where
    ///      `furtherActions` is zero and is hashed in anyway. The design this is
    ///      ported from uses TWO - it drops the trailing field on the final
    ///      chunk - and both are sound against forgery, since substituting one
    ///      for the other is a preimage problem either way. The reason to take
    ///      the single form is on the CLIENT's side: the hash the client builds
    ///      has to match this byte for byte, a mismatch is not a compile error
    ///      and not a failed read (the commit succeeds and the reveal reverts
    ///      once the stake is already bonded), and a second encoding selected by
    ///      a branch on the very value that distinguishes the last chunk from
    ///      the rest is a second chance to get that wrong. Nothing is deployed
    ///      here, so the compatibility argument for the two-form version - it
    ///      leaves a one-chunk turn hashing exactly as it did before chaining -
    ///      buys nothing this repo needs.
    function _checkHash(
        bytes24 commitmentHash,
        Placement[] calldata placements,
        bytes32 secret,
        bytes24 furtherActions
    ) internal pure {
        bytes24 computedHash = bytes24(
            keccak256(abi.encode(secret, placements, furtherActions))
        );
        if (commitmentHash != computedHash) {
            revert CommitmentHashNotMatching();
        }
    }

    //-------------------------------------------------------------------------
}
