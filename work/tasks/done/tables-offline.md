---
title: Tables in the offline world, in both modes
slug: tables-offline
spec: games-on-this-foundation (template-commit-reveal work); stratagems' port plan, step OT3
blockedBy: [tables-for-reveal-or-die, bodies-appear-after-death]
home: reveal-or-die (bomber-world takes it by cascade)
---

# Tables in the offline world, in both modes

Built from stratagems' port plan, step OT3 (`main`, `work/plans/join-template-commit-reveal.md`, section "Step OT", after OT2), decisions OT3-1 to OT3-14 taken with the maintainer on 2026-11-15.

**The need**: a game with online tables offers them offline too (template-commit-reveal's invariant, `web/test/offline-tables-boundary.test.ts`), and this game was listed in its `KNOWN_GAPS`. The offline lobby now offers a table first, in either mode through this game's own select, with the world kept as the other choice.

## What changed

- **The tables in the tab, on the world's clock** (OT3-1): the contracts config gains `offline` entries for `data.Game` and `data.Table` (the Manual cycle with both durations zero, everything else the default's, through one `offline()` helper), which `web/src/lib/offline.ts`'s `OFFLINE_DEPLOYMENT` reads; it runs `030_deploy_tables` after `020` and expects every contract (`isTableContract` gone with its last user). The data lives in the config rather than the web so that a contract test deploying under the `offline` environment deploys exactly what the tab does.
- **The boot** on template-commit-reveal's shared half (`$lib/game/lobby/offline-table`: `offlineTableCreator`, `seatTheOfflineTable`, `offlineSeatLabels`); `startOfflineTable` and `TABLE_STORAGE_KEY` exported. At a table the context, the played seats and their store are on the table's record (`lobby.deploymentsAt`, through `embeddedConnectionFactory`), and nobody is in the world's `Game`.
- **A seat by the mode's rail** (OT3-3, OT3-4): `stakeForEveryoneAtTheTable` reads the table's mode off the chain; in avatar mode the deployer buys each seat's avatar into the table through `AvatarsSale.purchase`; in ETH mode each seat's own account sends `join` with exactly the stake (the person through the world's wallet, a world seat from its key). Guarded by `getAvatar(id).owner` at the table, so a reload takes no seat twice.
- **An identity per mode** (OT3-5): `offlineIdentityOf(player, mode)`, the address at an ETH table; `playedByTheWorld(table, mode)`.
- **The played seats at a table** (OT3-6, `offline-players.ts`): a seat commits only while the table plays (started, not past its end, not closed, more than one alive) and only as a member (a seat its creator forfeited would revert `NotInGame` every pass, and a throw stops the pass for every seat after it). Still reveals, settles and releases its own. `turnFor` pinned by fixed outputs, and never an Exit.
- **The end by the tab** (OT3-7): `world/table.ts`'s `closeAndReleaseOnceClosable`, wired in the world's `start`: once closable it calls the store's `close()`, then `releaseLeftovers()` once closed with any left; once per boot. The winnings stay the person's press.
- **Tests**: contracts `test/js/OfflineTables.test.ts` (6, deploying under `offline` with `saveDeployments: false`); unit, the world test (a table boots in each mode, a reload sends nothing, a record the chain does not hold is refused, the identity per mode), the played seats at a table (mutation-checked: with the rule disabled both cases fail), the end by the tab (4); e2e `tables-offline.e2e.ts` (both modes: offered first, every seat at the table, entered and played, reloaded, closed by the tab, the winnings taken); `offline.e2e.ts` presses the world; the template's `offline-table.e2e.ts` omitted in `.offshoot-omissions`, for ever.

## Measured

- **Under the Manual cycle the forfeit, not `releaseDeadAvatar`, is what unblocks a waiting cycle here**: a seat that never entered dies on the table's clock, cannot commit (`AvatarIsDead`), and cannot be released (`AvatarNotDead`: it is not in custody), so the cycle waits until its creator forfeits it; a forfeited seat is no longer waited for at all (`releaseDeadAvatar` answers `NotInGame`). `releaseDeadAvatar` matters where a waited-for seat dies in the world, which is bomber-world's blast, tested there.
- **A person cannot pass a Manual cycle without moving**: the HUD's "Commit now" needs a planned action, and the clocked policies' `commitWhenIdle` never fires under Manual, so the person plays a move every cycle (in the world as at a table). Not changed here; the e2e plays a step.

## Done, 2026-11-15, on local preview branches `pot3/*`, NOT pushed

`pot3/main` from `origin/main` ea50a397: `36bcbb37` (contracts), `aba0506b` and `0288688d` (template-commit-reveal `with/all`), `c2336bc2` (the played seats), `96acb73a` (the end by the tab), `4c2a126c` (the boot), `ee2a2f92` and `050961b1` (e2e). Measured at `050961b1`: contracts 93 passing (87 + 6); check 0 errors and 0 warnings; unit 2274 + 78 (2258 + 4 from the template + 12); e2e 59 passed, 2 skipped (9.6 min; `tables-offline.e2e.ts` alone 13.8 s); `nix build git+file://$PWD#lan` passes; dangling imports clean; omissions cover all 65 paths dropped from template-commit-reveal `with/all` 356ab087.
