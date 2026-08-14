// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import {UsingDelegation} from "@etherplay/delegation/contracts/UsingDelegation.sol";

/// @title The Game's delegation route
/// @notice Who is allowed to play as whom.
///
/// A player's moves are sent by a LOCAL SIGNER: a key this browser generated,
/// which the player never sees, holds nothing, and can lose without losing
/// anything. That is what makes a round playable, since a commit and a reveal
/// every epoch through a wallet prompt is not a game. It is also the whole
/// danger, and delegation is what makes it safe.
///
/// The template used to make that key the PLAYER: the reserve was its reserve
/// and the cells were its cells. Everything worked and the position was wrong.
/// An identity that lives only in one browser's storage is one cleared site
/// away from being gone, taking the staked reserve with it, and there is no
/// recovery because there is nothing else that was ever the player. Worse, a
/// key with no owner is a key with full authority: anything that got hold of it
/// held the stake.
///
/// So the identity is the ACCOUNT, and the signer merely acts for it. The
/// account owns the reserve and the cells; the signer spends gas. Losing the
/// browser costs a key, and the player authorises another one and carries on.
///
/// This route holds nothing of its own. {Delegation} keeps its state in a
/// namespaced (ERC-7201) region, so the record is shared by every route behind
/// the proxy: {GameCommit} resolves a move against exactly what is registered
/// here. Deployed as its own route rather than folded into {GameCommit}
/// because a router maps one selector to one route, and a contract inheriting
/// {UsingDelegation} brings all six of these with it.
///
/// The library is not forked into this tree: it ships as source in the
/// etherplay delegation package and is compiled into this route. That matters
/// because a delegate authorised here may do anything at THIS game that its
/// owner could do through {GameCommit-_accountFor} - the whole contract, not
/// one action - and nothing anywhere else, since the address of this contract
/// and the chain id are inside the message the owner signs. A shared registry
/// deployment would put the REGISTRY's address in every signature instead,
/// making one credential good at every game on it.
///
/// BEHIND THE ROUTER, that address is the PROXY. The route runs under
/// `delegatecall`, so `address(this)` in {Delegation} is the proxy a player's
/// client talks to, which is also where the record lives and where the check
/// happens. So a signature is bound to the Game as a whole rather than to the
/// implementation of one of its routes, and re-deploying a route does not
/// invalidate anything already signed. That is the behaviour a router-based
/// adopter needs, and it is asserted rather than assumed: see the proxy tests
/// in `test/js/Game.test.ts`.
///
/// Deliberately does NOT declare `is IDelegation`, though {IGame} composes that
/// interface for the ABI. Solidity makes a contract inheriting both an
/// interface and an abstract implementation of it restate every function as an
/// `override`, which is precisely the boilerplate {UsingDelegation} exists to
/// spare an adopter. The agreement between the two is checked instead by
/// `test/js/Game.test.ts`, at the level where it can actually break: whether
/// each selector is ROUTED on the deployed proxy. A compiler check would have
/// proved the interface matched while the route was still missing from the
/// deploy script.
contract GameDelegation is UsingDelegation {}
