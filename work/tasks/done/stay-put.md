---
title: Stay put, an empty turn committed now, so a person can stand still under the Manual cycle
slug: stay-put
spec: games-on-this-foundation (template-commit-reveal work); stratagems' port plan, step P1
blockedBy: [tables-offline]
home: reveal-or-die (bomber-world takes it by cascade, its skinned HUD resolving the conflict)
---

# Stay put

Asked for by the maintainer on 2026-11-15, after stratagems' step OT3 measured the gap ("fix the gap in reveal-or-die").

**The need**: an avatar in the world lives only by acting each cycle, so the submission commits an empty turn for it by itself (`commitWhenIdle`) when the commit phase is about to close. That needs a clock. Under the Manual cycle (the offline world, and a table in it) a phase closes only once everyone has acted, so the automatic empty turn never came, "Commit now" needs a plan, and a person who wanted to stand still could not act: the cycle waited for them.

**What changed**: `world/ui/hud.ts`'s `canStayPut` (pure, exported) and the HUD's `canStayPut` field; a "Stay put" button (`data-testid="stay-put"`) beside "Commit now" that calls the submission's own `commit()`, which already takes an empty turn when one is owed. Offered on every policy (under a clock it also lets a table advance early), on exactly the submission's terms: an avatar at risk (in the world and alive), nothing pending for this cycle, a table that still plays, the commit phase open, no unrevealed commitment in the way, the account's data loaded. Rejected: committing the empty turn automatically under Manual (the person would lose the cycle's time to think, which is what the Manual cycle gives them).

**Tests**: `test/lib/world/hud.test.ts` (3: offered, every condition that withholds it, on the HUD in the world and not out of it); `tables-offline.e2e.ts` stays put in its last cycle instead of stepping, with "Commit now" disabled.

## Done, 2026-11-15, on local preview branches `pp1/*`, NOT pushed

reveal-or-die `pp1/main` c4a96710 (from `origin/main` 050961b1): check 0 and 0; unit 2277 + 78 (2274 + 3); e2e 59 passed, 2 skipped (10.0 min); `tables-offline.e2e.ts` alone 2 passed (13.4 s). bomber-world `pp1/main` c220c5a3 (from 37435af5), the button added to its skinned HUD's bottom-left corner beside "Commit now" (the conflict: its HUD has no panel row of buttons): check 0 and 0; unit 2371 + 78; e2e 62 passed, 2 skipped (12.8 min), the shared story staying put there too. No contract, deploy or lockfile change, so the LAN builds and `pnpmDepsHash` stand.
