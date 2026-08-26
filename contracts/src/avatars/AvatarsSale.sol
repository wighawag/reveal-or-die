// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "./SaleViaNativePayment.sol";
import "./Avatars.sol";

contract AvatarsSale is SaleViaNativePayment {
    constructor(
        Avatars items,
        Config memory config
    ) SaleViaNativePayment(items, config) {}

    /// @dev `data` is the deposit payload forwarded verbatim to the receiver,
    ///      and it is now a single `address owner` rather than the old
    ///      `(owner, controller)` pair: who may PLAY an avatar is delegation,
    ///      account-wide, not an address named at purchase time. The tokenID is
    ///      derived from that owner, so the two must stay in step - decoding a
    ///      pair here against a 32-byte payload reverts inside `abi.decode`,
    ///      which surfaces from behind the proxy as the thoroughly unhelpful
    ///      "function selector was not recognized".
    function _executeMint(
        address to,
        uint96 subID,
        bytes calldata data
    ) internal override returns (uint256 tokenID) {
        address owner = abi.decode(data, (address));
        tokenID = (uint256(uint160(owner)) << 96) + subID;
        Avatars(address(ITEMS)).mint(to, tokenID, data);
    }
}
