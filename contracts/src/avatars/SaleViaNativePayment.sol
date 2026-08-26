// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@rocketh/proxy/solc_0_8/ERC1967/Proxied.sol";

import "solidity-kit/solc_0_8/ERC20/interfaces/IERC20.sol";

import "solidity-kit/solc_0_8/ERC721/interfaces/IERC721.sol";

interface IERC20Permit {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

abstract contract SaleViaNativePayment is Proxied {
    error ExpectNativeToken();
    error WrongPaymentAmount(uint256 amount, uint256 expected);
    error TransferFailed(
        IERC20 token,
        address from,
        address to,
        uint256 amount
    );
    error FailedToTransferNativeToken(address recipient);
    error NotFreeMapAdmin(address sender, address expected);

    event Mint(
        address indexed sender,
        address indexed to,
        address indexed referrer,
        uint256 tokenID
    );

    IERC721 public immutable ITEMS;
    uint256 public immutable PAYMENT_AMOUNT;
    address payable public immutable RECIPIENT;
    address public immutable FREE_MAP_ADMIN;

    mapping(address => bool) public freemap;

    struct Config {
        uint256 paymentAmount;
        address payable recipient;
        address freeMapAdmin;
    }

    constructor(IERC721 items, Config memory config) {
        ITEMS = items;
        PAYMENT_AMOUNT = config.paymentAmount;
        RECIPIENT = config.recipient;
        FREE_MAP_ADMIN = config.freeMapAdmin;
    }

    // function purchaseViaTokenWithPermit(
    //     address payable to,
    //     bytes calldata data,
    //     uint256 amount,
    //     uint256 deadline,
    //     uint8 v,
    //     bytes32 r,
    //     bytes32 s,
    //     address referrer
    // ) external {
    //     if (!freemap[msg.sender]) {
    //         // Commands:
    //         // 0x0B: WRAP_ETH (convert ETH to WETH)
    //         // 0x01: V3_SWAP_EXACT_OUT (perform exact output swap)
    //         // 0x0C: UNWRAP_WETH (convert any remaining WETH back to ETH)
    //         bytes memory commands = hex"0B010C";

    //         // Inputs for the commands
    //         bytes[] memory inputs = new bytes[](3);

    //         // Input for WRAP_ETH command
    //         // Parameters: (address recipient, uint256 amountMinimum)
    //         inputs[0] = abi.encode(
    //             address(UNIVERSAL_ROUTER), // Recipient - the router itself needs the WETH
    //             msg.value // Amount to wrap - all the ETH sent
    //         );

    //         // Construct the path for the swap in reverse order for exact output swaps: TOKEN -> WETH
    //         bytes memory path = abi.encodePacked(PAYMENT_TOKEN, UNISWAP_FEE, WETH);

    //         // Input for V3_SWAP_EXACT_OUT command
    //         // Parameters: (address recipient, uint256 amountOut, uint256 amountInMaximum, bytes path, bool payerIsUser)
    //         inputs[1] = abi.encode(
    //             RECIPIENT, // Recipient of USDC
    //             PAYMENT_AMOUNT, // Exact amount of USDC to receive
    //             msg.value, // Maximum amount of WETH to spend
    //             path,
    //             false // payerIsUser: false since we've have given WETH via UNWRAP already
    //         );

    //         // Input for UNWRAP_WETH command
    //         // Parameters: (address recipient, uint256 amountMinimum)
    //         inputs[2] = abi.encode(
    //             msg.sender, // Recipient of unwrapped ETH (the original caller)
    //             0 // Minimum amount to unwrap (0 means unwrap all remaining WETH)
    //         );

    //         // Execute the swap through Universal Router
    //         UNIVERSAL_ROUTER.execute{value: msg.value}(commands, inputs, deadline);

    //         _mint(msg.sender, to, referrer, data);

    //         // Call permit on USDC to approve this contract to spend the user's tokens
    //         IERC20Permit(address(PAYMENT_TOKEN)).permit(
    //             msg.sender, // owner
    //             address(this), // spender
    //             amount, // value
    //             deadline, // deadline
    //             v,
    //             r,
    //             s // signature components
    //         );

    //         if (PAYMENT_TOKEN.transferFrom(msg.sender, RECIPIENT, PAYMENT_AMOUNT) == false) {
    //             revert TransferFailed(PAYMENT_TOKEN, msg.sender, RECIPIENT, PAYMENT_AMOUNT);
    //         }
    //     } else {
    //         freemap[msg.sender] = false;
    //     }

    //     _mint(msg.sender, to, referrer, data);
    // }

    function purchase(
        address payable to,
        uint96 subID,
        bytes calldata data,
        address payable extraNativeTokenRecipient,
        uint256 extraNativeTokenAmount,
        address referrer
    ) external payable {
        uint256 paymentAmount = msg.value;
        if (extraNativeTokenRecipient != address(0)) {
            paymentAmount -= extraNativeTokenAmount;
            (bool success, ) = extraNativeTokenRecipient.call{
                value: extraNativeTokenAmount
            }("");
            if (!success) {
                revert FailedToTransferNativeToken(extraNativeTokenRecipient);
            }
        }
        if (!freemap[msg.sender]) {
            if (paymentAmount != PAYMENT_AMOUNT) {
                revert WrongPaymentAmount(paymentAmount, PAYMENT_AMOUNT);
            }
            // TODO RECIPIENT support sending it to destination
            RECIPIENT.transfer(paymentAmount);
        } else {
            freemap[msg.sender] = false;
            if (paymentAmount != 0) {
                revert WrongPaymentAmount(paymentAmount, 0);
            }
        }

        _mint(msg.sender, to, subID, referrer, data);
    }

    function addToFreeMap(address[] calldata addresses) external {
        if (msg.sender != FREE_MAP_ADMIN) {
            revert NotFreeMapAdmin(msg.sender, FREE_MAP_ADMIN);
        }

        for (uint256 i = 0; i < addresses.length; i++) {
            freemap[addresses[i]] = true;
        }
    }

    function removeFromFreeMap(address[] calldata addresses) external {
        if (msg.sender != FREE_MAP_ADMIN) {
            revert NotFreeMapAdmin(msg.sender, FREE_MAP_ADMIN);
        }

        for (uint256 i = 0; i < addresses.length; i++) {
            freemap[addresses[i]] = false;
        }
    }

    function _mint(
        address sender,
        address payable to,
        uint96 subID,
        address referrer,
        bytes calldata data
    ) internal {
        uint256 tokenID = _executeMint(to, subID, data);
        emit Mint(sender, to, referrer, tokenID);
    }

    function _executeMint(
        address to,
        uint96 subID,
        bytes calldata data
    ) internal virtual returns (uint256 tokenID);
}
