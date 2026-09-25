---
title: stakeAnAvatar returns before the play key is REGISTERED, and the out-of-gas test's next line took the gas it needed to register itself
type: finding
status: FIXED 2026-09-25
spotted: 2026-09-25
supersedes: work/notes/observations/signer-out-of-gas-fails-under-the-full-parallel-run-and-passes-alone.md
relates-to: web/e2e/fixtures/board.ts, web/e2e/tests/signer-out-of-gas.e2e.ts
---

# A setup helper that waits for the first of three things the same transaction does

`signer-out-of-gas.e2e.ts` failed under the full suite and passed when run alone, which is the signature this tree has learnt to read as resource contention. **It was not contention.** It was a race inside the test's own setup, and the app was behaving correctly throughout.

## The chain of events, observed rather than inferred

Buying an avatar is ONE transaction that does THREE things, and the gate's own copy says so: it puts the avatar into the game's custody, it funds the key this browser plays with, and it lets that key be authorised. The third is a SECOND transaction, sent by the signer ITSELF out of the stipend the purchase just gave it.

`stakeAnAvatar()` waited for the first one only - custody, "settled ON THE CHAIN, not on the button" - and returned. The out-of-gas test's very next line is `drainSignerGas()`.

So:

1. custody lands, `stakeAnAvatar()` returns
2. the signer's self-registration has not landed yet
3. the drain sets the signer's balance to zero
4. **the registration can now never land**, because the money it needed to send itself has gone
5. `setup` stays `{step: 'authorise'}`, so `readyToPlay` stays false
6. clicks on the board are ignored BY DESIGN - `context/game.ts` says it outright: "Letting someone plan a whole turn they cannot commit is worse than not letting them start"
7. thirty seconds later the test dies on `clicking the board should plan something`

A probe inserted at the exact line where the drain happens, on a failing run, printed:

```
PROBE-BEFORE-DRAIN {"setup":{"step":"authorise"},"deposited":"Loaded",
                    "delegationStep":"Loaded","delegationAllowed":false,"canvases":1}
PROBE-AFTER-DRAIN  {"setup":{"step":"authorise"},
                    "delegationStep":"Loaded","delegationAllowed":false,"canvases":1}
```

That is the whole finding in two lines: the avatar is in custody, the chain says this browser is **not** an allowed delegate, and the window was already lost before the drain ran. `canvases: 1` matters too - the canvas is present and the click lands, it is simply not acted on, which is why the page in the failure screenshot looks perfectly healthy.

## Why it read as contention, and the lesson about that

Everything about the symptom pointed the wrong way. It failed 5 of 7 full runs and passed every time it was run alone; it failed identically at the commit BEFORE the cascade that found it, so it was not a merge; and `playwright.config.ts` in this repo already carries three paragraphs of real, measured contention history, which makes contention the cheapest available explanation. The config even records the tell that applies here: a previous suite was blamed on the node for an afternoon when the cause was a fixture bug.

**The general form: "passes alone, fails under load" is a statement about TIMING, and contention is only one of the things timing changes.** The other is a race between the test's own steps, and the way to tell them apart is not to reason about it - it is to ask the app what it believed at the moment it gave up. One `page.evaluate` of the app's own stores answered in a single run what three full-suite runs and a node sampler had not.

A second, sharper lesson: **a helper that drives a transaction which does N things must not return when the first of them lands.** The name (`stakeAnAvatar`) described the part the author cared about, and the three-in-one purchase is documented one file away, in the copy shown to the player.

## The fix

`waitUntilSetUpToPlay()` in `web/e2e/fixtures/board.ts` polls the app's own `setup` until nothing is missing, and `stakeAnAvatar()` calls it after the custody poll. `boardState()` gained `setup` so it can be read at all.

- It polls `setup` rather than `readyToPlay`, because that one folds in the PHASE - it is false during every reveal - so waiting on it would mean waiting for a play window, which is `planOnCanvas`'s job.
- It polls the app's state rather than the gate's button, because the button is absent both while the app is still deciding and once there is nothing to ask for, so the DOM cannot distinguish "not yet" from "done".
- It is called only on the purchase path, not in `stakeAnAvatar`'s early return. There the account already held an avatar and this browser may legitimately still need authorising - a second browser, or a revoked one - which is a question with a button (`authoriseToPlay`) and not a wait, and waiting would hang on it.

And the out-of-gas test now ASSERTS its own premise right before the drain: `setup` must be undefined, a signer that was funded properly and then ran dry. That is the durable half of this fix. If the window ever reopens, the failure is immediate and says "the player must be fully set up before the gas is taken away" instead of being a thirty-second mystery about a click.

## What is proven, and what is not

**Proven:** the cause. The window was observed open at the exact line, on an actual failing run, and the consequence is necessary once it is lost rather than probabilistic - a drained signer cannot pay for its own registration, so `setup` can never clear. The fix makes the window unreachable by construction: the test cannot get to the drain until the chain says nothing is missing.

**Not proven by the pass rate, and worth saying so.** The suite passes 2 of 2 with the fix - but it also passed 2 of 2 with the fix's guarantee commented out again, because the window is narrow and only sometimes lost. So those runs are consistent with the fix and do not by themselves demonstrate it. Anyone re-checking this should mutate and look for the *message*, not the pass.

**Checked for teeth:** removing `drainSignerGas` fails the test at "a commit with no gas should fail", so the out-of-gas subject is still genuinely exercised and the new wait has not quietly turned this into a test of a healthy signer.

## What this does NOT close

The contention history in `playwright.config.ts` is untouched and still stands on its own evidence: workers are capped at 2 there for reasons measured on other suites. Nothing here argues for raising it. Note only that one of the failures that cap was reasoned about may deserve re-examination with the technique above - ask the app, do not reason about the node.
