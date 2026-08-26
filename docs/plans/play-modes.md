---
title: Play modes (hotseat, fixed player set with early advance) are a seam, not a branch
type: prd
status: proposed
created: 2026-08-26
relates-to: jolly-roger work/prds/proposed/service-layers.md
---

# PRD: Play modes

## Problem

The commit-reveal template assumes one play mode: an open player set, advancing on a clock. Two more are wanted.

- **Hotseat**: players share one device, taking turns.
- **Fixed player set with early advance**: a known roster, where the round advances as soon as every player has acted rather than waiting out the clock.

The question this document answers is not how to build them. It is **where they live**, because the obvious answer is wrong in a way that is expensive to undo.

## Why these are not `with/*` branches

The service-layers PRD in `jolly-roger` establishes `with/<name>` branches for capability layers, and it is tempting to reuse the mechanism here. It does not fit, for one structural reason: **`with/*` is for additive, composable capability, and play modes are mutually exclusive alternatives.**

Layers compose. An app can want the indexer and messaging and sync, and `with/all` is a meaningful branch because "all of them at once" is a thing an app can be. Play modes do not compose: an app is hotseat or it is not, and "hotseat plus open-clock" is not a configuration, it is a contradiction.

The consequences of getting this wrong are concrete:

- **The graph loses its meaning.** `offshoot add hotseat` would resolve to a branch, and there would be no honest answer for a project that then wants `add fixed-set`, because no branch carries both and none ever should.
- **Every mode multiplies against every layer.** Three modes times the layer fan is a lattice, and the service-layers PRD exists specifically to avoid building one.
- **The modes never share a fix.** A bug in the epoch logic gets fixed on three branches and cascaded three times, forever, instead of once.

A choice between alternatives is a **seam**, and this repo already runs on seams: the renderer is one, and `web/src/lib/game/core/seams.ts` holds the rest. Play modes are implementations selected at deploy or configuration time, in one game that has several modes.

The precedent is stronger than "there is a seams file". That file was derived from four games that already exist, and it explicitly records disagreement as the criterion: "Anything those four disagree about is a seam. Anything they agree about (notably the epoch maths) belongs to the framework." Play modes are four-games-disagree material by that test. The state seam already abstracts a difference of exactly this kind, noting that stratagems "builds its state by replaying events through an indexer rather than reading contracts", with one `loading` flag covering "both a poller's in-flight fetch and an indexer's catch-up". A mode is the same species of variation, so it goes in the same place.

## Solution

Express each mode as an implementation of the existing game seams, chosen by configuration, with the contract carrying whatever the mode cannot enforce off-chain.

**Fixed player set with early advance** is primarily a change to the epoch seam. "The round ends when the clock runs out" becomes "the round ends when the clock runs out **or** every registered player has acted". That needs the contract to know the roster (so it can count), which is the fixed-player-set half, and the two features are therefore one feature rather than two: early advance is meaningless without a known denominator.

**Hotseat** is primarily a change to the account and signing seam rather than to the game rules: several players share one device and one session, so "the current player" stops being "the connected account".

## The design question hotseat has to answer first

**Hotseat changes what commit-reveal is for, and this needs deciding before anything is implemented.**

Commit-reveal hides a move from an opponent until everyone has committed. Co-located players share a screen. The opponent can watch you choose. The property the mechanism exists to provide is not provided by the mechanism in this mode, it is provided by the players not looking, which is a social convention rather than a cryptographic one.

That does not necessarily make hotseat wrong, but it makes it a different game, and the options are genuinely different products:

- **Keep commit-reveal, accept it is ceremony.** The onchain flow is unchanged, so the same contract serves both modes and hotseat is purely a client concern. Cheapest by a wide margin. Honest only if the UI does not claim secrecy it is not providing.
- **Keep commit-reveal and make it real** with a per-player secret the device does not display (pass-the-device with a hidden entry step). Preserves the property at the cost of real UX work, and it is the only option where a hotseat game and an online game are the same game.
- **Drop the commit phase in hotseat** and let moves resolve immediately. Simplest game, but now the contract has two shapes and the mode reaches into the contract rather than the client.

The first and third differ by whether the mode is a client concern or a contract concern, which is the single decision that determines this feature's cost. **Record it as an ADR before writing code.** Getting it wrong is not a refactor, it is a redeployment.

## User stories

1. As a developer adopting the template, I select a play mode by configuration, and the game I get is the same game with different round-advance and turn-ownership rules.
2. As a player in a fixed-set game, the round advances as soon as the last player has acted, so I am not waiting out a clock for no reason.
3. As a player in a hotseat game, I take my turn on a shared device without the previous player's move being visible to me, to whatever degree the mode decided above promises.
4. As a maintainer, a fix to the round-advance logic is made once and reaches every mode, because there is one implementation with a seam and not three branches.

## Out of scope

- Any `with/*` branch for a play mode. That is the thing this document exists to prevent.
- Networked real-time play. Modes here differ in turn ownership and round advance, not in transport.
- Changes to the service layers. A mode is orthogonal to whether the app has an indexer.

## Open questions

1. Which of the three hotseat options above? This gates everything else and is an ADR, not an implementation detail.
2. Does the fixed roster live in the contract, or does the contract only need the count? The count is enough for early advance; the roster may be needed for other reasons, and if it is not, storing it is a cost with no buyer.
3. Does early advance need protection against a griefing player who never acts, or is the clock already that protection? Probably the latter, in which case early advance is a pure optimisation and can never make a game worse, which is a good property to state explicitly.
4. Do the modes need to interoperate at all, for example a fixed-set game that is also hotseat? If yes, they are two independent seams rather than one mode enum, and that is a different shape worth knowing before building either.
