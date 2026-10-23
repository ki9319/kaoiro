# First-import guard implementation evidence

Evidence for [issue #716](https://github.com/sakuraiyuta/kaoiro/issues/716), measured 2026-10-23.

## Source and inventory

- Baseline: `dd9cdca180eb9c4f756a66cfdc93d269036c7ddd`.
- Guard and checker implementation: `194b45141cd8fc774bcbdba0509f059f5ad72dd5`; dashboard TypeScript import correction: `707f367bdd60acdbe8920b96294b69506cce7288`.
- Fixed runtime image: `sha256:56cfd9fbe740e78f5d6d219772b6f5f7ba08424bf449f688b1a2597eebd469b8`.
- The reproducible inventory found 497 source files, selected 485 by static test-API imports, retained 3 helpers and 9 guard-free canaries, and added the guard import to 439 files. Re-running the codemod made no further changes.
- The final checker CLI reported `{"entries":33,"problems":0}`. Its test-isolation suite passed 122/122 tests, with no skipped or cancelled tests. All 104 dashboard imports use the extensionless local setup specifier; the checker accepts it and rejects the `.ts` spelling that failed dashboard type checking.
- The exact-head PR CI run for checker candidate `707f367bdd60acdbe8920b96294b69506cce7288` completed successfully across all nine expected jobs, including dashboard type checking and the test-isolation suite.

## Regression controls

Actual checker CLI probes returned the expected result for missing guards in an existing entry, oddly named tracked and untracked Vitest files, and a Node test entry. A comment/string-only occurrence was accepted. The new runner caller probe observed the guard and token removal through quoted `test:fast`, split `vi""test`, the core `/test/` selector, and a direct-bin alternate-config invocation. Its no-import control observed the guard absent and a harmless fake token retained; no host tool or network call was attempted. The combined unchanged [issue #706](https://github.com/sakuraiyuta/kaoiro/issues/706) runner tree reported zero problems.

The 122-test checker suite also exercises the real Vitest observation path and checks each required canary, including dashboard's jsdom canary. On the actual default runner config, removing its `setupFiles` made the checker CLI exit 1 with 33 entries and 2 problems; its observation included `test isolation is not loaded in this process`. A canary-only listing without setup exited 1 at module scope. With that module-scope assertion temporarily removed, the same canary-only listing exited 0; restoring the assertion and setup restored a clean checker result. Adding the shared guard import to that canary made the checker CLI exit 1 with one named problem. No static requirement for `setupFiles` was added.

Fifteen independent checker-guard mutations each made the corresponding self-test fail: eight unsupported acquisition forms (re-export, `require`, dynamic import and TypeScript import-equals for `vitest` and `node:test`), first-import enforcement, content selection, helper API contract, canary no-guard contract, dashboard one-hop, type-only first-import handling, and canary marker ordering. Every mutation was restored and the checker, selector and canary-helper source hashes matched their pre-mutation values. A separate mutation changing the dashboard import check back to `.ts` made its extensionless-import self-test fail; the restored self-test passed and checker CLI returned zero problems.

The final candidate was also checked with the genuine [issue #706](https://github.com/sakuraiyuta/kaoiro/issues/706) runner closure from `fda99b9c776f2cfac5a567fb554ddfc7f5dbca97`: its four package scripts, Vitest config, tier selector and manifest, and both tier tests. The actual final checker CLI exited 0 with `{"entries":33,"problems":0}`; the transferred config retained its original setup and spread.

## Paired focused package measurements

Each package ran the same two harmless sentinel files with one case each, three times, on the same image. Baseline files relied on package setup; candidate files imported the guard first, with dashboard importing its extensionless local setup as the documented one-hop route to the shared guard. Every invocation exited 0, selected 2 files and 2 cases, recorded exactly 2 `beginEntry` calls, and had empty stderr with no unhandled-error or warning diagnostics. Times and peak process-tree RSS are medians of three runs. RSS is the sum of `/proc/<pid>/status` `VmRSS` for the Vitest process and descendants, sampled every 10 ms.

| Package | Baseline ms / KiB | Candidate ms / KiB | Change ms / KiB |
| --- | ---: | ---: | ---: |
| runner | 599 / 269592 | 607 / 270592 | +8 / +1000 |
| wrapper/core | 598 / 266480 | 599 / 270432 | +1 / +3952 |
| wrapper/agent-common | 586 / 270012 | 590 / 266692 | +4 / -3320 |
| wrapper/claude-code | 604 / 266236 | 597 / 273532 | -7 / +7296 |
| wrapper/codex | 606 / 269152 | 600 / 272708 | -6 / +3556 |
| wrapper/antigravity | 607 / 268888 | 599 / 269720 | -8 / +832 |
| wrapper/grok | 602 / 265932 | 594 / 267552 | -8 / +1620 |
| dashboard | 925 / 335744 | 920 / 334380 | -5 / -1364 |

This is a focused two-file lifecycle comparison, not a full-suite speed estimate. The exact-SHA CI workflow remains the full-suite evidence.

## Scope limits

The documented residual boundary is in [test isolation](../../contributing/test-isolation.md#residual-risks). Alternate configs, Vite plugin config hooks, computed config code, spreads and later keys, inline projects without `extends: true`, and auto-discovered workspace/project files can affect default behavior. The guard does not detect `isolate` or `pool` changes through those mechanisms. The retained `vitestWiring` ownership check still rejects Vitest scripts/configs outside declared package directories.
