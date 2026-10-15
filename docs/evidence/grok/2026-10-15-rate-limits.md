---
title: Grok weekly account rate-limit measurement
date: 2026-10-15
---

# Grok weekly account rate-limit measurement

Measurement for [issue #660](https://github.com/sakuraiyuta/kaoiro/issues/660)
against Grok Build 1.0.52 (`grok 1.0.52 (0920c8169e27) [stable]`) and ACP SDK
1.8.0. The adapter implementation is pinned at commit
`f531d25e87c2071568bbe9c6032e22ee4d4eec2a`.

The native acceptance test ran the production `runGrokCli` composition with
the real Grok executable and Grok's real MCP client. The server-link test
double supplied persona setup and a synthetic peer directory. An idle session
made one `_x.ai/billing` request; the response passed the weekly-shape
validation, and the resulting `seven_day` snapshot had a finite utilization
between 0 and 1 and an integer Unix-second reset. The same snapshot appeared
in the state envelope and the host's `whoami` snapshot. A deterministic CLI
fixture test verified that the `whoami` tool result carries that same window.
Separate native model turns invoked `whoami` and `list_agents`; the latter
reached the synthetic directory provider once.

Only response shape and type/range checks were retained. No native prompt,
model output, token value, or billing response value was recorded. The peer
row was synthetic test data, so this run measures the Grok adapter's directory
tool path, not a deployed kaoiro server.

The test command and result were:

```text
KAOIRO_LIVE_GROK_RATE_LIMITS=1 env -u CODEX_HOME python3 ../../scripts/run-grok-test-namespace.py -- ./node_modules/.bin/vitest run test/native-rate-limits.test.ts --testTimeout=120000
1 test passed, exit 0, 37.80 s
```

The first native attempt used Vitest's default 15-second test timeout and
expired while a model turn was still running. The next test version expected
the model's final text to echo the tool result; that assertion was replaced
with tool-call and directory-call counters so no model output is inspected.
The bounded rerun above passed.

The deterministic CLI projection test also passed:

```text
env -u CODEX_HOME python3 ../../scripts/run-grok-test-namespace.py -- ./node_modules/.bin/vitest run test/cli_rate_limits.test.ts
1 test passed, exit 0, 7.37 s
```

The package checks on the implementation commit were:

```text
env -u CODEX_HOME pnpm test
30 test files passed, 10 skipped; 488 tests passed, 20 skipped; exit 0
env -u CODEX_HOME pnpm typecheck
exit 0
```

Eight one-at-a-time mutations each made the corresponding test fail (exit 1),
then the changed file was restored from the implementation commit:

| Mutation | Negative control |
|---|---|
| Removed idle-start rate-limit read | Startup snapshot test failed because `rate_limits.seven_day` was absent. |
| Removed the initial-prompt guard | Startup-order test found billing before `session/prompt`. |
| Removed percentage division by 100 | Three non-zero normalization cases failed. |
| Removed millisecond-to-second conversion | All four normalized timestamp cases failed. |
| Removed the post-read generation ownership check | Retired-generation test observed the old reading overwrite its successor. |
| Removed the outstanding-request slot guard | Coalescing test observed two physical requests. |
| Removed the whoami projection | CLI whoami snapshot test failed because the weekly window was absent. |
| Returned the upstream billing config in addition to the allowlist | All four parser allowlist cases failed on extra billing fields. |

Re-measure the native response and percentage meaning when Grok or the ACP SDK
is upgraded; the fixture tests pin adapter behavior but cannot detect a vendor
unit change.
