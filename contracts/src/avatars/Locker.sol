// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "solidity-kit/solc_0_8/ERC721/interfaces/IERC721Receiver.sol";
import "solidity-kit/solc_0_8/ERC721/interfaces/IERC721.sol";

contract Locker is IERC721Receiver {
    // ------------------------------------------------------------------------
    // ERRORS
    // ------------------------------------------------------------------------

    /// @notice happen when attempting to register an item already registered
    error AlreadyRegistered(IERC721 collection, uint256 tokenID);

    /// @notice happen when attempting to register an item not already owned
    error CannotRegisterUnlessOwned(IERC721 collection, uint256 tokenID);

    /// @notice happen when depositing with no owner specified (zero address)
    error OwnerRequired();

    /// @notice happen when depositing with no delegate specified (zero address)
    error DelegateRequired();

    /// @notice happen when trying to use token from locker with a non-authorized delegate
    error NotAuthorizedDelegate(address provided, address expected);

    /// @notice happen when trying to withdraw token from locker with an non-owner account
    error NotAuthorizedOwner(address provided, address expected);

    /// @notice happen when trying to use admin fucntion without being admin
    error NotAuthorizedAdmin(address provided, address expected);

    /// @notice happen when trying to use token in a contract not vetted
    error DestinatioNotVetted(address to);

    /// @notice happen when sending an item with invalid data
    error InvalidData();

    // ------------------------------------------------------------------------

    // ------------------------------------------------------------------------
    // EVENTS
    // ------------------------------------------------------------------------

    event AdminChanged(address newAdmin);

    event DestinationAdded(address destination);

    event DestinationRemoved(address destination);

    event ItemRegistered(
        IERC721 indexed collection,
        uint256 indexed tokenID,
        address indexed owner,
        address delegate
    );

    event ItemUnregistered(
        IERC721 indexed collection,
        uint256 indexed tokenID,
        address indexed owner,
        address delegate
    );

    // ------------------------------------------------------------------------
    // STORAGE
    // ------------------------------------------------------------------------
    address internal _admin;

    struct Item {
        address owner;
        address delegate;
    }

    mapping(IERC721 => mapping(uint256 => Item)) _registeredItems;

    mapping(address => bool) _vettedDestinations;
    // ------------------------------------------------------------------------

    // ------------------------------------------------------------------------
    // CONSTRUCTOR
    // ------------------------------------------------------------------------
    constructor(address admin) {
        _admin = admin;
    }
    // ------------------------------------------------------------------------

    // ------------------------------------------------------------------------
    // EXTERNAL
    // ------------------------------------------------------------------------

    function setAdmin(address newAdmin) external {
        if (msg.sender != _admin) {
            revert NotAuthorizedAdmin(msg.sender, _admin);
        }
        _admin = newAdmin;
        emit AdminChanged(newAdmin);
    }

    function addDestination(address to) external {
        if (msg.sender != _admin) {
            revert NotAuthorizedAdmin(msg.sender, _admin);
        }
        _vettedDestinations[to] = true;
        emit DestinationAdded(to);
    }

    function removeDestination(address to) external {
        if (msg.sender != _admin) {
            revert NotAuthorizedAdmin(msg.sender, _admin);
        }
        _vettedDestinations[to] = false;
        emit DestinationRemoved(to);
    }

    function deposit(
        IERC721 collection,
        uint256 tokenID,
        address from,
        address owner,
        address delegate
    ) external {
        _register(collection, tokenID, owner, delegate);

        collection.transferFrom(from, address(this), tokenID);
    }

    function register(
        IERC721 collection,
        uint256 tokenID,
        address owner,
        address delegate
    ) external {
        if (collection.ownerOf(tokenID) != address(this)) {
            revert CannotRegisterUnlessOwned(collection, tokenID);
        }

        if (_registeredItems[collection][tokenID].owner != address(0)) {
            revert AlreadyRegistered(collection, tokenID);
        }

        _register(collection, tokenID, owner, delegate);
    }

    function onERC721Received(
        address,
        address,
        uint256 tokenID,
        bytes calldata data
    ) external override returns (bytes4) {
        IERC721 collection = IERC721(msg.sender);

        if (data.length == 64) {
            (address owner, address delegate) = abi.decode(
                data,
                (address, address)
            );
            _register(collection, tokenID, owner, delegate);
            return IERC721Receiver.onERC721Received.selector;
        }
        revert InvalidData();
    }

    function safeTransfer(
        IERC721 collection,
        uint256 tokenID,
        address to,
        bytes calldata data
    ) external payable {
        Item memory item = _registeredItems[collection][tokenID];
        if (!_vettedDestinations[to]) {
            address owner = item.owner;
            if (owner != msg.sender) {
                revert NotAuthorizedOwner(msg.sender, owner);
            }
        } else {
            address delegate = item.delegate;
            if (delegate != msg.sender) {
                revert NotAuthorizedDelegate(msg.sender, delegate);
            }
        }

        _registeredItems[collection][tokenID] = Item({
            owner: address(0),
            delegate: address(0)
        });

        bytes memory dataToSend = bytes.concat(
            abi.encode(item.owner, item.delegate),
            data
        );

        emit ItemUnregistered(collection, tokenID, item.owner, item.delegate);

        collection.safeTransferFrom(address(this), to, tokenID, dataToSend);
    }
    // ------------------------------------------------------------------------

    // ------------------------------------------------------------------------
    // INTERNAL
    // ------------------------------------------------------------------------

    function _register(
        IERC721 collection,
        uint256 tokenID,
        address owner,
        address delegate
    ) internal {
        if (owner == address(0)) {
            revert OwnerRequired();
        }
        if (delegate == address(0)) {
            revert DelegateRequired();
        }

        _registeredItems[collection][tokenID] = Item({
            owner: owner,
            delegate: delegate
        });

        emit ItemRegistered(collection, tokenID, owner, delegate);
    }
    // ------------------------------------------------------------------------
}
