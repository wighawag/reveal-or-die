// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "solidity-kit/solc_0_8/ERC721/implementations/EnumerableERC721.sol";

contract Avatars is EnumerableERC721 {
    constructor() {}

    function mint(
        address to,
        uint256 tokenID,
        bytes calldata data
    ) external payable {
        _safeMint(to, tokenID, false, data);
    }
}
