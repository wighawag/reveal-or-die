// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "../interfaces/UsingGameTypes.sol";
import "../../utils/PositionUtils.sol";
import "../data/generated/Areas.sol";

library GameUtils {
    /// @notice plain ground: walkable, and nothing else
    uint256 internal constant CELL_FLOOR = 0;
    /// @notice `#` in the ascii source: cannot be stood on
    uint256 internal constant CELL_WALL = 1;
    /// @notice `x` in the ascii source: cannot be stood on
    uint256 internal constant CELL_BOX = 2;
    /// @notice `!` in the ascii source: the way out, and walkable
    uint256 internal constant CELL_EXIT = 3;

    function computeArea(
        bytes32 areaHash
    ) internal pure returns (UsingGameTypes.Area memory) {
        // "made only for 16x16"
        assert(PositionUtils.ZONE_SIZE == 16);
        return Areas.getAreaFromHash(areaHash);
    }

    function areaAt(
        int32 x,
        int32 y
    ) internal pure returns (UsingGameTypes.Area memory area) {
        // TODO add in genesis hash ?
        (int32 areaX, int32 areaY) = PositionUtils.zoneCoords(x, y);
        area = computeArea(keccak256(abi.encodePacked(areaX, areaY)));
    }

    /// @notice The two bits the area packs for one cell.
    /// @dev The unpacking was written out once per question - obstacle, wall,
    ///  box - and each new question copied it again. One copy, asked four ways
    ///  below: the same shape `js/zones.ts` has, where `cellTypeAt` is split out
    ///  of `isObstacle` so drawing the map and judging a move read one lookup.
    function cellAt(
        UsingGameTypes.Area memory area,
        int32 x,
        int32 y
    ) internal pure returns (uint256) {
        uint8 xx = PositionUtils.zoneLocalCoord(x);
        uint8 yy = PositionUtils.zoneLocalCoord(y);
        uint8 i = yy * uint8(int8(PositionUtils.ZONE_SIZE)) + xx;
        uint8 MID = uint8(
            int8((PositionUtils.ZONE_SIZE * PositionUtils.ZONE_SIZE) / 2)
        );
        if (i < MID) {
            return ((area.firstBytes32 >> (254 - i * 2)) & 0x3);
        } else {
            return ((area.secondBytes32 >> (254 - (i - MID) * 2)) & 0x3);
        }
    }

    function obstacleAt(
        UsingGameTypes.Area memory area,
        int32 x,
        int32 y
    ) internal pure returns (bool) {
        uint256 cellType = cellAt(area, x, y);
        return cellType == CELL_WALL || cellType == CELL_BOX;
    }

    function wallAt(
        UsingGameTypes.Area memory area,
        int32 x,
        int32 y
    ) internal pure returns (bool) {
        return cellAt(area, x, y) == CELL_WALL;
    }

    function boxAt(
        UsingGameTypes.Area memory area,
        int32 x,
        int32 y
    ) internal pure returns (bool) {
        return cellAt(area, x, y) == CELL_BOX;
    }

    /// @notice Whether this cell is the way out of the world.
    /// @dev The rule `_exit` enforces. The map has drawn an exit tile since
    ///  before the contract checked for one, so the tile was decoration and
    ///  leaving worked from anywhere.
    function exitAt(
        UsingGameTypes.Area memory area,
        int32 x,
        int32 y
    ) internal pure returns (bool) {
        return cellAt(area, x, y) == CELL_EXIT;
    }
}
