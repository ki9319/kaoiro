---
title: Grok permission requests forced by a test plugin hook
date: 2026-10-15
---

# Grok permission requests forced by a test plugin hook

Linux measurements with Grok Build 1.0.52 over stdio ACP for
[issue #615](https://github.com/sakuraiyuta/kaoiro/issues/615), on a host
whose Claude settings auto-approve tool calls. They describe observed
premises, not guarantees for later engine versions. Only tool names, key
paths, option kinds, stop reasons and the presence of a marker string were
recorded; prompts, output and installation details are omitted. The scratch
cwd, its session and its memory workspace were deleted.

The probe started `grok agent --plugin-dir <dir> --no-leader stdio` with a
plugin whose `hooks/hooks.json` runs one `PreToolUse` command hook, and
answered `session/request_permission` itself.

| Observation | Result |
|---|---|
| Hook answers `ask` for a terminal command and for a stdio MCP tool call | Grok sends `session/request_permission` for both, with `_meta.hookAsk` (`hookName`, `reason`) |
| Client answers `allow_once` | The turn ends `end_turn` |
| Client answers `reject_once` | The turn ends `cancelled`, `cancellationCategory: PermissionRejected` |
| Same calls without the plugin | The terminal command runs with no request (the host's auto mode); the MCP call produces one request |
| Terminal request `rawInput` keys | `variant`, `command`, `description`, `is_background`; the marker was in `command` |
| MCP request `rawInput` keys | `variant`, `tool_name`, `tool_input`; with the hook, one call produced two requests, `tool_name` `list_agents` then `kaoiro__list_agents` |
| Request titles | Not safe identifiers; not used to decide |
| Hook answers `deny` for every call except the marker command | The model saw the denials, tried other commands and `grep`, then ran the marker command, which was asked and allowed; the turn ended `end_turn` |
| Plugin hook environment | `$GROK_PLUGIN_ROOT` is set and expanded in the hook command; the hook inherits the agent process environment |

The live tests use this through `wrapper/grok/test/fixtures/grok-live.mjs`
and the `live-permission` plugin. Grok's plugin documentation states that a
`--plugin-dir` plugin is trusted for that process only, so nothing is
written to the user's Grok or Claude configuration.
