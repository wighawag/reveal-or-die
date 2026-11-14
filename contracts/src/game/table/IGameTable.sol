// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import "../interfaces/UsingGameTypes.sol";

/// @title A table's own route: the ETH seat, the close, the leftovers, and
///        what the client reads of them (stratagems' plan, step R1b)
interface IGameTable is UsingGameTypes {
    struct TableState {
        /// @notice 0 avatar mode, 1 ETH mode, as the options say (the routes
        ///         refuse any other where they read it)
        uint8 mode;
        /// @notice what every seat risks, in ETH
        uint256 stake;
        bool started;
        bool closed;
        /// @notice the cycle survivors are judged at, once closed
        uint64 endCycle;
        /// @notice the seats, including the dead and a forfeited member
        uint256 seated;
        /// @notice how many seats are alive now, or at the end cycle once closed
        uint256 alive;
        /// @notice once closed: how many survived, how many bodies nobody
        ///         claimed are still to release, and what those released hold
        uint256 survivors;
        uint256 leftovers;
        uint256 leftoverPot;
    }

    /// @notice Take a seat at an ETH-mode table, paying exactly its stake.
    ///         The seat's id is the caller's address.
    function join() external payable;

    /// @notice Close the table, by anyone, once its last cycle has passed or
    ///         at most one seat is alive (in a commit phase nobody living has
    ///         committed in).
    function closeTable() external;

    /// @notice Release a dead seat's body nobody claimed, by anyone, after the
    ///         close: into the survivors' pot, or to its owner if none survived.
    function releaseLeftover(uint256 body) external;

    function getTable() external view returns (TableState memory);

    /// @notice every seat, dead or alive, in no order
    function getSeated() external view returns (uint256[] memory);

    /// @notice the base's cycle, with its phase's bounds: a table advances
    ///         early, so its client reads the clock rather than computing it
    function getCycle() external view returns (Cycle memory);
}
