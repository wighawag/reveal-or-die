// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

/// @title The delegation surface
/// @notice Everything {UsingDelegation} exposes, as an interface.
///
/// {UsingDelegation} is an abstract contract, which a Solidity `interface`
/// cannot inherit, so a contract behind a ROUTER has no way to say "these
/// selectors are part of my ABI" without restating them. This is that
/// restatement, and it exists for two jobs beyond documentation:
///
///  1. it composes into a router's combined interface ({IGame} here), so the
///     generated ABI carries delegation and a client can call it on the proxy;
///  2. a route declaring `is IDelegation, UsingDelegation` gets the compiler to
///     check the two agree. Without that the restatement could drift from the
///     implementation, and the failure would be a selector that routes nowhere
///     - which reads to a user as a wallet error rather than a missing feature.
///
/// The web client declares this same surface as `DELEGATION_ABI`, for the same
/// reason and with the same risk. See `web/src/lib/onchain/delegation.ts`.
interface IDelegation {
    /// @notice authorise `delegate` to act for you, and optionally fund it.
    function registerDelegate(
        address delegate,
        address payable payee
    ) external payable;

    /// @notice authorise a delegate using the owner's signature, paid by anyone.
    function registerDelegateViaSignature(
        address owner,
        string calldata origin,
        address delegate,
        bytes calldata signature
    ) external payable;

    /// @notice withdraw the authorisation you gave.
    function revokeDelegate() external;

    /// @notice the address currently allowed to act for `owner`; zero if none.
    function delegateOf(address owner) external view returns (address);

    /// @notice whether `owner` has withdrawn its authorisation for `delegate`.
    function delegationWithdrawn(
        address owner,
        address delegate
    ) external view returns (bool);

    /// @notice the exact text a signature must be over.
    function delegationMessage(
        string calldata origin,
        address delegate
    ) external pure returns (string memory);

    /// @notice the digest of {delegationMessage}, as signed.
    function delegationDigest(
        string calldata origin,
        address delegate
    ) external pure returns (bytes32);
}
