# First-import guard implementation evidence

Evidence for [issue #716](https://github.com/sakuraiyuta/kaoiro/issues/716), measured 2026-10-23.

## Source and inventory

- Baseline: `dd9cdca180eb9c4f756a66cfdc93d269036c7ddd`.
- Guard and checker implementation: `194b45141cd8fc774bcbdba0509f059f5ad72dd5`.
- Fixed runtime image: `sha256:56cfd9fbe740e78f5d6d219772b6f5f7ba08424bf449f688b1a2597eebd469b8`.
- The reproducible inventory found 497 source files, selected 485 by static test-API imports, retained 3 helpers and 9 guard-free canaries, and added the guard import to 439 files. Re-running the codemod made no further changes.
- The final checker CLI reported `{"entries":33,"problems":0}`. Its test-isolation suite passed 121/121 tests, with no skipped or cancelled tests.

## Regression controls

Actual checker CLI probes returned the expected result for missing guards in an existing entry, oddly named tracked and untracked Vitest files, and a Node test entry. A comment/string-only occurrence was accepted. The new runner caller probe observed the guard and token removal through quoted `test:fast`, split `vi""test`, the core `/test/` selector, and a direct-bin alternate-config invocation. Its no-import control observed the guard absent and a harmless fake token retained; no host tool or network call was attempted. The combined unchanged [issue #706](https://github.com/sakuraiyuta/kaoiro/issues/706) runner tree reported zero problems.

The 121-test checker suite also exercises the real Vitest observation path and checks each required canary, including dashboard's jsdom canary. On the actual default runner config, removing its `setupFiles` made the checker CLI exit 1 with 33 entries and 2 problems; its observation included `test isolation is not loaded in this process`. A canary-only listing without setup exited 1 at module scope. With that module-scope assertion temporarily removed, the same canary-only listing exited 0; restoring the assertion and setup restored a clean checker result. Adding the shared guard import to that canary made the checker CLI exit 1 with one named problem. No static requirement for `setupFiles` was added.

Fifteen independent checker-guard mutations each made the corresponding self-test fail: eight unsupported acquisition forms (re-export, `require`, dynamic import and TypeScript import-equals for `vitest` and `node:test`), first-import enforcement, content selection, helper API contract, canary no-guard contract, dashboard one-hop, type-only first-import handling, and canary marker ordering. Every mutation was restored and the checker, selector and canary-helper source hashes matched their pre-mutation values.

## Paired focused package measurements

Each package ran the same two harmless sentinel files with one case each, three times, on the same image. Baseline files relied on package setup; candidate files also imported the guard first. Every invocation exited 0, selected 2 files and 2 cases, recorded exactly 2 `beginEntry` calls, and had empty stderr with no unhandled-error or warning diagnostics. Times and peak process-tree RSS are medians of three runs. RSS is the sum of `/proc/<pid>/status` `VmRSS` for the Vitest process and descendants, sampled every 10 ms.

| Package | Baseline ms / KiB | Candidate ms / KiB | Change ms / KiB |
| --- | ---: | ---: | ---: |
| runner | 599 / 269592 | 610 / 269824 | +11 / +232 |
| wrapper/core | 598 / 266480 | 612 / 269592 | +14 / +3112 |
| wrapper/agent-common | 586 / 270012 | 601 / 269992 | +15 / -20 |
| wrapper/claude-code | 604 / 266236 | 597 / 271988 | -7 / +5752 |
| wrapper/codex | 606 / 269152 | 639 / 272588 | +33 / +3436 |
| wrapper/antigravity | 607 / 268888 | 605 / 268348 | -2 / -540 |
| wrapper/grok | 602 / 265932 | 607 / 269684 | +5 / +3752 |
| dashboard | 925 / 335744 | 918 / 339756 | -7 / +4012 |

This is a focused two-file lifecycle comparison, not a full-suite speed estimate. The exact-SHA CI workflow remains the full-suite evidence.

## Scope limits

The documented residual boundary is in [test isolation](../../contributing/test-isolation.md#residual-risks). Alternate configs, Vite plugin config hooks, computed config code, spreads and later keys, inline projects without `extends: true`, and auto-discovered workspace/project files can affect default behavior. The guard does not detect `isolate` or `pool` changes through those mechanisms. The retained `vitestWiring` ownership check still rejects Vitest scripts/configs outside declared package directories.
