---
title: Grok session_start hook on session/new and session/load
date: 2026-10-15
---

# Grok session_start hook on session/new and session/load

Linux measurements with Grok Build 1.0.52 over stdio ACP for
[issue #633](https://github.com/sakuraiyuta/kaoiro/issues/633). They describe
observed premises, not guarantees for later engine versions. Only method
names, key paths and short identifier values were recorded; prompts, hook
output and installation details are omitted. The scratch session was deleted.

Procedure, run twice: `initialize`, `session/new` under the `workspace`
sandbox and one model turn; then a fresh process with `session/load` of that
session under `workspace`; then another fresh process with `session/load`
under `read-only` (the permission-switch case). No MCP server; Claude hooks
enabled by the existing configuration. Probe results held in all six lane
starts; results marked "native switch run" come from the wrapper's native
permission-switch test, which adds the HTTP MCP server and its readiness wait.

| Observation | Result |
|---|---|
| `_x.ai/session_notification` with `update.sessionUpdate: "hook_execution"` and `update.event_name: "session_start"` | Exactly one per `session/new` and per `session/load`, under both sandboxes |
| Its timing | 60 to 160 ms after the `session/new` or `session/load` response. With the wrapper's MCP readiness wait it can land before or after promotion: in a native switch run the load's `session_start` arrived after the first prompt was sent |
| History replay (`session/update` with `user_message_chunk`, `agent_message_chunk`) | Before the `session/load` response |
| Replay of Grok's own records (`_x.ai/session/update`) | Before the `session/load` response. In a native switch run it carried the previous turn's `hook_execution` records (`session_start`, `user_prompt_submit`, `pre_tool_use`, `stop`), so a replayed `session_start` is history, not a new hook run |
| `hook_run_started` before `session_start` | None (it does precede `user_prompt_submit` and `stop`) |
| Keys of the notification | `sessionId`, `_meta.eventId`, `_meta.agentTimestampMs`, `update.sessionUpdate`, `update.event_name`, `update.runs[].name`, `update.runs[].status.status`, `update.runs[].status.elapsed_ms`; the same for new and load. No source field |

Not measured: the `source` value the hook command receives on stdin. A
project-level probe hook in the untrusted scratch folder did not run, and
the folder's trust was not changed.

The native permission-switch test asserts one published `session_start` per
lane against the real engine (`KAOIRO_LIVE_GROK=1`); it failed while the
`_x.ai/session/update` replay was still held, which is how that replay was
found.
