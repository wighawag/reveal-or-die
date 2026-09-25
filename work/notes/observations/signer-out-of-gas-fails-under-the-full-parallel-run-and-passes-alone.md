---
title: signer-out-of-gas.e2e.ts fails under the full parallel run and passes alone, and it did so BEFORE the chrome cascade
type: observation
status: open
spotted: 2026-09-25
relates-to: the e2e suite, the recorded 51-of-51 baseline
---

# The recorded baseline says 51 of 51; this machine measures 50 and 1, at HEAD, without any change applied

`web/e2e/tests/signer-out-of-gas.e2e.ts` ("A move that runs out of gas > is named, offers the remedy, and resumes when the gas lands") fails during a full `pnpm test:e2e`, at:

```
Error: clicking the board should plan something
expect(received).toBeGreaterThan(expected)
Expected: > 0
Received:   0
- Timeout 30000ms exceeded while waiting on the predicate
```

The page snapshot in the failure shows a fully rendered app with its navbar and its links, so nothing is missing from the page. The click simply plans nothing within 30 seconds.

## It is not the chrome cascade, and that was measured rather than argued

Found while cascading the per-surface chrome change into this repo, which is exactly the situation in which a pre-existing failure gets blamed on the merge. So it was measured on both sides:

| tree | full suite | that test alone |
| --- | --- | --- |
| merged (chrome cascade applied) | 50 passed, 1 failed | 1 passed |
| `d9dd1242`, HEAD before the merge, clean worktree | 50 passed, 1 failed | 1 passed |

Same test, same assertion, same shape, on both. The merge touches no route this test visits: it wraps the layout's navbar snippet in a component that renders the same navbar, and adds files that only `/offline` imports.

**So the "51 of 51" figure carried in the handoff is not what this repo measures today.** Whether it was measured on a quieter machine, or something else has landed since, is not established here.

## What it looks like, and the rule this repo already has for it

Load-dependent: it fails in the full run, twice in a row, and passes alone, twice in a row. `template-commit-reveal`'s handoff has a hard-won paragraph about precisely this shape, from the `getCellsInZones` incident: **a failure whose only symptom is under parallel load is a resource problem until proven otherwise**, and the tempting fixes (raise the timeout, add a retry, run it serially) all hide it. That incident's cause was an expensive `eth_call` starving a single-threaded dev chain of service while several browsers polled it, which surfaced as failures in tests that had nothing to do with the board.

The symptom here is consistent with that and is NOT yet diagnosed: "the click planned nothing" is what a page looks like when the read it needs has not come back. The measurement that cracked the previous one took ten minutes and needed nothing but `curl` in a loop against the node while the suite ran. That is the thing to do next, before touching this test.

## Why it is not fixed here

It is outside the change that found it, and this tree's rule is that an unrelated failure is a finding rather than a fix-in-passing. Fixing it blind would mean widening a timeout in a test whose subject is a signer running out of gas mid-round - which is a test about a player losing money, and the last thing that should quietly become more tolerant.

## What to do with it

1. Sample the node's responsiveness (`eth_chainId` in a loop) from outside the suite while the full run is going, and see whether it stalls the way it did for `getCellsInZones`.
2. If it does, find the expensive read: this game's board reader is `$lib/world`, and it is the equivalent of the one that caused the previous outage.
3. Only if the node is healthy throughout is this a test problem rather than a resource one.
4. Correct the recorded baseline once the answer is known, in the same commit, rather than leaving two numbers in circulation.
