// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import "../internal/UsingGameInternal.sol";
import "../interfaces/IGame.sol";

contract GameGetters is IGameGetters, UsingGameInternal {
    using PositionUtils for uint64;

    constructor(Config memory config) UsingGameInternal(config) {}

    /// @inheritdoc IGameGetters
    function getEpoch() external view returns (uint64 epoch, bool commiting) {
        return _epoch();
    }

    /// @inheritdoc IGameGetters
    function getCommitment(
        address player
    ) external view returns (Commitment memory commitment) {
        return _commitments[player];
    }

    /// @inheritdoc IGameGetters
    function getReserve(address player) external view returns (uint256 amount) {
        return _reserve[player];
    }

    /// @inheritdoc IGameGetters
    function getConfig() external view returns (Config memory config) {
        config = Config({
            startTime: START_TIME,
            commitPhaseDuration: COMMIT_PHASE_DURATION,
            revealPhaseDuration: REVEAL_PHASE_DURATION,
            time: TIME,
            tokens: TOKENS,
            placementCost: PLACEMENT_COST
        });
    }

    /// @inheritdoc IGameGetters
    function getCell(uint64 cellID) external view returns (Cell memory cell) {
        return _cells[cellID];
    }

    /// @inheritdoc IGameGetters
    function getStakeOnCell(
        uint64 cellID,
        address player
    ) external view returns (uint256 stake) {
        return _stakeOnCellBy[cellID][player];
    }

    /// @inheritdoc IGameGetters
    function getCellsInZone(
        uint64 zone
    ) external view returns (CellAt[] memory cells, uint64 epoch) {
        uint64[] memory zones = new uint64[](1);
        zones[0] = zone;
        return _cellsInZones(zones);
    }

    /// @inheritdoc IGameGetters
    function getCellsInZones(
        uint64[] calldata zones
    ) external view returns (CellAt[] memory cells, uint64 epoch) {
        return _cellsInZones(zones);
    }

    /// @dev Walks every cell of every requested zone and returns the non-empty
    ///      ones. A zone is a fixed 16x16 block (see PositionUtils), so the
    ///      work is bounded by the number of zones asked for, which is what the
    ///      viewport covers. This is a view function, so the cost is the
    ///      caller's and is not paid on chain.
    function _cellsInZones(
        uint64[] memory zones
    ) internal view returns (CellAt[] memory cells, uint64 epoch) {
        (epoch, ) = _epoch();

        int32 zoneSize = PositionUtils.ZONE_SIZE;
        uint256 perZone = uint256(uint32(zoneSize)) * uint256(uint32(zoneSize));

        // Two passes: count, then fill. Cheaper than growing an array, and a
        // view call can afford to read twice.
        uint256 found = 0;
        for (uint256 z = 0; z < zones.length; z++) {
            (int32 zx, int32 zy) = zones[z].toXY();
            for (uint256 i = 0; i < perZone; i++) {
                uint64 cellID = _cellInZoneAt(zx, zy, i);
                if (_cells[cellID].totalStake != 0) {
                    found++;
                }
            }
        }

        cells = new CellAt[](found);
        uint256 n = 0;
        for (uint256 z = 0; z < zones.length; z++) {
            (int32 zx, int32 zy) = zones[z].toXY();
            for (uint256 i = 0; i < perZone; i++) {
                uint64 cellID = _cellInZoneAt(zx, zy, i);
                Cell storage cell = _cells[cellID];
                if (cell.totalStake != 0) {
                    cells[n] = CellAt({
                        cellID: cellID,
                        totalStake: cell.totalStake,
                        numClaimants: cell.numClaimants
                    });
                    n++;
                }
            }
        }
    }

    /// @dev The i-th cell of the zone whose coordinates are (zx, zy).
    function _cellInZoneAt(
        int32 zx,
        int32 zy,
        uint256 i
    ) internal pure returns (uint64) {
        int32 zoneSize = PositionUtils.ZONE_SIZE;
        int32 dx = int32(uint32(i % uint256(uint32(zoneSize))));
        int32 dy = int32(uint32(i / uint256(uint32(zoneSize))));
        int32 originX = zx * zoneSize - PositionUtils.ZONE_OFFSET;
        int32 originY = zy * zoneSize - PositionUtils.ZONE_OFFSET;
        return PositionUtils.fromXY(originX + dx, originY + dy);
    }
}
