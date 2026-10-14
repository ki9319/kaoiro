---
title: Grok Build ACP engine
description: Resident ACP host, tools, permissions and unsupported operations.
status: accepted
last_updated: 2026-10-14
---

# Grok Build ACP engine

The `grok` engine requires Grok Build on `PATH`. The wrapper launches
`grok --no-auto-update agent --no-leader stdio` once, initializes one ACP session and
uses `session/prompt` for each queued turn. It does not launch `grok -p`
per turn. The ACP SDK is pinned to 1.8.0.

`--no-leader` overrides `cli.use_leader`: the wrapper must own the backend
whose sandbox environment it sets and whose process group it terminates.
Connecting to a shared leader would break those ownership assumptions.

The server-composed persona and common footer are sent in `session/new`
`_meta.rules`. The kaoiro stdio MCP bridge is passed as `mcpServers` and
forwards calls to wrapper-owned ToolHost handlers. Grok discovers tools
through its `search_tool` and `use_tool` interfaces.

## Capabilities

Work unit 1 supports text turns, conversation continuity while the wrapper
is resident, cancellation, operator permission requests, user questions,
normal peer messages and dispatch confirmation. Early and yield delivery
are explicitly `none`. Reply-basis v1 is not negotiated: Grok MCP calls do
not carry turn-origin identity, so the bridge cannot prove it.

The launch catalog contains only `default` (account default). Model and
effort switching, attachments, cold resume, history replay, context usage
and quota reporting are unsupported. Unsupported controls reject explicitly.

## Permission projection

Approval decisions are made by grok from the Claude settings it loads;
kaoiro receives the requests grok sends. The launch-fixed approval axis is
projected as `on-request`, as with Claude Code auto mode. This is a declared
projection, not a promise that every call asks the operator.

On Linux the supported pairs are read-only with network off (`read-only`)
and workspace-write with network on (`workspace`). They report enforcement
`os`. Danger-full-access with network on (`off`) is accepted on every
platform; no OS enforcement is claimed for that profile. Other pairs reject.
OS sandbox pairs reject on non-Linux platforms. macOS is unmeasured; extend
support only after measurement in work unit 2 or later.

Grok's profiles grant temporary directories and Grok state storage writes;
read-only launch rejects a cwd under `/tmp`, `/var/tmp` or the Grok home,
including aliases. The sandbox axis does not promise every system directory
is immutable. See the [dated evidence](../../evidence/grok/2026-10-14-premises.md).

`ext.permission_policy` carries only spawn observations and the selected
profile. A successful inspect carries source names, managed-settings state,
loaded/skipped rule counts and Grok's Claude hooks compatibility cell. Failed,
timed-out or unfamiliar inspect output carries `inspect: unavailable` without
inventing empty sources, zero rules or disabled hooks. This metadata is
operator-only and does not participate in permission decisions.

The wrapper strips inherited `GROK_CLAUDE_*_ENABLED` variables and does not
change HOME or Grok config files. The user's Grok configuration owns Claude
compatibility, including hooks. Hooks can block tools or turn completion;
individual hook verification belongs to the settings repository.

## Upstream gaps and limits

- Claude permission import has no compat switch. Command-text deny matching
  does not cover paths or commands constructed at runtime.
- Generic ACP clients cannot declare permission-prompt capability. Grok's
  classifier can return a denial without asking the client. Escalation
  thresholds seen in older source are not verified against this CLI version.
- ACP does not provide a per-session permission mode override.
- Rules supplied on session/load did not replace the original session rules.
- Rate and quota data are not exposed in ACP output.

These are reference notes; no upstream report is part of this work.

## Cancellation and background tasks

On Grok Build 1.0.52, `session/cancel` ends the turn with `cancelled` and
returns the wrapper to `waiting_input`. A foreground shell tool with actual
`block_until_ms: 120000` disappeared after cancel in all six controlled
trials, with and without `--no-leader`. Native acceptance verifies the actual
arguments and asserts foreground-child termination.

A tool moved to the background (`_x.ai/task_backgrounded`) can remain alive
after cancel. Close and wrapper SIGTERM remove active tool children.
The wrapper preserves the resident session and does not discover or kill
tool PGIDs. Background survival is recorded as a vendor behavior; tests do
not assert it because the model chooses whether to background a task.
Per-task cancellation through `_x.ai/task/kill` is tracked in
[issue #594](https://github.com/sakuraiyuta/kaoiro/issues/594).
See the [dated evidence](../../evidence/grok/2026-10-14-premises.md).

## Diagnostics and shutdown

ACP diagnostic records contain bounded method, variant and identifier
metadata, never prompt or tool-result content. SDK diagnostics that include
raw messages are filtered. Unknown variants are counted without emitting
their bodies. Lines above the 4 MiB diagnostic-reader limit pass through
without parsing; only their count is recorded. The SDK owns the protocol
message limit. Normal protocol logs/results still carry display content.

Unexpected ACP closure fails the host and closes its owned child, allowing
the runner to recover the peer. Close aborts ToolHost handlers, closes ACP and stdin, sends SIGTERM to the
owned process group and escalates after 3000 ms, below the runner's 5000 ms
reset grace. Process-signal tests run in an isolated namespace.
