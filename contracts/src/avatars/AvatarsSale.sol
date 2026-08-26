// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "./SaleViaNativePayment.sol";
import "./Avatars.sol";

contract AvatarsSale is SaleViaNativePayment {
    constructor(
        Avatars items,
        Config memory config
    ) SaleViaNativePayment(items, config) {}

    function _executeMint(
        address to,
        uint96 subID,
        bytes calldata data
    ) internal override returns (uint256 tokenID) {
        (address owner, ) = abi.decode(data, (address, address));
        tokenID = (uint256(uint160(owner)) << 96) + subID;
        Avatars(address(ITEMS)).mint(to, tokenID, data);
    }
}
