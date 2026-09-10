// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import "./GameAvatars.sol";

/// @notice Acquiring what lets you play, in ONE transaction.
/// @dev THE SAME SHAPE AS `StakeSale` ON `main`, AND THAT IS THE POINT. This
///      branch changes what a player acquires (an avatar minted into the
///      game's custody, rather than an ERC20 bond credited to their reserve)
///      and changes nothing about the rail above it: `purchase(owner,
///      stipendTo, stipend)` is the same call with the same arguments and the
///      same value split, so `$lib/game/acquire` and this game's
///      `placement/acquisition.ts` see a sale rather than a mint.
///
///      `main`'s own words about `StakeSale` predicted this file: "a real game
///      replaces this contract with whatever actually gates entry (selling a
///      token, minting an NFT into custody, checking a pass), and the client
///      rail above it does not change, because all it needs is one call that
///      carries a value and forwards a stipend." That claim is now measured
///      rather than asserted.
///
///      WHY IT MINTS STRAIGHT INTO THE GAME. Acquiring an avatar and putting
///      it at stake are one intention, and splitting them would be two wallet
///      prompts with a state in between where the player owns something that
///      cannot play. The game records custody from the mint payload, which is
///      only as trustworthy as the minter - and the minter is exactly one
///      address, this contract, which is what `GameAvatars.minter` buys.
///
///      IDS ARE SEQUENTIAL AND START AT 1, deliberately on both counts. Not
///      derived from the owner (reveal-or-die packs `owner << 96 | subID`),
///      because an id that can be computed from an account is the one case
///      where a token identity and an address identity are hard to tell apart,
///      and this branch exists to prove they are different things. And never
///      zero, because zero is the id `_playerOf` refuses: `makeCommitment(0)`
///      means "as the caller" on an address game and must not quietly become a
///      real avatar here.
contract AvatarSale {
    /// @notice `msg.value` minus the stipend was not the price.
    error WrongPaymentAmount(uint256 amount, uint256 expected);
    error FailedToTransferNativeToken(address recipient, uint256 amount);

    /// @notice One player set up: an avatar at stake, and their play key funded.
    event AvatarSold(
        address indexed sender,
        address indexed owner,
        uint256 indexed avatarID,
        address stipendTo,
        uint256 stipend
    );

    GameAvatars public immutable AVATARS;
    /// @notice Where an avatar is minted TO, which is the game that holds it.
    address public immutable GAME;
    /// @notice What one avatar costs, in the chain's own currency. May be zero.
    uint256 public immutable PRICE;
    address payable public immutable RECIPIENT;

    /// @notice The last id minted. The next one is this plus one.
    uint256 public lastAvatarID;

    struct Config {
        uint256 price;
        address payable recipient;
    }

    constructor(GameAvatars avatars, address game, Config memory config) {
        AVATARS = avatars;
        GAME = game;
        PRICE = config.price;
        RECIPIENT = config.recipient;
    }

    /// @notice Buy an avatar for `owner`, at stake in the game from the moment
    ///         it exists, and fund the key that will play it.
    /// @param owner The account the avatar belongs to. Not necessarily the
    ///        caller: an account with no wallet of its own (email or social
    ///        sign-in) can be set up by somebody else's wallet, and buying a
    ///        stranger an avatar is a gift, because only its owner can play it
    ///        or take it out.
    /// @param stipendTo The local key to forward gas to, or the zero address
    ///        when there is none, in which case `stipend` must be zero.
    /// @param stipend How much of `msg.value` is gas for that key rather than
    ///        payment for the avatar.
    function purchase(
        address owner,
        address payable stipendTo,
        uint256 stipend
    ) external payable returns (uint256 avatarID) {
        uint256 paymentAmount = msg.value;
        if (stipendTo != address(0)) {
            // Underflows, and so reverts, when the value does not even cover
            // the stipend. That is the right outcome and needs no message of
            // its own: the alternative is funding a key out of the price.
            paymentAmount -= stipend;
        } else if (stipend != 0) {
            // A stipend with nowhere to go would be kept by this contract,
            // which is money the player cannot get back.
            revert FailedToTransferNativeToken(stipendTo, stipend);
        }
        if (paymentAmount != PRICE) {
            revert WrongPaymentAmount(paymentAmount, PRICE);
        }

        avatarID = ++lastAvatarID;
        // Effects before the transfers. The mint reaches the game's
        // `onERC721Received`, which records `owner` as whose avatar it is.
        AVATARS.mint(GAME, avatarID, abi.encode(owner));

        if (stipendTo != address(0) && stipend != 0) {
            _send(stipendTo, stipend);
        }
        if (paymentAmount != 0) {
            _send(RECIPIENT, paymentAmount);
        }

        emit AvatarSold(msg.sender, owner, avatarID, stipendTo, stipend);
    }

    /// @dev `call` rather than `transfer`: the 2300 gas stamp is not enough for
    ///      a contract account, and both recipients here can be one.
    function _send(address payable to, uint256 amount) internal {
        (bool success, ) = to.call{value: amount}("");
        if (!success) {
            revert FailedToTransferNativeToken(to, amount);
        }
    }
}
