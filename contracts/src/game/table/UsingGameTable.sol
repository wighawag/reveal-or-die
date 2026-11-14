// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.21;

import "../internal/UsingGameInternal.sol";

/// @title What a TABLE adds to reveal-or-die: a mode, a stake a seat, no exit,
///        a death clock from the start, a close, and the leftovers
/// @dev THE WORLD NEVER INHERITS THIS (stratagems' plan, step R1b, R1b-11):
///      only the table implementation's routes do (`GameTableRoutes.sol` and
///      `GameTable.sol`), so the world's routes compile exactly as before, and
///      every hook below is an override of an internal virtual function,
///      resolved at compile time.
///
///      - THE MODE (R1b-1) is the table's `gameOptions` (the base stores it,
///        opaque): `{uint8 mode}` in its lowest byte, every other byte zero, 0
///        for AVATAR mode and 1 for ETH mode. Refused where it is read: a
///        deposit, a join, and through them every seat, so a table created
///        with options it cannot read seats nobody.
///      - THE STAKE (R1b-2, R1b-3, R1b-4) is the deployment's, `TABLE_STAKE`.
///        In avatar mode the seat is an avatar deposited, which must carry
///        exactly that stake; in ETH mode it is `join()`, paying exactly that,
///        and the seat's id is the account's address, one seat per account.
///      - THE DEATH CLOCK STARTS AT THE TABLE'S START (R1b-5): a seated avatar
///        that never enters reads as if it had last revealed in the cycle
///        before the first, so it dies after the same allowance as one that
///        enters and goes quiet ({_getResolvedAvatar}).
///      - NO EXIT (R1b-6): an Exit is dropped as any refused action is, and
///        nobody withdraws between the start and the close.
///      - THE CLOSE (R1b-7) fixes the end cycle, the survivors and the
///        leftovers once, after which every read of an avatar is at the end
///        cycle and nobody commits.
///      - THE LEFTOVERS (R1b-9, R1b-10): a dead seat's body nobody claimed is
///        released by anyone after the close, into a pot the survivors share,
///        or to its own owner when nobody survived.
///
///      THE SEATED LIST IS THE TABLE'S OWN (R1b-8): the base's members shrink
///      on a creator's forfeit, and a forfeited member's body is a leftover
///      like any other. Pushed at a seat, removed only by a withdrawal before
///      the start; at most the table's seats, so every loop over it is bounded.
abstract contract UsingGameTable is UsingGameInternal {
    uint8 internal constant MODE_AVATAR = 0;
    uint8 internal constant MODE_ETH = 1;

    /// @notice the table's options are not `{uint8 mode}` with a known mode
    error InvalidTableOptions(bytes32 gameOptions);
    /// @notice this way of taking a seat is the other mode's
    error WrongTableMode(uint8 mode);
    /// @notice a seat risks exactly the table's stake
    error TableStakeMismatch(uint256 expected, uint256 given);
    /// @notice a stipend with nobody to send it to
    error NoStipendRecipient(uint256 stipend);
    /// @notice an account takes one seat in ETH mode
    error AlreadySeated(uint256 seat);
    /// @notice the table has not started
    error TableNotStarted();
    /// @notice the table is closed: nobody commits any more
    error TableIsClosed();
    /// @notice nothing leaves the table between its start and its close
    error TableNotClosed();
    /// @notice more than one is alive and the last cycle has not passed
    error TableStillPlaying(uint256 alive);
    /// @notice a living seat has a commitment in this cycle: close in the next
    error TableCommitmentOpen(uint256 seat);
    /// @notice a survivor is paid once every leftover is released
    error LeftoversPending(uint256 leftovers);
    /// @notice not a dead seat's body nobody claimed, or already released
    error NotALeftover(uint256 body);
    /// @notice nothing is held here for this seat any more
    error NothingToWithdraw(uint256 seat);

    /// @notice The table closed: who is judged alive at `endCycle`, and how
    ///         many bodies nobody claimed are left to release.
    event TableClosed(uint64 endCycle, uint256 survivors, uint256 leftovers);
    /// @notice A body nobody claimed was released: into the survivors' pot,
    ///         or paid to `paidTo`, its owner, when nobody survived.
    event LeftoverReleased(uint256 indexed body, uint256 pot, address paidTo);
    /// @notice A survivor took its seat home: `amount` in ETH (the avatar
    ///         itself too, in avatar mode).
    event WinningsPaid(uint256 indexed seat, address to, uint256 amount);

    /// @custom:storage-location erc7201:reveal-or-die.storage.Table
    struct TableLayout {
        uint256[] seated;
        mapping(uint256 seat => uint256 indexPlusOne) seatIndex;
        bool closed;
        uint64 endCycle;
        uint256 survivors;
        uint256 leftovers;
        uint256 leftoverPot;
    }

    /// keccak256(abi.encode(uint256(keccak256("reveal-or-die.storage.Table")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant TABLE_STORAGE =
        0x8980533d52a5994224d636728b56728986694a650daa110c1a5a3022af2f6200;

    function _table() internal pure returns (TableLayout storage $) {
        assembly {
            $.slot := TABLE_STORAGE
        }
    }

    /// @notice what every seat risks, in ETH
    uint256 internal immutable TABLE_STAKE;

    constructor(uint256 tableStake) {
        TABLE_STAKE = tableStake;
    }

    //-------------------------------------------------------------------------
    // THE MODE
    //-------------------------------------------------------------------------

    function _mode() internal view returns (uint8 mode) {
        bytes32 options = _gameOptions();
        mode = uint8(uint256(options));
        if (uint256(options) >> 8 != 0 || mode > MODE_ETH) {
            revert InvalidTableOptions(options);
        }
    }

    function _requireMode(uint8 mode) internal view {
        uint8 actual = _mode();
        if (actual != mode) {
            revert WrongTableMode(actual);
        }
    }

    //-------------------------------------------------------------------------
    // A SEAT
    //-------------------------------------------------------------------------

    /// @dev AVATAR MODE: an avatar carrying exactly the table's stake.
    function _deposit(
        uint256 avatarID,
        address owner
    ) internal virtual override {
        _requireMode(MODE_AVATAR);
        uint256 stake = IAvatarsWithStake(address(AVATARS)).stakeOf(avatarID);
        if (stake != TABLE_STAKE) {
            revert TableStakeMismatch(TABLE_STAKE, stake);
        }
        _seat(avatarID, owner);
    }

    /// @dev ETH MODE: the account's own seat, paid for with exactly the stake.
    ///      Its id is the account's address, which no avatar id can be (they
    ///      carry their owner above the 96th bit), and which is why an account
    ///      has one seat.
    ///
    ///      AND OPTIONALLY THE KEY THAT PLAYS IT: `stipend` of the value is
    ///      forwarded to `stipendTo` in the same transaction, as the avatars'
    ///      sale does, so taking a seat funds this browser's signer (which then
    ///      authorises itself) rather than leaving a second transaction to send.
    ///      Sent last, after the seat is taken.
    function _join(
        address account,
        uint256 value,
        address payable stipendTo,
        uint256 stipend
    ) internal {
        _requireMode(MODE_ETH);
        if (stipendTo == address(0) && stipend != 0) {
            revert NoStipendRecipient(stipend);
        }
        if (value != TABLE_STAKE + stipend) {
            revert TableStakeMismatch(TABLE_STAKE + stipend, value);
        }
        uint256 seat = uint256(uint160(account));
        if (_players[seat].owner != address(0)) {
            revert AlreadySeated(seat);
        }
        _seat(seat, account);
        if (stipend != 0) {
            _pay(stipendTo, stipend);
        }
    }

    function _seat(uint256 seat, address owner) internal {
        // the base refuses a seat after the start, and past the table's seats
        UsingGameInternal._deposit(seat, owner);
        TableLayout storage $ = _table();
        $.seated.push(seat);
        $.seatIndex[seat] = $.seated.length;
    }

    function _unseat(uint256 seat) internal {
        TableLayout storage $ = _table();
        uint256 index = $.seatIndex[seat] - 1;
        uint256 last = $.seated.length - 1;
        if (index != last) {
            uint256 moved = $.seated[last];
            $.seated[index] = moved;
            $.seatIndex[moved] = index + 1;
        }
        $.seated.pop();
        delete $.seatIndex[seat];
    }

    function _removeOwned(address owner, uint256 seat) internal {
        uint256[] storage owned = _ownedAvatars[owner];
        uint256 last = owned.length - 1;
        uint256 index = _ownedAvatarsIndex[seat];
        if (index != last) {
            uint256 moved = owned[last];
            owned[index] = moved;
            _ownedAvatarsIndex[moved] = index;
        }
        delete _ownedAvatarsIndex[seat];
        owned.pop();
    }

    //-------------------------------------------------------------------------
    // PLAYING
    //-------------------------------------------------------------------------

    /// @dev Nobody commits once the table is closed, even before its last
    ///      cycle (the base refuses after that one by itself).
    function _commitTurn(
        address sender,
        uint256 avatarID,
        bytes24 commitmentHash
    ) internal virtual override {
        if (_table().closed) {
            revert TableIsClosed();
        }
        super._commitTurn(sender, avatarID, commitmentHash);
    }

    /// @dev NO EXIT AT A TABLE (R-2): dropped, and the turn ends there, as any
    ///      action the rules refuse.
    function _exit(
        ActionResolution memory resolution,
        uint256
    ) internal pure virtual override {
        resolution.stopProcessing = true;
    }

    /// @dev TWO THINGS ONLY A TABLE HAS. After the close every read is at the
    ///      end cycle, so a survivor stays one whatever the clock says. And a
    ///      seat that never entered dies on the same clock as one that entered
    ///      and went quiet, counted from the cycle before the first: out of the
    ///      world it would read as alive for ever, and could wait there to enter
    ///      at the last cycle and survive (R1b-5).
    function _getResolvedAvatar(
        uint256 avatarID,
        uint64 cycleNumber
    ) internal view virtual override returns (AvatarResolved memory resolved) {
        TableLayout storage $ = _table();
        if ($.closed && cycleNumber > $.endCycle) {
            cycleNumber = $.endCycle;
        }
        resolved = super._getResolvedAvatar(avatarID, cycleNumber);
        if (!resolved.inGame && $.seatIndex[avatarID] != 0) {
            uint64 last = _lastCycleNumber();
            if (last != 0) {
                uint64 diesAfter =
                    _firstCycleNumber(last) + uint64(NUM_MISSES_ALLOWED);
                if (cycleNumber > diesAfter) {
                    resolved.life = 0;
                    resolved.lastCycleNumber = diesAfter;
                }
            }
        }
    }

    /// @dev The first cycle the table plays, from the last the start fixed.
    function _firstCycleNumber(uint64 last) internal view returns (uint64) {
        return last + 1 - _roster().cycles;
    }

    //-------------------------------------------------------------------------
    // BODIES
    //-------------------------------------------------------------------------

    /// @dev The world's release, but for where the stake comes from: in ETH
    ///      mode it was paid at `join` and is already here, and a seat that
    ///      never entered has no place on the board to leave.
    function _releaseBody(
        uint256 body,
        Body storage state
    ) internal virtual override {
        uint256 open = _openClaims[body].length;
        if (open != 0) {
            revert BodyHasOpenClaims(body, open);
        }
        uint256 stake;
        if (_mode() == MODE_ETH) {
            stake = TABLE_STAKE;
        } else {
            uint256 before = address(this).balance;
            IAvatarsWithStake(address(AVATARS)).burn(
                body,
                abi.encodeCall(IStakeReceiver.receiveStake, ())
            );
            stake = address(this).balance - before;
        }
        uint256 pot = stake + _carried[body];
        delete _carried[body];
        state.released = true;
        state.pot = pot;

        if (_avatars[body].inGame) {
            _removeFromZone(
                PositionUtils.getZone(_avatars[body].position),
                body
            );
        }
        emit BodyReleased(body, pot);
    }

    function _getBody(
        uint256 body
    ) internal view virtual override returns (PublicBody memory result) {
        result = super._getBody(body);
        if (!result.released && _mode() == MODE_ETH) {
            result.value = TABLE_STAKE + _carried[body];
        }
    }

    //-------------------------------------------------------------------------
    // THE CLOSE AND THE LEFTOVERS
    //-------------------------------------------------------------------------

    /// @notice Close the table, by anyone, once its last cycle has passed or
    ///         at most one seat is alive.
    /// @dev THE END CYCLE IS FIXED, never "now": after the last cycle nobody
    ///      commits, so every seat would die if the clock judged them later.
    ///      Past the last cycle it is the one after it; on an early close it is
    ///      the current one, closed only in its commit phase and only while no
    ///      living seat has committed in it, so no reveal follows the close and
    ///      no body is claimed after it: the leftovers counted here are final.
    function _closeTable() internal {
        Roster memory roster = _roster();
        if (!roster.started) {
            revert TableNotStarted();
        }
        TableLayout storage $ = _table();
        if ($.closed) {
            revert TableIsClosed();
        }
        (uint64 cycleNumber, bool commiting) = _cycleNumber();
        uint64 last = _lastCycleNumber();
        bool early = cycleNumber <= last;
        uint64 endCycle = early ? cycleNumber : last + 1;
        if (early && !commiting) {
            revert InRevealPhase(cycleNumber);
        }

        uint256 alive;
        uint256 leftovers;
        uint256 numSeated = $.seated.length;
        for (uint256 i = 0; i < numSeated; i++) {
            uint256 seat = $.seated[i];
            if (_getResolvedAvatar(seat, endCycle).life != 0) {
                alive++;
                if (early && _commitmentOf(seat).cycleNumber == cycleNumber) {
                    revert TableCommitmentOpen(seat);
                }
            } else if (_bodies[seat].firstClaimCycle == 0) {
                leftovers++;
            }
        }
        if (early && alive > 1) {
            revert TableStillPlaying(alive);
        }

        $.closed = true;
        $.endCycle = endCycle;
        $.survivors = alive;
        $.leftovers = leftovers;
        emit TableClosed(endCycle, alive, leftovers);
    }

    /// @notice Release a dead seat's body that nobody claimed, by anyone.
    /// @dev Refused while the body has claims of its own open, as any release
    ///      is ({_releaseBody}): its chain is settled from the bottom up first.
    function _releaseLeftover(uint256 body) internal {
        TableLayout storage $ = _table();
        if (!$.closed) {
            revert TableNotClosed();
        }
        Body storage state = _bodies[body];
        if (
            $.seatIndex[body] == 0 ||
            state.released ||
            state.firstClaimCycle != 0 ||
            _getResolvedAvatar(body, $.endCycle).life != 0
        ) {
            revert NotALeftover(body);
        }
        _releaseBody(body, state);
        $.leftovers--;
        uint256 pot = state.pot;
        if ($.survivors == 0) {
            // NOBODY SURVIVED (R1b-10): each body goes back to its owner.
            address owner = _players[body].owner;
            emit LeftoverReleased(body, pot, owner);
            _pay(owner, pot);
        } else {
            $.leftoverPot += pot;
            emit LeftoverReleased(body, pot, address(0));
        }
    }

    //-------------------------------------------------------------------------
    // LEAVING
    //-------------------------------------------------------------------------

    /// @dev BEFORE THE START a seat may leave, and the stake goes with it. FROM
    ///      THE START TO THE CLOSE nobody leaves. AFTER THE CLOSE a survivor,
    ///      once every leftover is released, takes its stake (the avatar itself
    ///      in avatar mode), what it collected, and its share of the leftovers;
    ///      the rounding remainder stays in the game. The dead get nothing.
    function _withdraw(
        address owner,
        uint256 seat,
        address to
    ) internal virtual override {
        if (!_roster().started) {
            if (_mode() == MODE_AVATAR) {
                super._withdraw(owner, seat, to);
            } else {
                if (_players[seat].owner != owner) {
                    revert UsingGameErrors.NotAuthorizedOwner(owner);
                }
                if (!_players[seat].inCustody) {
                    revert NothingToWithdraw(seat);
                }
                _removeOwned(owner, seat);
                _leaveSeat(seat);
                _players[seat].inCustody = false;
                _pay(to, TABLE_STAKE);
            }
            _unseat(seat);
            return;
        }

        TableLayout storage $ = _table();
        if (!$.closed) {
            revert TableNotClosed();
        }
        Player memory player = _players[seat];
        if (player.owner != owner) {
            revert UsingGameErrors.NotAuthorizedOwner(owner);
        }
        if (!player.inCustody) {
            revert NothingToWithdraw(seat);
        }
        if (_getResolvedAvatar(seat, $.endCycle).life == 0) {
            revert AvatarIsDead(seat);
        }
        if ($.leftovers != 0) {
            revert LeftoversPending($.leftovers);
        }

        uint256 amount = _carried[seat] + $.leftoverPot / $.survivors;
        delete _carried[seat];
        _removeOwned(owner, seat);
        _players[seat].inCustody = false;

        if (_mode() == MODE_AVATAR) {
            AVATARS.safeTransferFrom(address(this), to, seat);
        } else {
            amount += TABLE_STAKE;
        }
        emit WinningsPaid(seat, to, amount);
        if (amount != 0) {
            _pay(to, amount);
        }
    }
}
