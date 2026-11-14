// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "solidity-kit/solc_0_8/ERC721/implementations/EnumerableERC721.sol";

contract Avatars is EnumerableERC721 {
    error NotMinter(address sender, address minter);
    error NotMinterAdmin(address sender, address minterAdmin);
    error NotHolder(address sender, address holder);
    error StakeTransferFailed(address to, uint256 amount);

    event MinterSet(address indexed previousMinter, address indexed newMinter);
    event StakeReleased(
        uint256 indexed tokenID,
        address indexed holder,
        uint256 amount
    );

    /// @notice Who may change {minter}. Immutable, and set at construction.
    address public immutable MINTER_ADMIN;

    /// @notice The only address allowed to {mint}.
    ///
    /// Zero until set, and zero means NOBODY CAN MINT, which is the right
    /// default: a deployment that forgets to wire the sale mints nothing at
    /// all, rather than minting for free. The failure is loud and immediate
    /// instead of silent and expensive.
    address public minter;

    /// @notice WHAT AN AVATAR CARRIES, in the chain's own currency: fixed at
    ///         mint for as long as the avatar exists, and paid out only by
    ///         {burn} (step R1a of stratagems' plan; reveal-or-die `work`:
    ///         `stake-in-the-avatar`).
    /// @dev NOTHING ELSE MOVES IT, and no game is trusted with it: a game that
    ///      holds avatars (its custody) releases a body's stake the way any
    ///      holder would, by burning it, and whatever the game does with the
    ///      ETH after is between the game and its players. So an avatar is
    ///      worth the same in every game, present and future.
    mapping(uint256 tokenID => uint256 amount) public stakeOf;

    constructor(address minterAdmin) {
        MINTER_ADMIN = minterAdmin;
    }

    /// @notice Point the mint at a sale contract.
    ///
    /// Re-settable rather than one-shot, and that costs nothing in trust that
    /// is not already spent: `AvatarsSale` is deployed BEHIND AN UPGRADEABLE
    /// PROXY owned by the same admin, so an admin who wanted free avatars could
    /// already upgrade the sale to hand them out. Pretending a one-shot setter
    /// bought security here would be security theatre, and it would make
    /// changing how avatars are paid for a redeployment of this contract and a
    /// migration of every avatar in it.
    ///
    /// What it does buy is the thing this game actually wants next: paying in
    /// something other than the native token means deploying a different sale
    /// and pointing this at it. See the note on {mint}.
    function setMinter(address newMinter) external {
        if (msg.sender != MINTER_ADMIN) {
            revert NotMinterAdmin(msg.sender, MINTER_ADMIN);
        }
        emit MinterSet(minter, newMinter);
        minter = newMinter;
    }

    /// @notice Mint an avatar. Only the {minter} may call it.
    ///
    /// THIS USED TO HAVE NO ACCESS CONTROL, and it was the most serious thing
    /// in this repo. `BasicERC721._safeMint` only rejects a tokenID that
    /// already EXISTS, so anyone could mint any unminted id to any address, for
    /// free, without going near `AvatarsSale` - and the tokenID scheme is
    /// `(uint160(owner) << 96) + subID`, so they were well-formed avatars
    /// rather than odd-looking ones.
    ///
    /// The consequence that mattered was not the bypassed price. This NFT is
    /// the thing AT STAKE in the commit-reveal round, and **a stake that costs
    /// nothing to acquire is not a stake**: "something must be at stake, or
    /// nobody has to reveal" is the invariant the whole framework rests on (see
    /// AGENTS.md), and a free mint voided it on any deployment that carried it.
    /// A player who disliked what they had committed to could go quiet, lose
    /// the avatar, and mint another one for gas.
    ///
    /// WHAT PAYING MEANS LIVES IN THE SALE, NOT HERE, and that split is the
    /// point rather than an accident. This contract knows only that exactly one
    /// address may mint; `SaleViaNativePayment` knows the price, the recipient
    /// and the free-list. So charging in an ERC20 later is a new sale contract
    /// and one `setMinter` call, with no change to this file and no migration
    /// of existing avatars - `SaleViaERC20Payment.sol` is already in the tree
    /// for exactly that. Today it is the native token.
    ///
    /// ONE MINTER, NOT A SET, deliberately. A `mapping(address => bool)` would
    /// let a native sale and an ERC20 sale run at once, and nothing wants that
    /// yet; a speculative parameter shipped unexercised is the thing this
    /// project keeps having to delete. When two live sales are actually needed,
    /// this becomes a mapping, and that change is smaller than the migration a
    /// wrong guess would cost.
    ///
    /// `payable` AGAIN, AND THIS TIME THE VALUE IS THE AVATAR'S STAKE (step
    /// R1a). It once was `payable`, took `msg.value` and did nothing with it,
    /// with no way to withdraw, so every wei sent was locked for good; it was
    /// made non-payable for that. Now what arrives is recorded as
    /// {stakeOf} the id, and {burn} is the way out. The sale's FEE still goes to
    /// its `RECIPIENT`; only the stake comes here.
    ///
    /// A BURNED ID IS NEVER MINTED AGAIN: `_safeMint` is called with
    /// re-minting refused, and a burn leaves the token's nonce behind, so an id
    /// whose stake was paid out cannot come back carrying another.
    ///
    /// See also docs/plans/identity-without-consent.md: this function was one
    /// half of the composed impersonation described there. Both halves are now
    /// closed.
    function mint(
        address to,
        uint256 tokenID,
        bytes calldata data
    ) external payable {
        if (msg.sender != minter) {
            revert NotMinter(msg.sender, minter);
        }
        stakeOf[tokenID] = msg.value;
        _safeMint(to, tokenID, false, data);
    }

    /// @notice Burn an avatar you hold, and receive the stake it carries.
    /// @dev THE HOLDER, not an approved operator: the stake goes to whoever
    ///      holds the avatar, so the one who may burn it is the one it is paid
    ///      to. A game holding avatars burns a body this way to release its
    ///      stake. The stake is cleared before the transfer, so a holder that
    ///      re-enters finds nothing left to take.
    ///
    ///      `data` IS THE CALL THE STAKE ARRIVES WITH, chosen by the holder,
    ///      who is the caller: an account passes nothing, and a contract that
    ///      refuses plain transfers (a game behind a proxy whose `receive`
    ///      rejects ETH, as reveal-or-die's does) names the payable function it
    ///      takes the stake through. Nothing here trusts or knows any game.
    function burn(uint256 tokenID, bytes calldata data) external {
        address holder = _ownerOf(tokenID);
        if (msg.sender != holder) {
            revert NotHolder(msg.sender, holder);
        }
        uint256 amount = stakeOf[tokenID];
        delete stakeOf[tokenID];
        _burn(tokenID);
        emit StakeReleased(tokenID, holder, amount);
        if (amount != 0) {
            (bool success, ) = payable(holder).call{value: amount}(data);
            if (!success) {
                revert StakeTransferFailed(holder, amount);
            }
        }
    }
}
