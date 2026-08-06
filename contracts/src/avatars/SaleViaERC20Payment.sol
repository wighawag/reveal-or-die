// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@rocketh/proxy/solc_0_8/ERC1967/Proxied.sol";

import "solidity-kit/solc_0_8/ERC20/interfaces/IERC20.sol";

import "solidity-kit/solc_0_8/ERC721/interfaces/IERC721.sol";

interface IUniversalRouter {
    function execute(
        bytes calldata commands,
        bytes[] calldata inputs,
        uint256 deadline
    ) external payable;
}

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

abstract contract SaleViaERC20Payment is Proxied {
    error WrongPaymentAmount(uint256 amount, uint256 expected);
    error TransferFailed(
        IERC20 token,
        address from,
        address to,
        uint256 amount
    );
    error FailedToTransferNativeToken(address recipient);
    error InvalidPaymentToken(IERC20 token);
    error InsufficientTokenReceived(uint256 amount, uint256 expected);
    error NotFreeMapAdmin(address sender, address expected);

    event Mint(
        address indexed sender,
        address indexed to,
        address indexed referrer,
        uint256 tokenID
    );

    IERC721 public immutable ITEMS;
    IERC20 public immutable PAYMENT_TOKEN;
    uint256 public immutable PAYMENT_AMOUNT;
    address payable public immutable RECIPIENT;
    address public immutable FREE_MAP_ADMIN;

    IUniversalRouter public immutable UNIVERSAL_ROUTER;
    uint24 public immutable UNISWAP_FEE;
    address public immutable WETH;

    mapping(address => bool) public freemap;

    struct Config {
        uint256 paymentAmount;
        IERC20 paymentToken;
        address payable recipient;
        address freeMapAdmin;
        IUniversalRouter universalRouter;
        uint24 uniswapFee;
        address weth;
    }

    constructor(IERC721 items, Config memory config) {
        ITEMS = items;
        PAYMENT_AMOUNT = config.paymentAmount;
        PAYMENT_TOKEN = config.paymentToken;
        RECIPIENT = config.recipient;
        FREE_MAP_ADMIN = config.freeMapAdmin;
        UNIVERSAL_ROUTER = config.universalRouter;
        UNISWAP_FEE = config.uniswapFee;
        WETH = config.weth;

        if (address(PAYMENT_TOKEN) == address(0)) {
            revert InvalidPaymentToken(PAYMENT_TOKEN);
        }
    }

    function purchaseViaTokenWithPermit(
        address payable to,
        uint96 subID,
        bytes calldata data,
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s,
        address referrer
    ) external {
        if (!freemap[msg.sender]) {
            // Ensure the payment amount is valid
            if (amount != PAYMENT_AMOUNT) {
                revert WrongPaymentAmount(amount, PAYMENT_AMOUNT);
            }

            // Call permit on USDC to approve this contract to spend the user's tokens
            IERC20Permit(address(PAYMENT_TOKEN)).permit(
                msg.sender, // owner
                address(this), // spender
                amount, // value
                deadline, // deadline
                v,
                r,
                s // signature components
            );

            if (
                PAYMENT_TOKEN.transferFrom(
                    msg.sender,
                    RECIPIENT,
                    PAYMENT_AMOUNT
                ) == false
            ) {
                revert TransferFailed(
                    PAYMENT_TOKEN,
                    msg.sender,
                    RECIPIENT,
                    PAYMENT_AMOUNT
                );
            }
        } else {
            freemap[msg.sender] = false;
        }

        _mint(msg.sender, to, subID, referrer, data);
    }

    function purchaseViaApprovedToken(
        address payable to,
        uint96 subID,
        bytes calldata data,
        address referrer
    ) external {
        if (!freemap[msg.sender]) {
            if (
                PAYMENT_TOKEN.transferFrom(
                    msg.sender,
                    RECIPIENT,
                    PAYMENT_AMOUNT
                ) == false
            ) {
                revert TransferFailed(
                    PAYMENT_TOKEN,
                    msg.sender,
                    RECIPIENT,
                    PAYMENT_AMOUNT
                );
            }
        } else {
            freemap[msg.sender] = false;
        }

        _mint(msg.sender, to, subID, referrer, data);
    }

    function purchaseViaETH(
        address payable to,
        uint96 subID,
        bytes calldata data,
        uint256 deadline,
        address payable extraNativeTokenRecipient,
        uint256 extraNativeTokenAmount,
        address referrer
    ) external payable {
        uint256 paymentAmount = msg.value;
        if (extraNativeTokenRecipient != address(0)) {
            paymentAmount -= extraNativeTokenAmount;
            extraNativeTokenRecipient.transfer(extraNativeTokenAmount);
        }
        if (!freemap[msg.sender]) {
            // Commands:
            // 0x0B: WRAP_ETH (convert ETH to WETH)
            // 0x01: V3_SWAP_EXACT_OUT (perform exact output swap)
            // 0x0C: UNWRAP_WETH (convert any remaining WETH back to ETH)
            bytes memory commands = hex"0B010C";

            // Inputs for the commands
            bytes[] memory inputs = new bytes[](3);

            // Input for WRAP_ETH command
            // Parameters: (address recipient, uint256 amountMinimum)
            inputs[0] = abi.encode(
                address(UNIVERSAL_ROUTER), // Recipient - the router itself needs the WETH
                paymentAmount // Amount to wrap - all the ETH sent
            );

            // Construct the path for the swap in reverse order for exact output swaps: TOKEN -> WETH
            bytes memory path = abi.encodePacked(
                PAYMENT_TOKEN,
                UNISWAP_FEE,
                WETH
            );

            // Input for V3_SWAP_EXACT_OUT command
            // Parameters: (address recipient, uint256 amountOut, uint256 amountInMaximum, bytes path, bool payerIsUser)
            inputs[1] = abi.encode(
                RECIPIENT, // Recipient of USDC
                PAYMENT_AMOUNT, // Exact amount of USDC to receive
                paymentAmount, // Maximum amount of WETH to spend
                path,
                false // payerIsUser: false since we've have given WETH via UNWRAP already
            );

            // Input for UNWRAP_WETH command
            // Parameters: (address recipient, uint256 amountMinimum)
            inputs[2] = abi.encode(
                msg.sender, // Recipient of unwrapped ETH (the original caller)
                0 // Minimum amount to unwrap (0 means unwrap all remaining WETH)
            );

            // Execute the swap through Universal Router
            UNIVERSAL_ROUTER.execute{value: paymentAmount}(
                commands,
                inputs,
                deadline
            );
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

    /**
     * @notice Withdraw any tokens accidentally sent to this contract
     * @param token The token address to withdraw
     */
    function rescueTokens(address token) external onlyProxyAdmin {
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).transfer(_proxyAdmin(), balance);
    }

    /**
     * @notice Withdraw any ETH accidentally sent to this contract
     */
    function rescueETH() external onlyProxyAdmin {
        payable(_proxyAdmin()).transfer(address(this).balance);
    }

    receive() external payable {
        // TODO use proxy that can receive it
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
