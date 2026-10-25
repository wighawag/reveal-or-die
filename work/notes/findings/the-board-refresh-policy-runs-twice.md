---
title: The board's refresh policy runs twice, once inside the poller and once in the composition
type: finding
status: open
spotted: 2026-10-25
relates-to: web/src/lib/world/context.ts, web/src/lib/onchain/state.ts, web/src/lib/game/core/refresh.ts
---

# Two refreshes during every reveal, and two settles at every cycle start

`createPollingOnchainState` (`web/src/lib/onchain/state.ts`, the template's) runs `refreshDuringReveal` and `settleBoardWhenCycleStarts` itself, tied to its own subscriber count, since the template moved the refresh policy inside the poller. `world/context.ts` runs its own pair as well, in the `start` hook it hands the commit-reveal skeleton. Its comment says the two functions "went back to being the framework's", which is true of the code (they are imported from `game/core/refresh.ts`) and not of the call: the composition still calls them, so the board is refreshed by both.

The two pairs are not identical. The poller's reads the phase as `cycleInfo.isCommitPhase`; the composition's reads `twoPhase`, which closes the play window `commitTimeAllowance` early. So removing the composition's pair is a behaviour change, small but real, and the skeleton port (2026-10-25, the merge 245f8c2d) kept it unchanged rather than halving the refreshes silently.

What to decide: drop the composition's pair (the poller's is the framework's policy, and the template's reference game relies on it alone), or keep it and say why `twoPhase` matters here. Measure the RPC traffic during a reveal before and after; the e2e suite (51 tests) passed with both pairs running.
