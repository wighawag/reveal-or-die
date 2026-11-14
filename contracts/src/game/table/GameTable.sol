// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.21;

import "./UsingGameTable.sol";
import "./IGameTable.sol";

/// @title The table's own route (stratagems' plan, step R1b): an ETH seat,
///        the close, the leftovers
/// @dev Behind the table implementation's router only; the world has none.
contract GameTable is IGameTable, UsingGameTable {
    constructor(
        Config memory config,
        uint256 tableStake
    ) UsingGameInternal(config) UsingGameTable(tableStake) {}

    function join(address payable stipendTo, uint256 stipend) external payable {
        _join(msg.sender, msg.value, stipendTo, stipend);
    }

    function closeTable() external {
        _closeTable();
    }

    function releaseLeftover(uint256 body) external {
        _releaseLeftover(body);
    }

    function getTable() external view returns (TableState memory state) {
        TableLayout storage $ = _table();
        state.mode = uint8(uint256(_gameOptions()));
        state.stake = TABLE_STAKE;
        state.started = _roster().started;
        state.closed = $.closed;
        state.endCycle = $.endCycle;
        state.survivors = $.survivors;
        state.leftovers = $.leftovers;
        state.leftoverPot = $.leftoverPot;
        uint256 numSeated = $.seated.length;
        state.seated = numSeated;
        (uint64 cycleNumber, ) = _cycleNumber();
        for (uint256 i = 0; i < numSeated; i++) {
            if (_getResolvedAvatar($.seated[i], cycleNumber).life != 0) {
                state.alive++;
            }
        }
    }

    function getSeated() external view returns (uint256[] memory) {
        return _table().seated;
    }

    function getCycle() external view returns (Cycle memory) {
        return _cycle();
    }
}
