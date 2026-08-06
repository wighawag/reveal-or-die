// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import "solidity-kit/solc_0_8/ERC20/implementations/ERC20Base.sol";

/// @notice The token players stake in order to place.
/// @dev Freely mintable, because this is a template: a real game replaces this
///      with whatever it actually wants at stake, or points the game at an
///      existing token. The game contract only ever sees IERC20.
contract GameToken is ERC20Base {
    string public constant name = "Game Token";
    string public constant symbol = "GAME";

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
